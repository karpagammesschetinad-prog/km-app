const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createSummary(employeeOverrides = {}) {
  const context = vm.createContext({ document: { addEventListener() {} } });
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