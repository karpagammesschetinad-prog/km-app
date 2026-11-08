const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();
const { holidayLeaveRecords } = require('../services/restaurantHolidays');
const { startTestServer } = require('./helpers/test-server');
const server = startTestServer('/api/leaves', require('../routes/leaves'));
const employee = { id: 'employee', name: 'Employee', startDate: '2026-01-01', perDaySalary: 100, dailyPetta: 10, openingBalance: -100, status: 'Active' };
const employeeRow = ['employee', 'Employee', '', '', '2026-01-01', 100, 10, 'Active', 'false', 'false'];
const holidays = [['festival', '2026-01-02', '2026-01-03', 'Festival', 'Admin', '']];
function page(...files) {
  const context = vm.createContext({ document: { addEventListener() {} } });
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
  return context;
}
test.beforeEach(() => { sheets.reset(); server.loginAs({ id: 'cashier', role: 'cashier' }); });
test.after(() => server.close());

test('payroll leave feed projects holidays for every employee without writing personal leaves', async () => {
  sheets.setRows(SHEETS.EMPLOYEES, [employeeRow, ['new', 'New', '', '', '2026-01-03', 100]]);
  sheets.setRows(SHEETS.RESTAURANT_HOLIDAYS, holidays);
  sheets.setRows(SHEETS.LEAVES, [['personal', 'employee', 'Employee', '2026-01-02T00:00', '2026-01-02T12:00']]);
  const response = await server.request('GET', '/api/leaves?employeeId=employee');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 2);
  assert.equal(response.body.data[1].isRestaurantHoliday, true);
  assert.equal(response.body.data[1].endDateTime, '2026-01-04T00:00');
  assert.equal(sheets.getRows(SHEETS.LEAVES).length, 1);
  assert.equal((await server.request('GET', '/api/leaves')).body.data.length, 3);
  assert.equal((await server.request('DELETE', '/api/leaves/' + response.body.data[1].id)).status, 404);
});

test('unpaid holidays remove salary and petta once, preserve payments and bonuses, and carry advances', () => {
  const context = page('employee-salary.js');
  const leaves = [...holidayLeaveRecords(holidays, [employeeRow]),
    { startDateTime: '2026-01-02T00:00', endDateTime: '2026-01-02T12:00' }];
  const payments = [{ paymentDate: '2026-01-03', amount: 50, bonusAmount: 50 }];
  const args = { employee, leaves, payments, start: new Date('2026-01-01T00:00'), end: new Date('2026-01-04T00:00') };
  const result = context.calculateEmployeeDetailSalary(args);
  assert.equal(result.workedDays, '2.0');
  assert.equal(result.leaveDays, '2.0');
  assert.equal(result.holidayDays, '2.0');
  assert.equal(result.earnedSalary, 230);
  assert.equal(result.totalPaid, 50);
  assert.equal(result.balance, 80);
  const later = context.calculateEmployeeDetailSalary({ ...args, start: new Date('2026-01-04T00:00') });
  assert.equal(later.periods[0].opening, -10);
  assert.equal(later.balance, 80);
  const future = context.calculateEmployeeDetailSalary({ ...args, leaves: holidayLeaveRecords([['future', '2026-01-05', '2026-01-06', 'Closure']], [employeeRow]), payments: [] });
  assert.equal(future.earnedSalary, 360);
});

test('overview and day summary use global closures for regular and daily-pay employees', () => {
  const leaves = holidayLeaveRecords(holidays, [employeeRow]);
  const overview = page('salaries.js');
  overview.getFiscalRange = () => ({ start: overview.parseDateOnly('2026-01-01'), end: overview.parseDateOnly('2026-01-04') });
  const result = overview.calcEmployeeSalary(employee, leaves, [], [], []);
  assert.equal(result.earned, 180);
  assert.equal(result.balance, 80);
  const directory = page('employees.js');
  directory.testLeaves = leaves;
  vm.runInContext('employeeLeaves = testLeaves; daySalaryData = { payments: [], petta: [], salaryHistory: [] };', directory);
  for (const dailySalaryEnabled of [false, true]) {
    const row = directory.daySalaryRow({ ...employee, dailySalaryEnabled }, '2026-01-02');
    assert.equal(row.worked, 0);
    assert.equal(row.received, 0);
    assert.equal(row.pending, 0);
  }
  assert.equal(directory.daySalaryRow({ ...employee, startDate: '2026-01-03' }, '2026-01-02').worked, 0);
});

test('employee holiday history is read-only and safely labels the closure', () => {
  const context = page('employee-salary.js', 'employee-detail.js');
  context.formatDateTime = value => value;
  const leaves = holidayLeaveRecords([['holiday', '2026-01-02', '2026-01-03', '<b>Festival</b>']], [employeeRow]);
  const html = context.renderLeaveRows(leaves);
  assert.match(html, /Restaurant holiday · Unpaid/);
  assert.match(html, /&lt;b&gt;Festival&lt;\/b&gt;/);
  assert.doesNotMatch(html, /deleteLeave|closeLeave/);
});

test('settlement and PDF use holiday-aware carry-forward and summary totals', () => {
  const context = page('employee-salary.js', 'employee-detail.js');
  context.testEmployee = employee;
  context.testLeaves = holidayLeaveRecords(holidays, [employeeRow]);
  context.isSuperUser = () => true;
  context.canAccess = () => true;
  vm.runInContext('empData = testEmployee; empLeaves = testLeaves;', context);
  const settlement = context.salarySettlement('2026-01-01', '2026-01-04', 50, 'pay');
  assert.equal(settlement.balance, 80);
  assert.equal(settlement.paymentDue, 130);
  const directory = page('employee-salary.js', 'employees.js');
  directory.isSuperUser = () => true;
  directory.formatCurrency = value => `INR ${value}`;
  directory.formatDate = value => value;
  const RealDate = Date;
  directory.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-01-04T12:00:00'])); }
  };
  const data = { leaves: context.testLeaves, payments: [], petta: [], salaryHistory: [], config: { fiscalYear: { start: '2026-01-01' } } };
  const result = directory.employeeDetailExportData(employee, data);
  assert.equal(result.salary.holidayDays, '2.0');
  assert.equal(result.salary.balance, 80);
  assert.match(directory.employeeDetailPdfHtml([employee], data), /Restaurant Holiday Days/);
});

test('dashboard excludes closures on exact dates and does not double-count overlapping personal leave', async () => {
  const context = page('dashboard.js');
  const nodes = {};
  context.document.getElementById = id => nodes[id] || (nodes[id] = { innerHTML: '', textContent: '' });
  context.testStats = null;
  context.renderEmployeeStatus = stats => { context.testStats = stats; };
  const leaves = [...holidayLeaveRecords(holidays, [employeeRow]), { employeeId: employee.id, startDateTime: '2026-01-02T00:00', endDateTime: '2026-01-02T12:00' }];
  const data = { '/employees': [employee], '/leaves': leaves, '/payments': [], '/salary-history': [], '/config': { fiscalYear: { start: '2026-01-01', end: '2026-01-04' } } };
  context.api = async (method, endpoint) => data[endpoint];
  await context.loadEmployeeStatusOnDemand();
  assert.ok(context.testStats);
  assert.equal(context.testStats[0].balance, 80);
});