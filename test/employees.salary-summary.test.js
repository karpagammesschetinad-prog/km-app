const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createSummary(employeeOverrides = {}) {
  const context = vm.createContext({ document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/employee-salary.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/employees.js'), 'utf8'), context);
  vm.runInContext('daySalaryData = { payments: [], petta: [], salaryHistory: [] };', context);
  const employee = {
    id: 'employee-1', name: 'Employee', startDate: '2026-01-03',
    perDaySalary: 100, dailyPetta: 10, ...employeeOverrides
  };
  return { context, employee };
}

test('salary summary counts only days on or after employee joining date', () => {
  const { context, employee } = createSummary();
  const row = context.salaryRangeRow(employee, context.dateRange('2026-01-01', '2026-01-05'));
  assert.equal(row.workingDays, 3);
  assert.equal(row.earned, 300);
  assert.equal(row.petta, 30);
  assert.equal(row.pending, 270);
});

test('salary summary honors filter start when it is later than joining date', () => {
  const { context, employee } = createSummary();
  const row = context.salaryRangeRow(employee, context.dateRange('2026-01-04', '2026-01-05'));
  assert.equal(row.workingDays, 2);
  assert.equal(row.earned, 200);
  assert.equal(row.pending, 180);
});

test('range before joining has no working days or salary', () => {
  const { context, employee } = createSummary();
  const row = context.salaryRangeRow(employee, context.dateRange('2026-01-01', '2026-01-02'));
  assert.equal(row.working, false);
  assert.equal(row.workingDays, 0);
  assert.equal(row.earned, 0);
  assert.equal(row.pending, 0);
});

test('daily salary starts on joining date, including that date', () => {
  const { context, employee } = createSummary({ dailySalaryEnabled: true });
  const row = context.salaryRangeRow(employee, context.dateRange('2026-01-01', '2026-01-03'));
  assert.equal(row.workingDays, 1);
  assert.equal(row.earned, 100);
  assert.equal(row.received, 90);
  assert.equal(row.pending, 0);
});

test('payments and bonuses before joining do not enter salary summary totals', () => {
  for (const temporaryEmployee of [false, true]) {
    const { context, employee } = createSummary({ temporaryEmployee });
    vm.runInContext(`daySalaryData.payments = [
      { employeeId: 'employee-1', paymentDate: '2026-01-01', amount: 500, bonusAmount: 50 },
      { employeeId: 'employee-1', paymentDate: '2026-01-03', amount: 90 }
    ];`, context);
    const row = context.salaryRangeRow(employee, context.dateRange('2026-01-01', '2026-01-03'));
    assert.equal(row.workingDays, 1);
    assert.equal(row.received, 90);
    assert.equal(row.pending, 0);
    assert.equal(row.earned, temporaryEmployee ? 90 : 100);
  }
});

test('salary summary includes inactive employees with payments in range as payment-only rows', () => {
  const { context, employee } = createSummary({ status: 'Inactive' });
  context.testEmployees = [employee];
  context.testSalaryData = {
    payments: [{ employeeId: employee.id, paymentDate: '2026-01-03', amount: 2500 }],
    petta: [], salaryHistory: []
  };
  vm.runInContext('allEmployees = testEmployees; daySalaryData = testSalaryData;', context);
  const result = context.salarySummaryData('2026-01-03', '2026-01-03', new Set());
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].type, 'Inactive · payment only');
  assert.equal(result.rows[0].received, 2500);
  assert.equal(result.rows[0].earned, 0);
  assert.equal(result.rows[0].pending, 0);
  assert.equal(result.totals.received, 2500);
});

