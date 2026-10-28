const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/employee-salary.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, '../public/js/employee-detail.js'), 'utf8');

function createPage(overrides = {}) {
  const data = {
    employee: {
      id: 'employee-1', name: 'Employee', startDate: '2020-01-01',
      perDaySalary: 100, dailyPetta: 10, openingBalance: 100,
      ...overrides
    },
    leaves: [], payments: [], petta: [], salaryHistory: []
  };
  const elements = {
    settlementStart: { value: '2020-01-03', min: '2020-01-01' },
    settlementEnd: { value: '2020-01-05' },
    settlementBonus: { value: '0' },
    settlementForm: { checkValidity: () => true, reportValidity() {} },
    settlementPreview: { innerHTML: '', textContent: '' },
    settlementRemarks: { value: 'Final payment' },
    settlementAddAsExpense: { checked: true },
    settlementExpenseType: { value: 'general' },
    btnSaveSettlement: { disabled: false, innerHTML: '' },
    settlementModal: {}
  };
  const posts = [];
  const notifications = [];
  const modal = { hidden: false, hide() { this.hidden = true; } };
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: id => elements[id] },
    isSuperUser: () => true,
    canAccess: () => true,
    formatCurrency: amount => String(amount),
    formatDate: date => date,
    showNotification: (...args) => notifications.push(args),
    bootstrap: { Modal: { getInstance: () => modal } },
    api: async (method, endpoint, body) => {
      if (method === 'POST') {
        posts.push({ endpoint, body });
        data.payments.push(body);
        return body;
      }
      if (endpoint.startsWith('/employees/')) return data.employee;
      if (endpoint.startsWith('/leaves?')) return data.leaves;
      if (endpoint.startsWith('/payments?')) return data.payments;
      if (endpoint.startsWith('/petta?')) return data.petta;
      if (endpoint.startsWith('/salary-history?')) return data.salaryHistory;
      assert.fail('Unexpected request: ' + endpoint);
    }
  });
  vm.runInContext(source, context);
  context.testData = data;
  vm.runInContext(`
    empId = testData.employee.id;
    empData = testData.employee;
    empLeaves = testData.leaves;
    empPayments = testData.payments;
    empPettaHistory = testData.petta;
    empSalaryHistory = testData.salaryHistory;
    loadAll = async () => {};
  `, context);
  return { context, data, elements, posts, notifications, modal };
}

test('settlement includes opening balance, both date boundaries, petta and existing payments', () => {
  const { context, data } = createPage();
  data.payments.push({ paymentDate: '2020-01-04', amount: 40 });
  const settlement = context.salarySettlement('2020-01-03', '2020-01-05');
  assert.equal(settlement.opening, 280);
  assert.equal(settlement.earned, 270);
  assert.equal(settlement.paid, 40);
  assert.equal(settlement.balance, 510);
  assert.equal(settlement.workedDays, '3.0');
});

test('settlement respects full leave, half-day leave and historical salary and petta changes', () => {
  const { context, data } = createPage({ openingBalance: 0 });
  data.leaves.push(
    { startDateTime: '2020-01-01T00:00', endDateTime: '2020-01-01T12:00' },
    { startDateTime: '2020-01-02T00:00', endDateTime: '2020-01-04T00:00' }
  );
  data.salaryHistory.push({ effectiveDate: '2020-01-04', amount: 200 });
  data.petta.push({ effectiveDate: '2020-01-05', amount: 20 });
  const settlement = context.salarySettlement('2020-01-01', '2020-01-05');
  assert.equal(settlement.workedDays, '2.5');
  assert.equal(settlement.earned, 45 + 190 + 180);
  assert.equal(settlement.balance, 415);
});

test('settlement validates required dates, order, employment start and future dates', () => {
  const { context } = createPage();
  for (const [start, end] of [
    ['', '2020-01-05'], ['2020-01-01', ''],
    ['2020-02-30', '2020-03-01'], ['2020-01-05', '2020-01-03'],
    ['2019-12-31', '2020-01-05'], ['2020-01-01', '2999-01-01']
  ]) {
    assert.throws(() => context.salarySettlement(start, end));
  }
});

test('settlement is restricted to regular employees with full payment history access', () => {
  for (const employee of [{ temporaryEmployee: true }, { dailySalaryEnabled: true }]) {
    const { context } = createPage(employee);
    assert.equal(context.canSettleSalary(), false);
  }
  const { context } = createPage();
  context.isSuperUser = () => false;
  assert.equal(context.canSettleSalary(), false);
  assert.throws(() => context.salarySettlement('2020-01-01', '2020-01-05'));
  context.isSuperUser = () => true;
  context.canAccess = () => false;
  assert.equal(context.canSettleSalary(), false);
});

