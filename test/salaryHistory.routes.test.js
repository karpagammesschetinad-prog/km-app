const test = require('node:test');
const assert = require('node:assert/strict');

const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();

const { startTestServer } = require('./helpers/test-server');
const employeesRouter = require('../routes/employees');
const salaryHistoryRouter = require('../routes/salaryHistory');

const SUPERUSER = { id: 'user-super', username: 'admin', displayName: 'Admin', role: 'superuser' };

const EMPLOYEE = ['emp-1', 'Ravi', '', '', '2026-01-01', 500, 100, 'Active', 'false', 'false'];

const employees = startTestServer('/api/employees', employeesRouter);
const history = startTestServer('/api/salary-history', salaryHistoryRouter);

test.beforeEach(() => {
  sheets.reset();
  sheets.setRows(SHEETS.EMPLOYEES, [[...EMPLOYEE]]);
  sheets.setRows(SHEETS.SALARY_HISTORY, []);
  employees.loginAs(SUPERUSER);
  history.loginAs(SUPERUSER);
});

test.after(() => { employees.close(); history.close(); });

test('changing the per day salary keeps the old rate on the timeline', async () => {
  const res = await employees.request('PUT', '/api/employees/emp-1', {
    perDaySalary: 600, salaryEffectiveDate: '2026-03-01', salaryRevisionRemarks: 'Increment'
  });
  assert.equal(res.status, 200);

  const rows = sheets.getRows(SHEETS.SALARY_HISTORY);
  assert.equal(rows.length, 2, 'the previous rate is seeded before the new one');
  assert.deepEqual(rows.map(row => [row[3], Number(row[4])]), [['2026-01-01', 500], ['2026-03-01', 600]]);
});

test('a second revision only adds the new rate', async () => {
  await employees.request('PUT', '/api/employees/emp-1', { perDaySalary: 600, salaryEffectiveDate: '2026-03-01' });
  await employees.request('PUT', '/api/employees/emp-1', { perDaySalary: 550, salaryEffectiveDate: '2026-05-01' });

  const rows = sheets.getRows(SHEETS.SALARY_HISTORY);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[2].slice(3, 5).map(String), ['2026-05-01', '550']);
});

test('an unchanged salary records nothing', async () => {
  await employees.request('PUT', '/api/employees/emp-1', { perDaySalary: 500, phone: '99999' });
  assert.equal(sheets.getRows(SHEETS.SALARY_HISTORY).length, 0);
});

test('revisions can be listed per employee and deleted', async () => {
  await employees.request('PUT', '/api/employees/emp-1', { perDaySalary: 600, salaryEffectiveDate: '2026-03-01' });

  const listed = await history.request('GET', '/api/salary-history?employeeId=emp-1');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.map(record => record.effectiveDate), ['2026-03-01', '2026-01-01']);

  const removed = await history.request('DELETE', `/api/salary-history/${listed.body.data[0].id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(sheets.getRows(SHEETS.SALARY_HISTORY).map(row => row[3]), ['2026-01-01']);
  assert.equal(Number(sheets.getRows(SHEETS.EMPLOYEES)[0][5]), 500, 'the employee falls back to the earlier rate');
});

test('a revision requires the core fields and a non-negative amount', async () => {
  assert.equal((await history.request('POST', '/api/salary-history', { employeeId: 'emp-1' })).status, 400);
  assert.equal((await history.request('POST', '/api/salary-history', {
    employeeId: 'emp-1', employeeName: 'Ravi', effectiveDate: '2026-03-01', amount: -5
  })).status, 400);
});