test('salary summary excludes inactive employees without payments in the selected range', () => {
  const { context, employee } = createSummary({ status: 'Inactive' });
  context.testEmployees = [employee];
  context.testSalaryData = {
    payments: [{ employeeId: employee.id, paymentDate: '2026-01-02', amount: 2500 }],
    petta: [], salaryHistory: []
  };
  vm.runInContext('allEmployees = testEmployees; daySalaryData = testSalaryData;', context);
  const result = context.salarySummaryData('2026-01-03', '2026-01-03', new Set());
  assert.equal(result.rows.length, 0);
  assert.equal(result.totals.received, 0);
});

test('salary summary keeps active employees with payments on a full-leave day', () => {
  const { context, employee } = createSummary();
  context.testEmployees = [employee];
  context.testSalaryData = {
    payments: [{ employeeId: employee.id, paymentDate: '2026-01-03', amount: 4000 }],
    petta: [], salaryHistory: []
  };
  context.testLeaves = [{ employeeId: employee.id, startDateTime: '2026-01-03T00:00', endDateTime: '2026-01-04T00:00' }];
  vm.runInContext('allEmployees = testEmployees; daySalaryData = testSalaryData; employeeLeaves = testLeaves;', context);
  const result = context.salarySummaryData('2026-01-03', '2026-01-03', new Set());
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].received, 4000);
  assert.equal(result.rows[0].workingDays, 0);
  assert.equal(result.totals.received, 4000);
});

test('consolidated pending includes opening balance, historical rates, bonuses and earlier payments', () => {
  const { context, employee } = createSummary({ status: 'Active', openingBalance: 500 });
  context.testEmployees = [employee];
  vm.runInContext(`
    allEmployees = testEmployees;
    daySalaryData.payments = [{ employeeId: 'employee-1', paymentDate: '2026-01-03', amount: 200, bonusAmount: 50 }];
    daySalaryData.salaryHistory = [{ employeeId: 'employee-1', effectiveDate: '2026-01-04', amount: 200 }];
  `, context);
  const result = context.consolidatedPendingSalaryData('2026-01-05');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].opening, 500);
  assert.equal(result.rows[0].earned, 520); // 90 + 190 + 190 + 50 bonus
  assert.equal(result.rows[0].received, 200);
  assert.equal(result.totals.pending, 820);
});

test('consolidation includes all active employees, excludes future joiners and inactive staff, and separates advances', () => {
  const { context, employee } = createSummary({ status: 'Active' });
  context.testEmployees = [
    employee,
    { ...employee, id: 'advance', name: 'Advance', openingBalance: -500 },
    { ...employee, id: 'inactive', status: 'Inactive' },
    { ...employee, id: 'future', startDate: '2026-02-01' },
    { ...employee, id: 'daily', dailySalaryEnabled: true },
    { ...employee, id: 'temporary', temporaryEmployee: true }
  ];
  vm.runInContext('allEmployees = testEmployees;', context);
  const result = context.consolidatedPendingSalaryData('2026-01-03');
  assert.equal(result.rows.length, 4);
  assert.equal(result.totals.pending, 90);
  assert.equal(result.totals.advance, 410);
  assert.equal(result.rows.find(row => row.id === 'daily').pending, 0);
  assert.equal(result.rows.find(row => row.id === 'temporary').pending, 0);
});

test('settlement and leave-day payments reduce consolidated dues without dropping the employee', () => {
  const { context, employee } = createSummary({ status: 'Active' });
  context.testEmployees = [employee];
  vm.runInContext(`
    allEmployees = testEmployees;
    daySalaryData.payments = [
      { employeeId: 'employee-1', paymentDate: '2026-01-03', amount: 90, settlementStart: '2026-01-03', settlementEnd: '2026-01-03' },
      { employeeId: 'employee-1', paymentDate: '2026-01-04', amount: 20 }
    ];
    employeeLeaves = [{ employeeId: 'employee-1', startDateTime: '2026-01-04T00:00', endDateTime: '2026-01-05T00:00' }];
  `, context);
  const result = context.consolidatedPendingSalaryData('2026-01-05');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].pending, 70);
  assert.equal(result.rows[0].received, 110);
});