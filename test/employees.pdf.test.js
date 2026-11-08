const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const shared = fs.readFileSync(path.join(__dirname, '../public/js/employee-salary.js'), 'utf8');
function createPage(today = null) {
  const notifications = [], frames = [], requests = [];
  const elements = {};
  for (const id of ['btnExportEmployeeSalary', 'employeeSelectAll', 'employeeExportHint', 'empBody', 'empCount']) {
    elements[id] = { listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; } };
  }
  const employees = [
    { id: 'alice', name: 'Alice', status: 'Active', startDate: '2026-01-02', perDaySalary: 100, dailyPetta: 10, openingBalance: 200 },
    { id: 'bob', name: 'Bob', status: 'Active', startDate: '2026-01-01', perDaySalary: 200, dailyPetta: 20 },
    { id: 'inactive', name: 'Inactive Person', status: 'Inactive', startDate: '2026-01-01', perDaySalary: 100 }
  ];
  const data = {
    leaves: [], petta: [], salaryHistory: [],
    payments: [{ employeeId: 'alice', paymentDate: '2026-01-03', amount: 130, bonusAmount: 50 }],
    config: { fiscalYear: { start: '2026-01-01', end: '2026-01-03' } }
  };
  let allowed = true;
  const context = vm.createContext({
    document: {
      addEventListener() {}, getElementById: id => elements[id],
      body: { appendChild(frame) { frames.push(frame); } },
      createElement: () => ({ style: {}, setAttribute() {}, remove() { this.removed = true; },
        contentWindow: { addEventListener() {}, focus() {}, print() { this.printed = true; } } })
    },
    canAccess: () => allowed, isSuperUser: () => true,
    statusBadge: value => value, emptyRow: () => '',
    formatCurrency: value => `INR ${Number(value || 0).toFixed(2)}`,
    formatDate: value => value || '—',
    showNotification: message => notifications.push(message), setTimeout: fn => fn(),
    api: async (method, endpoint) => {
      requests.push(endpoint);
      if (endpoint.startsWith('/employees/')) return employees.find(employee => employee.id === endpoint.split('/').pop());
      return ({ '/leaves': data.leaves, '/payments': data.payments, '/petta': data.petta, '/salary-history': data.salaryHistory, '/config': data.config })[endpoint];
    }
  });
  if (today) {
    const RealDate = Date;
    context.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [`${today}T12:00:00`])); }
    };
  }
  vm.runInContext(shared + '\n' + fs.readFileSync(path.join(__dirname, '../public/js/employees.js'), 'utf8'), context);
  context.testEmployees = employees;
  vm.runInContext('allEmployees = testEmployees; visibleEmployeeIds = allEmployees.map(employee => employee.id);', context);
  return { context, employees, data, elements, notifications, frames, requests,
    select: ids => { context.testIds = ids; vm.runInContext('selectedEmployeeExportIds.clear(); testIds.forEach(id => selectedEmployeeExportIds.add(id));', context); },
    deny: () => { allowed = false; } };
}

test('directory PDF uses detail summary net earnings, opening balance, bonus and consolidated periods', () => {
  const { context, employees, data } = createPage('2026-01-03');
  const result = context.employeeDetailExportData(employees[0], data);
  assert.equal(result.salary.totalDays, '2.0');
  assert.equal(result.salary.earnedSalary, 230);
  assert.equal(result.salary.balance, 300);
  const html = context.employeeDetailPdfHtml([employees[0]], data);
  assert.match(html, /Alice/);
  assert.doesNotMatch(html, /Bob|Inactive Person/);
  assert.match(html, /Total Days/);
  assert.match(html, /Leave Days/);
  assert.match(html, /INR 230.00/);
  assert.match(html, /INR 300.00 Pending/);
  assert.match(html, /Consolidated Salary Periods/);
});

