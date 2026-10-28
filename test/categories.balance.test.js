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

test('handpick quantity setting can be enabled, read and disabled without changing balances', async () => {
  server.loginAs(owner);
  let updated = await server.request('PUT', `/api/categories/${id}`, { handpickQuantities: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.handpickQuantities, true);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_CATEGORIES)[0][9], 'TRUE');
  await server.request('PUT', `/api/categories/${id}/opening-balance`, { openingBalance: 500 });
  const read = await server.request('GET', '/api/categories');
  assert.equal(read.body.data[0].handpickQuantities, true);
  updated = await server.request('PUT', `/api/categories/${id}`, { handpickQuantities: false });
  assert.equal(updated.body.data.handpickQuantities, false);
  assert.equal(updated.body.data.openingBalance, 500);
});

test('category quantity defaults persist and remain optional', async () => {
  server.loginAs(owner);
  const result = await server.request('PUT', `/api/categories/${id}/quantities`, { quantities: [
    { name: 'Milk', unit: 'Litre', defaultQuantity: '5.25' },
    { name: 'Spices', unit: 'Grams' },
    { name: 'Pieces', unit: 'Count', defaultQuantity: 0 }
  ] });
  assert.equal(result.status, 200);
  const read = await server.request('GET', `/api/categories/${id}/quantities`);
  assert.deepEqual(read.body.data.map(quantity => quantity.defaultQuantity), [5.25, '', 0]);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITY_CATEGORIES)[0][7], 5.25);
});

test('invalid category quantity defaults do not replace saved definitions', async () => {
  server.loginAs(owner);
  sheets.setRows(SHEETS.EXPENSE_QUANTITY_CATEGORIES, [['q1', id, 'Milk', 'Litre', 1, 'Active', '', 5]]);
  for (const defaultQuantity of [-1, 'abc', 'Infinity', 1.001]) {
    const result = await server.request('PUT', `/api/categories/${id}/quantities`, { quantities: [{ name: 'Milk', unit: 'Litre', defaultQuantity }] });
    assert.equal(result.status, 400);
    assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITY_CATEGORIES)[0][7], 5);
  }
});