test('settlement records a payment on closing date and cannot pay the same balance twice', async () => {
  const { context, posts, modal, elements } = createPage();
  await context.saveSalarySettlement();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].endpoint, '/payments');
  assert.equal(posts[0].body.paymentDate, '2020-01-05');
  assert.equal(posts[0].body.amount, 550);
  assert.equal(posts[0].body.addAsExpense, true);
  assert.equal(posts[0].body.expenseTypeId, 'general');
  assert.match(posts[0].body.remarks, /2020-01-03 to 2020-01-05.*Final payment/);
  assert.equal(modal.hidden, true);
  assert.throws(() => context.salarySettlement('2020-01-03', '2020-01-05'), /last settlement/);
  assert.equal(elements.btnSaveSettlement.disabled, true);
  await context.saveSalarySettlement();
  assert.equal(posts.length, 1);
});

test('settlement does not submit a payment for an advance or a zero balance', async () => {
  for (const openingBalance of [-1000, -450]) {
    const { context, posts, elements } = createPage({ openingBalance });
    context.updateSettlementPreview();
    assert.equal(elements.btnSaveSettlement.disabled, true);
    await context.saveSalarySettlement();
    assert.equal(posts.length, 0);
  }
});

test('settlement requires another review when refreshed salary data changes', async () => {
  const { context, data, posts, notifications, elements } = createPage();
  data.employee = { ...data.employee, perDaySalary: 200 };
  await context.saveSalarySettlement();
  assert.equal(posts.length, 0);
  assert.match(notifications[0][0], /Salary data changed/);
  assert.equal(elements.btnSaveSettlement.disabled, false);
  await context.saveSalarySettlement();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.amount, 1050);
});

test('failed settlement leaves the dialog open and restores the save button', async () => {
  const { context, modal, posts, elements, notifications } = createPage();
  context.api = async () => { throw new Error('Connection unavailable'); };
  await context.saveSalarySettlement();
  assert.equal(posts.length, 0);
  assert.equal(modal.hidden, false);
  assert.equal(elements.btnSaveSettlement.disabled, false);
  assert.match(notifications[0][0], /Settlement failed/);
});

test('completed settlements open a new current period and preserve all payment history', () => {
  const { context, data } = createPage();
  data.payments.push(
    { id: 'old', paymentDate: '2020-01-02', amount: 50 },
    { id: 'settled', paymentDate: '2020-01-05', amount: 500, settlementStart: '2020-01-03', settlementEnd: '2020-01-05' },
    { id: 'new', paymentDate: '2020-01-07', amount: 30 }
  );
  const view = context.employeePeriodView();
  assert.equal(view.history, false);
  assert.equal(context.dateKey(view.start), '2020-01-06');
  assert.equal(context.recordInPeriod(data.payments[0], 'paymentDate', view), false);
  assert.equal(context.recordInPeriod(data.payments[1], 'paymentDate', view), false);
  assert.equal(context.recordInPeriod(data.payments[2], 'paymentDate', view), true);
  assert.equal(data.payments.length, 3);
  assert.equal(context.calcSalary(view.start, context.parseDateOnly('2020-01-07')).earnedSalary, 180);
});

test('history can show every earlier record or a selected settled period', () => {
  const { context, data } = createPage();
  data.payments.push(
    { id: 'old', paymentDate: '2020-01-02', amount: 50 },
    { id: 'settled', paymentDate: '2020-01-05', amount: 500, settlementStart: '2020-01-03', settlementEnd: '2020-01-05' }
  );
  vm.runInContext("historySettlementId = 'all';", context);
  let view = context.employeePeriodView();
  assert.equal(view.history, true);
  assert.equal(context.dateKey(view.start), '2020-01-01');
  assert.equal(context.dateKey(view.end), '2020-01-05');
  assert.equal(context.recordInPeriod(data.payments[0], 'paymentDate', view), true);
  vm.runInContext("historySettlementId = 'settled';", context);
  view = context.employeePeriodView();
  assert.equal(context.dateKey(view.start), '2020-01-03');
  assert.equal(context.recordInPeriod(data.payments[0], 'paymentDate', view), false);
  assert.equal(context.calcSalary(view.start, view.end).balance, 0);
});

test('earlier settlement remarks are recognized after reload and latest closure wins', () => {
  const { context, data } = createPage();
  data.payments.push(
    { id: 'later', paymentDate: '2020-01-10', amount: 450, settlementStart: '2020-01-06', settlementEnd: '2020-01-10' },
    { id: 'legacy', paymentDate: '2020-01-05', amount: 550, remarks: 'Salary settlement: 2020-01-03 to 2020-01-05 (includes opening pending/advance)' }
  );
  assert.equal(context.employeeSettlements().length, 2);
  assert.equal(context.dateKey(context.employeePeriodView().start), '2020-01-11');
  data.payments.splice(0, 1);
  assert.equal(context.dateKey(context.employeePeriodView().start), '2020-01-06');
});