test('PDF includes payments after fiscal end in the current employee balance', () => {
  const { context, employees, data } = createPage('2026-01-05');
  data.payments.push({ employeeId: 'alice', paymentDate: '2026-01-05', amount: 180 });
  const result = context.employeeDetailExportData(employees[0], data);
  assert.equal(context.dayKeyOf(result.end), '2026-01-05');
  assert.equal(result.salary.totalPaid, 310);
  assert.equal(result.salary.balance, 300);
});

test('export and employee detail call the same salary calculator and period rules', () => {
  const { context, employees, data } = createPage();
  data.leaves.push({ employeeId: 'alice', startDateTime: '2026-01-02T00:00', endDateTime: '2026-01-02T12:00' });
  data.salaryHistory.push({ employeeId: 'alice', effectiveDate: '2026-01-03', amount: 150 });
  const detail = vm.createContext({ document: { addEventListener() {} }, isSuperUser: () => true });
  vm.runInContext(shared + '\n' + fs.readFileSync(path.join(__dirname, '../public/js/employee-detail.js'), 'utf8'), detail);
  detail.testEmployee = employees[0]; detail.testData = data;
  vm.runInContext(`empData = testEmployee; empLeaves = testData.leaves; empPayments = testData.payments;
    empPettaHistory = testData.petta; empSalaryHistory = testData.salaryHistory; fiscalYearConfig = testData.config;`, detail);
  const view = detail.employeePeriodView();
  assert.equal(JSON.stringify(context.employeeDetailExportData(employees[0], data).salary), JSON.stringify(detail.calcSalary(view.start, view.end)));
});

test('PDF follows latest settlement current period rather than old fiscal dates', () => {
  const { context, employees, data } = createPage();
  data.payments.push({ employeeId: 'alice', paymentDate: '2026-01-03', settlementStart: '2026-01-02', settlementEnd: '2026-01-03', amount: 300 });
  const result = context.employeeDetailExportData(employees[0], data);
  assert.equal(context.dayKeyOf(result.start), '2026-01-04');
  assert.equal(result.salary.periods[0].opening, 0);
  assert.match(context.employeeDetailPdfHtml([employees[0]], data), /Account settled through 2026-01-03/);
});

test('PDF recognizes zero-payment closure and preserves the advance opening balance', () => {
  const { context, employees, data } = createPage('2026-01-05');
  employees[0].openingBalance = -500;
  data.payments = [{ employeeId: 'alice', paymentDate: '2026-01-03', amount: 0, settlementStart: '2026-01-02', settlementEnd: '2026-01-03' }];
  const result = context.employeeDetailExportData(employees[0], data);
  assert.equal(context.dayKeyOf(result.start), '2026-01-04');
  assert.equal(result.salary.periods[0].opening, -320);
  assert.equal(result.salary.balance, -140);
  assert.equal(result.salary.totalPaid, 0);
});

test('PDF carries the same salary advance after an additional bonus payout', () => {
  const { context, employees, data } = createPage('2026-01-05');
  employees[0].openingBalance = -500;
  data.payments = [{ employeeId: 'alice', paymentDate: '2026-01-03', amount: 100, bonusAmount: 100, settlementStart: '2026-01-02', settlementEnd: '2026-01-03' }];
  const result = context.employeeDetailExportData(employees[0], data);
  assert.equal(result.salary.periods[0].opening, -320);
  assert.equal(result.salary.balance, -140);
});

test('PDF shows carried advance immediately after closing through today', () => {
  const { context, employees, data } = createPage('2026-01-03');
  employees[0].openingBalance = -500;
  data.payments = [{ employeeId: 'alice', paymentDate: '2026-01-03', amount: 100, bonusAmount: 100, settlementStart: '2026-01-02', settlementEnd: '2026-01-03' }];
  const result = context.employeeDetailExportData(employees[0], data);
  assert.equal(context.dayKeyOf(result.start), '2026-01-04');
  assert.equal(result.salary.totalDays, '0.0');
  assert.equal(result.salary.balance, -320);
  assert.match(context.employeeDetailPdfHtml([employees[0]], data), /INR 320.00 Advance/);
});

