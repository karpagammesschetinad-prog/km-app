const test = require('node:test');
const assert = require('node:assert/strict');
const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();
const { startTestServer } = require('./helpers/test-server');
const server = startTestServer('/api/categories', require('../routes/categories'));
const id = '11111111-1111-4111-8111-111111111111';
const owner = { id: 'owner', username: 'owner', role: 'superuser' };
const editor = { id: 'cashier', username: 'cashier', role: 'cashier', permissions: { expenses: { add: true } } };

test.beforeEach(() => {
  sheets.reset();
  sheets.setRows(SHEETS.EXPENSE_CATEGORY_TYPES, [['type-a', 'General', 1, 'Active', 'All', '']]);
  sheets.setRows(SHEETS.EXPENSE_CATEGORIES, [[id, 'Milk', 1, 'Active', 'type-a', '']]);
  server.loginAs(editor);
});
test.after(() => server.close());

test('expense editor can capture, view, replace and clear a previous balance', async () => {
  for (const openingBalance of [500.25, -100, 0]) {
    const saved = await server.request('PUT', `/api/categories/${id}/opening-balance`, { openingBalance });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.openingBalance, openingBalance);
    assert.equal(saved.body.data.balanceUpdatedBy, 'cashier');
    assert.ok(saved.body.data.balanceUpdatedAt);
    const read = await server.request('GET', '/api/categories');
    assert.equal(read.body.data[0].openingBalance, openingBalance);
    assert.equal(sheets.getRows(SHEETS.EXPENSE_CATEGORIES)[0][6], openingBalance);
  }
});

test('opening balance requires authentication and expense edit permission', async () => {
  server.logout();
  assert.equal((await server.request('PUT', `/api/categories/${id}/opening-balance`, { openingBalance: 1 })).status, 401);
  server.loginAs({ ...editor, permissions: {} });
  assert.equal((await server.request('PUT', `/api/categories/${id}/opening-balance`, { openingBalance: 1 })).status, 403);
  server.loginAs(owner);
  assert.equal((await server.request('PUT', `/api/categories/${id}/opening-balance`, { openingBalance: 1 })).status, 200);
});

test('opening balance respects restricted category type access', async () => {
  sheets.setRows(SHEETS.EXPENSE_CATEGORY_TYPES, [['type-a', 'General', 1, 'Active', 'Limited', 'owner']]);
  assert.equal((await server.request('PUT', `/api/categories/${id}/opening-balance`, { openingBalance: 100 })).status, 403);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_CATEGORIES)[0][6], undefined);
});

test('invalid opening amounts and unknown categories cannot change data', async () => {
  for (const openingBalance of ['100', null, 'abc', 1.001]) {
    assert.equal((await server.request('PUT', `/api/categories/${id}/opening-balance`, { openingBalance })).status, 400);
  }
  assert.equal((await server.request('PUT', '/api/categories/missing/opening-balance', { openingBalance: 1 })).status, 404);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_CATEGORIES)[0][6], undefined);
});

test('ordinary category edits preserve the opening balance and audit fields', async () => {
  await server.request('PUT', `/api/categories/${id}/opening-balance`, { openingBalance: 700 });
  server.loginAs(owner);
  const updated = await server.request('PUT', `/api/categories/${id}`, { name: 'Fresh Milk', openingBalance: 9999 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.openingBalance, 700);
  assert.equal(updated.body.data.balanceUpdatedBy, 'cashier');
});