test('employee screen toggles between current records and selectable settlement history', () => {
  const { context, data } = createPage();
  const nodes = {};
  context.document.getElementById = id => nodes[id] || (nodes[id] = {
    innerHTML: '', listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; }
  });
  data.payments.push(
    { id: 'old', paymentDate: '2020-01-02', amount: 50, remarks: 'Archived payment record' },
    { id: 'settled', paymentDate: '2020-01-05', amount: 500, settlementStart: '2020-01-03', settlementEnd: '2020-01-05' },
    { id: 'new', paymentDate: '2020-01-07', amount: 30, remarks: 'Current payment record' }
  );
  context.render();
  assert.match(nodes.detailContent.innerHTML, /View history/);
  assert.match(nodes.detailContent.innerHTML, /Current payment record/);
  assert.doesNotMatch(nodes.detailContent.innerHTML, /Archived payment record/);
  nodes.btnToggleEmployeeHistory.listeners.click();
  assert.match(nodes.detailContent.innerHTML, /All settled history/);
  assert.match(nodes.detailContent.innerHTML, /Archived payment record/);
  assert.doesNotMatch(nodes.detailContent.innerHTML, /Current payment record/);
  nodes.employeeHistoryPeriod.listeners.change({ target: { value: 'settled' } });
  assert.match(nodes.detailContent.innerHTML, /Settled Period History/);
  assert.doesNotMatch(nodes.detailContent.innerHTML, /Archived payment record/);
  nodes.btnToggleEmployeeHistory.listeners.click();
  assert.match(nodes.detailContent.innerHTML, /Current payment record/);
});

test('optional bonus increases settlement payment and persists in balanced history', async () => {
  const { context, elements, posts } = createPage();
  elements.settlementBonus.value = '250.50';
  context.updateSettlementPreview();
  assert.match(elements.settlementPreview.innerHTML, /Settlement bonus/);
  assert.match(elements.settlementPreview.innerHTML, /800.5/);
  await context.saveSalarySettlement();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.bonusAmount, 250.5);
  assert.equal(posts[0].body.amount, 800.5);
  const history = context.calcSalary(context.parseDateOnly('2020-01-03'), context.parseDateOnly('2020-01-05'));
  assert.equal(history.earnedSalary, 520.5);
  assert.equal(history.totalBonus, 250.5);
  assert.equal(history.balance, 0);
  const current = context.calcSalary(context.parseDateOnly('2020-01-06'), context.parseDateOnly('2020-01-06'));
  assert.equal(current.periods[0].opening, 0);
  assert.equal(current.balance, 90);
  assert.match(context.renderPaymentsRows([posts[0].body]), /Bonus awarded: 250.5/);
});

test('bonus rejects negative, nonfinite and sub-cent values', () => {
  const { context } = createPage();
  for (const bonus of [-1, NaN, Infinity, 1.001]) {
    assert.throws(() => context.salarySettlement('2020-01-03', '2020-01-05', bonus), /Bonus/);
  }
  assert.equal(context.salarySettlement('2020-01-03', '2020-01-05', 0).balance, 550);
});

test('bonus can be awarded when salary was already paid', async () => {
  const { context, data, elements, posts } = createPage();
  data.payments.push({ paymentDate: '2020-01-04', amount: 550 });
  elements.settlementBonus.value = '100';
  await context.saveSalarySettlement();
  assert.equal(posts[0].body.amount, 100);
  assert.equal(posts[0].body.bonusAmount, 100);
});

test('salary overview and daily summary count bonus as earnings without a false advance', () => {
  const { context, data } = createPage({ openingBalance: 0 });
  const payment = { employeeId: 'employee-1', paymentDate: '2020-01-01', amount: 140, bonusAmount: 50 };
  const document = { addEventListener() {} };
  const overview = vm.createContext({ document });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/salaries.js'), 'utf8'), overview);
  overview.getFiscalRange = () => ({ start: overview.parseDateOnly('2020-01-01'), end: overview.parseDateOnly('2020-01-01') });
  const result = overview.calcEmployeeSalary(data.employee, [], [payment], [], []);
  assert.equal(result.earned, 140);
  assert.equal(result.balance, 0);
  overview.getFiscalRange = () => ({ start: overview.parseDateOnly('2020-01-02'), end: overview.parseDateOnly('2020-01-02') });
  assert.equal(overview.calcEmployeeSalary(data.employee, [], [payment], [], []).balance, 90);
  const directory = vm.createContext({ document });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/employees.js'), 'utf8'), directory);
  directory.payments = [payment];
  vm.runInContext('daySalaryData = { payments, petta: [], salaryHistory: [] };', directory);
  const daily = directory.daySalaryRow(data.employee, '2020-01-01');
  assert.equal(daily.bonusAmount, 50);
  assert.equal(daily.pending, 0);
  assert.equal(directory.salaryRangeRow(data.employee, ['2020-01-01']).earned, 150);
});