const test = require('node:test');
const assert = require('node:assert/strict');

const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();

const { startTestServer } = require('./helpers/test-server');
const settingsRouter = require('../routes/settings');

const CASHIER = { id: 'user-cashier', username: 'cashier', role: 'cashier' };
const server = startTestServer('/api/settings', settingsRouter);

test.beforeEach(() => {
  sheets.reset();
  sheets.setRows(SHEETS.SETTINGS, []);
  server.loginAs(CASHIER);
});

test.after(() => server.close());

test('auto-save setting requires authentication', async () => {
  server.logout();
  assert.equal((await server.request('GET', '/api/settings/autosave')).status, 401);
  assert.equal((await server.request('PUT', '/api/settings/autosave', { AUTO_SAVE_ENABLED: false })).status, 401);
});

test('auto-save is enabled by default for existing settings sheets', async () => {
  const res = await server.request('GET', '/api/settings/autosave');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.AUTO_SAVE_ENABLED, 'true');
});

test('any authenticated user can disable and enable global auto-save', async () => {
  const disabled = await server.request('PUT', '/api/settings/autosave', { AUTO_SAVE_ENABLED: false });
  assert.equal(disabled.status, 200);
  assert.deepEqual(sheets.getRows(SHEETS.SETTINGS), [['AUTO_SAVE_ENABLED', 'false']]);

  const enabled = await server.request('PUT', '/api/settings/autosave', { AUTO_SAVE_ENABLED: true });
  assert.equal(enabled.status, 200);
  assert.deepEqual(sheets.getRows(SHEETS.SETTINGS), [['AUTO_SAVE_ENABLED', 'true']]);
});

test('auto-save setting only accepts booleans', async () => {
  const res = await server.request('PUT', '/api/settings/autosave', { AUTO_SAVE_ENABLED: 'false' });
  assert.equal(res.status, 400);
  assert.equal(sheets.getRows(SHEETS.SETTINGS).length, 0);
});

test('the full settings endpoint remains superuser-only', async () => {
  assert.equal((await server.request('GET', '/api/settings')).status, 403);
});
