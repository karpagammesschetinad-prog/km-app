const test = require('node:test');
const assert = require('node:assert/strict');

const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();

const { startTestServer } = require('./helpers/test-server');
const salariesRouter = require('../routes/salaries');

const CASHIER = { id: 'user-cashier', username: 'cashier', displayName: 'Cashier', role: 'cashier' };

const EMPLOYEES = [
  ['emp-1', 'Ravi', '', '', '2025-01-01', 15000, 50, 'Active', 'true', 'false'],
  ['emp-2', 'Kumar', '', '', '2025-01-01', 12000, 0, 'Active', 'false', 'false'],
  ['emp-3', 'Old Staff', '', '', '2024-01-01', 10000, 0, 'Inactive', 'false', 'false']
];

const server = startTestServer('/api/salaries', salariesRouter);

test.beforeEach(() => {
  sheets.reset();
  sheets.setRows(SHEETS.EMPLOYEES, EMPLOYEES);
  sheets.setRows(SHEETS.SALARIES, []);
  server.loginAs(CASHIER);
});

test.after(() => server.close());

test('rejects unauthenticated requests', async () => {
  server.logout();
  assert.equal((await server.request('GET', '/api/salaries')).status, 401);
  assert.equal((await server.request('POST', '/api/salaries/process', { month: 1, year: 2026 })).status, 401);
});

test('process requires month and year', async () => {
  const res = await server.request('POST', '/api/salaries/process', { month: 1 });
  assert.equal(res.status, 400);
});

test('process creates one record per active employee', async () => {
  const res = await server.request('POST', '/api/salaries/process', { month: 1, year: 2026 });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map(item => item.employeeId), ['emp-1', 'emp-2']);
  assert.equal(res.body.data[0].netSalary, 15000);
  assert.equal(sheets.getRows(SHEETS.SALARIES).length, 2);
});

test('process is idempotent for the same month', async () => {
  await server.request('POST', '/api/salaries/process', { month: 1, year: 2026 });
  const second = await server.request('POST', '/api/salaries/process', { month: 1, year: 2026 });

  assert.equal(second.body.data.length, 0);
  assert.equal(sheets.getRows(SHEETS.SALARIES).length, 2);

  const nextMonth = await server.request('POST', '/api/salaries/process', { month: 2, year: 2026 });
  assert.equal(nextMonth.body.data.length, 2);
  assert.equal(sheets.getRows(SHEETS.SALARIES).length, 4);
});

test('creating a record derives net salary from base, allowances and deductions', async () => {
  const res = await server.request('POST', '/api/salaries', {
    employeeId: 'emp-1', employeeName: 'Ravi', month: 3, year: 2026,
    baseSalary: 15000, allowances: 1200, deductions: 700
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.netSalary, 15500);
});

test('creating a record requires the core fields', async () => {
  const res = await server.request('POST', '/api/salaries', { employeeId: 'emp-1', month: 3 });
  assert.equal(res.status, 400);
});

test('updating a record recalculates net salary and keeps the id', async () => {
  const created = await server.request('POST', '/api/salaries', {
    employeeId: 'emp-1', employeeName: 'Ravi', month: 3, year: 2026, baseSalary: 15000
  });

  const res = await server.request('PUT', `/api/salaries/${created.body.data.id}`, {
    id: 'attempted-id-change', deductions: 500, status: 'Paid'
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.id, created.body.data.id);
  assert.equal(res.body.data.netSalary, 14500);
  assert.equal(sheets.getRows(SHEETS.SALARIES)[0][10], 'Paid');
});

test('unknown records return 404 on read, update and delete', async () => {
  assert.equal((await server.request('GET', '/api/salaries/missing')).status, 404);
  assert.equal((await server.request('PUT', '/api/salaries/missing', { baseSalary: 1 })).status, 404);
  assert.equal((await server.request('DELETE', '/api/salaries/missing')).status, 404);
});

test('deleting a record removes only that row', async () => {
  await server.request('POST', '/api/salaries/process', { month: 1, year: 2026 });
  const [first] = sheets.getRows(SHEETS.SALARIES);

  const res = await server.request('DELETE', `/api/salaries/${first[0]}`);
  assert.equal(res.status, 200);
  assert.deepEqual(sheets.getRows(SHEETS.SALARIES).map(row => row[1]), ['emp-2']);
});