test('PDF carries pending salary into the latest period after a zero-payment closure today', () => {
  const { context, employees, data } = createPage('2026-01-03');
  data.payments = [{ employeeId: 'alice', paymentDate: '2026-01-03', amount: 0, settlementStart: '2026-01-02', settlementEnd: '2026-01-03' }];
  const result = context.employeeDetailExportData(employees[0], data);
  assert.equal(context.dayKeyOf(result.start), '2026-01-04');
  assert.equal(result.salary.balance, 380);
  assert.match(context.employeeDetailPdfHtml([employees[0]], data), /INR 380.00 Pending/);
});

test('PDF archives daily-pay and dynamic daily-pay records without duplicating work days or payments', () => {
  for (const flags of [{ dailySalaryEnabled: true }, { temporaryEmployee: true }]) {
    const { context, employees, data } = createPage('2026-01-03');
    Object.assign(employees[0], flags);
    data.payments = [
      { employeeId: 'alice', paymentDate: '2026-01-02', amount: 100 },
      { employeeId: 'alice', paymentDate: '2026-01-03', amount: 0, settlementStart: '2026-01-02', settlementEnd: '2026-01-03' }
    ];
    const result = context.employeeDetailExportData(employees[0], data);
    assert.equal(result.salary.balance, 0);
    assert.equal(result.salary.totalDays, '0.0');
    assert.equal(result.salary.totalPaid, 0);
    assert.equal(context.dayKeyOf(result.start), '2026-01-04');
  }
});

test('directory selection exports only checked employees and loads fresh detail data', async () => {
  const page = createPage();
  page.select(['alice', 'inactive']);
  await page.context.exportEmployeeSalaryPdf();
  assert.equal(page.frames.length, 1);
  assert.match(page.frames[0].srcdoc, /Alice/);
  assert.match(page.frames[0].srcdoc, /Inactive Person/);
  assert.doesNotMatch(page.frames[0].srcdoc, /Bob/);
  assert.ok(page.requests.includes('/employees/alice'));
  assert.ok(page.requests.includes('/config'));
  page.frames[0].onload();
  assert.equal(page.frames[0].contentWindow.printed, true);
  assert.equal(page.elements.btnExportEmployeeSalary.disabled, false);
});

test('no directory selection or salary access prevents export', async () => {
  const page = createPage();
  await page.context.exportEmployeeSalaryPdf();
  assert.equal(page.frames.length, 0);
  assert.match(page.notifications[0], /Select employees/);
  page.select(['alice']); page.deny();
  await page.context.exportEmployeeSalaryPdf();
  assert.equal(page.requests.length, 0);
});

test('filtering employees clears hidden selections and select all checks visible employees only', () => {
  const page = createPage();
  page.select(['alice', 'inactive']);
  page.context.renderTable([page.employees[0], page.employees[1]]);
  assert.equal(page.elements.btnExportEmployeeSalary.textContent, 'Export PDF (1)');
  assert.equal(page.elements.employeeSelectAll.indeterminate, true);
  page.context.setupEmployeeSalaryExport();
  page.elements.employeeSelectAll.listeners.change({ target: { checked: true } });
  assert.equal(page.elements.btnExportEmployeeSalary.textContent, 'Export PDF (2)');
  assert.equal(page.elements.employeeSelectAll.checked, true);
});

test('export escapes names and handles data-fetch and print failures', async () => {
  const page = createPage();
  page.employees[0].name = '<img src=x onerror=alert(1)>';
  const html = page.context.employeeDetailPdfHtml([page.employees[0]], page.data);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  page.select(['alice']);
  page.context.api = async () => { throw new Error('Offline'); };
  await page.context.exportEmployeeSalaryPdf();
  assert.equal(page.frames.length, 0);
  assert.match(page.notifications[0], /Unable to prepare PDF/);
  assert.equal(page.elements.btnExportEmployeeSalary.disabled, false);
  page.context.printEmployeeSalaryPdf(html);
  page.frames[0].contentWindow.print = () => { throw new Error('Blocked'); };
  page.frames[0].onload();
  assert.equal(page.frames[0].removed, true);
});