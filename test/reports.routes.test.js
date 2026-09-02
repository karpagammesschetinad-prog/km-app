const test = require('node:test');
const assert = require('node:assert/strict');

const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();

const { startTestServer } = require('./helpers/test-server');
const reportsRouter = require('../routes/reports');

const CASHIER = { id: 'user-cashier', username: 'cashier', role: 'cashier' };
const SUPERUSER = { id: 'user-super', username: 'admin', role: 'superuser' };

const CATEGORY_TYPES = [
  ['type-cash', 'General', 1, 'Active', 'All', '', 'General', 'Daily Cash'],
  ['type-market', 'Market', 2, 'Active', 'All', '', 'Market', 'Daily Non Cash'],
  ['type-occasional', 'Occasional', 3, 'Active', 'All', '', 'Occasional', 'Occasional']
];

function expenseRow(overrides = {}) {
  const o = {
    id: 'exp-1', date: '2026-02-02', category: 'Milk', description: '', amount: 100,
    employeeId: '', employeeName: '', submittedBy: 'cashier', approvalStatus: 'Pending',
    approvedBy: '', approvedAt: '', rejectionReason: '', createdAt: '2026-02-02T10:00:00.000Z',
    typeId: 'type-cash', onSpot: false, paymentId: '', shift: '', mode: 'Daily Cash',
    ...overrides
  };
  return [
    o.id, o.date, o.category, o.description, o.amount, o.employeeId, o.employeeName,
    o.submittedBy, o.approvalStatus, o.approvedBy, o.approvedAt, o.rejectionReason,
    o.createdAt, o.typeId, o.onSpot ? 'TRUE' : '', o.paymentId, o.shift, o.mode
  ];
}

function entryRow(overrides = {}) {
  const o = {
    id: 'entry-1', date: '2026-02-02', shift: 'Morning', paymentType: 'Cash', vendor: '',
    amount: 1000, enteredBy: 'cashier', createdAt: '2026-02-02T11:00:00.000Z', updatedAt: '2026-02-02T11:00:00.000Z',
    ...overrides
  };
  return [o.id, o.date, o.shift, o.paymentType, o.vendor, o.amount, o.enteredBy, o.createdAt, o.updatedAt];
}

function employeeRow(overrides = {}) {
  const o = {
    id: 'emp-1', name: 'Ravi', address: '', phone: '', start: '2026-01-01',
    perDay: 500, petta: 100, status: 'Active', dailyPay: 'false', temporary: 'false',
    ...overrides
  };
  return [o.id, o.name, o.address, o.phone, o.start, o.perDay, o.petta, o.status, o.dailyPay, o.temporary];
}

const server = startTestServer('/api/reports', reportsRouter);
const url = (from, to) => `/api/reports/profit-loss?from=${from}&to=${to}`;

test.beforeEach(() => {
  sheets.reset();
  sheets.setRows(SHEETS.EXPENSE_CATEGORY_TYPES, CATEGORY_TYPES);
  sheets.setRows(SHEETS.EXPENSES, []);
  sheets.setRows(SHEETS.SALES_ENTRIES, []);
  sheets.setRows(SHEETS.SALES, []);
  sheets.setRows(SHEETS.SALARY_PAYMENTS, []);
  sheets.setRows(SHEETS.EMPLOYEES, []);
  sheets.setRows(SHEETS.LEAVES, []);
  sheets.setRows(SHEETS.PETTA_HISTORY, []);
  sheets.setRows(SHEETS.SALARY_HISTORY, []);
  server.loginAs(SUPERUSER);
});

test.after(() => server.close());

test('the report is restricted to super users', async () => {
  server.logout();
  assert.equal((await server.request('GET', url('2026-02-01', '2026-02-03'))).status, 401);

  server.loginAs(CASHIER);
  assert.equal((await server.request('GET', url('2026-02-01', '2026-02-03'))).status, 403);
});

test('the date range is validated', async () => {
  assert.equal((await server.request('GET', '/api/reports/profit-loss?from=2026-02-01')).status, 400);
  assert.equal((await server.request('GET', url('2026-02-05', '2026-02-01'))).status, 400);
  assert.equal((await server.request('GET', url('2020-01-01', '2026-02-01'))).status, 400);
});

test('sales come from all payment types and shifts', async () => {
  sheets.setRows(SHEETS.SALES_ENTRIES, [
    entryRow({ id: 'e1', amount: 1000 }),
    entryRow({ id: 'e2', shift: 'Night', paymentType: 'Card', amount: 400 }),
    entryRow({ id: 'e3', shift: 'Day', paymentType: 'OnlineVendor', vendor: 'Swiggy', amount: 250 })
  ]);

  const res = await server.request('GET', url('2026-02-02', '2026-02-02'));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.totals.sales, 1650);
  assert.equal(res.body.data.days[0].cashSales, 1000);
  assert.equal(res.body.data.days[0].onlineSales, 650);
});

test('market expenses are attributed to the previous day that funded them', async () => {
  sheets.setRows(SHEETS.SALES_ENTRIES, [entryRow({ amount: 1000 })]);
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'market', date: '2026-02-03', typeId: 'type-market', mode: 'Daily Non Cash', amount: 300 })
  ]);

  const res = await server.request('GET', url('2026-02-02', '2026-02-03'));
  const [first, second] = res.body.data.days;

  assert.equal(first.marketExpense, 300, 'market spend belongs to the funding day');
  assert.equal(second.marketExpense, 0);
  assert.equal(first.profit, 700);
});

test('each expense mode lands on its own line', async () => {
  sheets.setRows(SHEETS.SALES_ENTRIES, [entryRow({ amount: 2000 })]);
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'cash', amount: 100 }),
    expenseRow({ id: 'occ', typeId: 'type-occasional', mode: 'Occasional', amount: 50 }),
    expenseRow({ id: 'market', date: '2026-02-03', typeId: 'type-market', mode: 'Daily Non Cash', amount: 200 })
  ]);

  const day = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.days[0];
  assert.equal(day.dailyCashExpense, 100);
  assert.equal(day.occasionalExpense, 50);
  assert.equal(day.marketExpense, 200);
  assert.equal(day.totalCost, 350);
});

test('salary accrues day-wise and reports paid, petta and pending', async () => {
  sheets.setRows(SHEETS.EMPLOYEES, [employeeRow()]);
  sheets.setRows(SHEETS.SALARY_PAYMENTS, [
    ['pay-1', 'emp-1', 'Ravi', '2026-02-02', 700, '', 'admin', '2026-02-02T12:00:00.000Z']
  ]);

  const totals = (await server.request('GET', url('2026-02-01', '2026-02-02'))).body.data.totals;
  assert.equal(totals.salaryGross, 1000, 'two days at 500 per day');
  assert.equal(totals.pettaTotal, 200, 'two days of 100 petta');
  assert.equal(totals.salaryPaid, 700);
  assert.equal(totals.salaryPending, 400, 'day one is 400 pending; day two is settled, not negative');
});

test('profit follows sales - expenses - salary line - market', async () => {
  sheets.setRows(SHEETS.EMPLOYEES, [employeeRow()]);
  sheets.setRows(SHEETS.SALES_ENTRIES, [
    entryRow({ id: 'cash', amount: 4000 }),
    entryRow({ id: 'online', paymentType: 'Card', amount: 1000 })
  ]);
  sheets.setRows(SHEETS.SALARY_PAYMENTS, [
    ['pay-1', 'emp-1', 'Ravi', '2026-02-02', 300, '', 'admin', '2026-02-02T12:00:00.000Z']
  ]);
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'daily', amount: 600 }),
    expenseRow({ id: 'occ', typeId: 'type-occasional', mode: 'Occasional', amount: 150 }),
    expenseRow({ id: 'salary', category: 'Ravi', employeeId: 'emp-1', paymentId: 'pay-1', amount: 300 }),
    expenseRow({ id: 'market', date: '2026-02-03', typeId: 'type-market', mode: 'Daily Non Cash', amount: 400 })
  ]);

  const day = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.days[0];

  assert.equal(day.sales, 5000);
  assert.equal(day.dailyCashExpense, 900, 'daily cash includes the salary payment row');
  assert.equal(day.occasionalExpense, 150);
  assert.equal(day.marketExpense, 400);
  assert.equal(day.salaryPending, 100, 'salary 500 - petta 100 - received 300');
  assert.equal(day.totalCost, 1550);
  assert.equal(day.profit, 3450, '5000 - 900 - 150 - 100 - 400');
});

test('paying arrears does not make a day look more profitable', async () => {
  sheets.setRows(SHEETS.EMPLOYEES, [employeeRow()]);
  sheets.setRows(SHEETS.SALARY_PAYMENTS, [
    ['pay-1', 'emp-1', 'Ravi', '2026-02-02', 700, '', 'admin', '2026-02-02T12:00:00.000Z']
  ]);
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'salary-expense', category: 'Ravi', employeeId: 'emp-1', paymentId: 'pay-1', amount: 700 })
  ]);

  const day = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.days[0];
  assert.equal(day.dailyCashExpense, 700);
  assert.equal(day.salaryPending, 0, 'the day owes nothing further; earlier dues stay on earlier days');
  assert.equal(day.totalCost, 700);
});

test('leave days reduce accrued salary and inactive staff do not accrue', async () => {
  sheets.setRows(SHEETS.EMPLOYEES, [
    employeeRow(),
    employeeRow({ id: 'emp-2', name: 'Old', status: 'Inactive' })
  ]);
  sheets.setRows(SHEETS.LEAVES, [
    ['leave-1', 'emp-1', 'Ravi', '2026-02-02T00:00', '2026-02-03T00:00', '', 'admin', '']
  ]);

  const totals = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.totals;
  assert.equal(totals.salaryGross, 0, 'a full leave day accrues nothing');
  assert.equal(totals.pettaTotal, 0);
});

test('temporary staff cost stays with their expense row', async () => {
  sheets.setRows(SHEETS.EMPLOYEES, [employeeRow({ id: 'emp-temp', name: 'Kumar', temporary: 'true', perDay: 0, petta: 0 })]);
  sheets.setRows(SHEETS.SALARY_PAYMENTS, [
    ['pay-2', 'emp-temp', 'Kumar', '2026-02-02', 250, '', 'cashier', '2026-02-02T12:00:00.000Z']
  ]);
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'temp-expense', category: 'Kumar', employeeId: 'emp-temp', paymentId: 'pay-2', amount: 250 })
  ]);

  const day = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.days[0];
  assert.equal(day.dailyCashExpense, 250);
  assert.equal(day.salaryPending, 0, 'the payment already sits in expenses');
  assert.equal(day.totalCost, 250);
});

test('a salary payment missing from expenses is flagged', async () => {
  sheets.setRows(SHEETS.EMPLOYEES, [employeeRow()]);
  sheets.setRows(SHEETS.SALES_ENTRIES, [entryRow({ amount: 2000 })]);
  sheets.setRows(SHEETS.SALARY_PAYMENTS, [
    ['pay-1', 'emp-1', 'Ravi', '2026-02-02', 300, '', 'admin', '2026-02-02T12:00:00.000Z']
  ]);

  const analytics = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.analytics;
  const flagged = analytics.dayIssues.find(item => item.issue === 'Salary payment not recorded as an expense');
  assert.ok(flagged, 'unmirrored payments must be reported');
  assert.equal(flagged.amount, 300);
});

test('profit and margin summarise the whole range', async () => {
  sheets.setRows(SHEETS.SALES_ENTRIES, [
    entryRow({ id: 'e1', date: '2026-02-01', amount: 1000 }),
    entryRow({ id: 'e2', date: '2026-02-02', amount: 1000 })
  ]);
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ date: '2026-02-01', amount: 200 })]);

  const totals = (await server.request('GET', url('2026-02-01', '2026-02-02'))).body.data.totals;
  assert.equal(totals.sales, 2000);
  assert.equal(totals.profit, 1800);
  assert.equal(totals.margin, 90);
});

test('analytics flags self approval, outliers and on-spot usage', async () => {
  sheets.setRows(SHEETS.SALES_ENTRIES, [entryRow({ amount: 5000 })]);
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'a', category: 'Oil', amount: 100 }),
    expenseRow({ id: 'b', category: 'Oil', amount: 100 }),
    expenseRow({ id: 'c', category: 'Oil', amount: 100 }),
    expenseRow({ id: 'd', category: 'Oil', amount: 1200 }),
    expenseRow({ id: 'e', category: 'Auto fare', onSpot: true, amount: 300 }),
    expenseRow({ id: 'f', approvalStatus: 'Approved', approvedBy: 'cashier', submittedBy: 'cashier', amount: 100 })
  ]);

  const analytics = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.analytics;

  assert.deepEqual(analytics.selfApproved.map(item => item.id), ['f']);
  assert.deepEqual(analytics.outliers.map(item => item.id), ['d']);
  assert.equal(analytics.onSpot.count, 1);
  assert.equal(analytics.onSpot.total, 300);
});

test('analytics flags sales entered or edited after the day', async () => {
  sheets.setRows(SHEETS.SALES_ENTRIES, [
    entryRow({ id: 'ok', amount: 1000 }),
    entryRow({ id: 'late', amount: 900, createdAt: '2026-02-05T09:00:00.000Z', updatedAt: '2026-02-05T09:00:00.000Z' })
  ]);

  const analytics = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.analytics;
  assert.equal(analytics.lateSalesEdits.length, 1);
  assert.equal(analytics.lateSalesEdits[0].daysLate, 3);
  assert.equal(analytics.lateSalesEdits[0].action, 'Entered later');
});

test('analytics flags days where costs do not track sales', async () => {
  sheets.setRows(SHEETS.SALES_ENTRIES, [
    entryRow({ id: 'e1', date: '2026-02-01', amount: 1000 }),
    entryRow({ id: 'e2', date: '2026-02-02', amount: 1000 }),
    entryRow({ id: 'e3', date: '2026-02-03', amount: 1000 })
  ]);
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'x1', date: '2026-02-01', amount: 100 }),
    expenseRow({ id: 'x2', date: '2026-02-02', amount: 100 }),
    expenseRow({ id: 'x3', date: '2026-02-03', amount: 900 })
  ]);

  const analytics = (await server.request('GET', url('2026-02-01', '2026-02-03'))).body.data.analytics;
  assert.deepEqual(analytics.ratio.flagged.map(item => item.date), ['2026-02-03']);
  assert.equal(analytics.ratio.flagged[0].direction, 'Cost too high for sales');
});

test('analytics flags expenses recorded with no sales', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ amount: 400 })]);

  const analytics = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.analytics;
  assert.deepEqual(analytics.dayIssues, [{ date: '2026-02-02', issue: 'Expenses recorded with no sales', amount: 400 }]);
});

test('analytics flags cash expenses exceeding cash sales', async () => {
  sheets.setRows(SHEETS.SALES_ENTRIES, [entryRow({ amount: 100 })]);
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ amount: 400 })]);

  const analytics = (await server.request('GET', url('2026-02-02', '2026-02-02'))).body.data.analytics;
  assert.equal(analytics.dayIssues[0].issue, 'Cash expenses exceed cash sales');
  assert.equal(analytics.dayIssues[0].amount, -300);
});

test('a salary revision applies only from its effective date', async () => {
  sheets.setRows(SHEETS.EMPLOYEES, [employeeRow({ petta: 0 })]);
  sheets.setRows(SHEETS.SALARY_HISTORY, [
    ['sal-1', 'emp-1', 'Ravi', '2026-01-01', 500, '', 'admin', ''],
    ['sal-2', 'emp-1', 'Ravi', '2026-02-02', 700, 'Increment', 'admin', '']
  ]);

  const days = (await server.request('GET', url('2026-02-01', '2026-02-02'))).body.data.days;
  assert.equal(days[0].salaryGross, 500, 'the day before the revision keeps the old rate');
  assert.equal(days[1].salaryGross, 700);
});

test('the occasional report lists only occasional expenses grouped by date', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'daily', amount: 100 }),
    expenseRow({ id: 'occ-1', date: '2026-02-02', category: 'Repair', typeId: 'type-occasional', mode: 'Occasional', amount: 400 }),
    expenseRow({ id: 'occ-2', date: '2026-02-02', category: 'Repair', typeId: 'type-occasional', mode: 'Occasional', amount: 100 }),
    expenseRow({ id: 'occ-3', date: '2026-02-03', category: 'Licence', typeId: 'type-occasional', mode: 'Occasional', amount: 250 }),
    expenseRow({ id: 'occ-out', date: '2026-02-09', typeId: 'type-occasional', mode: 'Occasional', amount: 999 })
  ]);

  const res = await server.request('GET', '/api/reports/occasional?from=2026-02-01&to=2026-02-03');
  assert.equal(res.status, 200);
  const data = res.body.data;

  assert.deepEqual(data.entries.map(entry => entry.id), ['occ-3', 'occ-1', 'occ-2']);
  assert.deepEqual(data.days, [
    { date: '2026-02-03', count: 1, amount: 250 },
    { date: '2026-02-02', count: 2, amount: 500 }
  ]);
  assert.deepEqual(data.categories, [{ category: 'Repair', amount: 500 }, { category: 'Licence', amount: 250 }]);
  assert.deepEqual(data.totals, { count: 3, amount: 750, days: 2 });
});

test('the occasional report is restricted and validates the range', async () => {
  server.loginAs(CASHIER);
  assert.equal((await server.request('GET', '/api/reports/occasional?from=2026-02-01&to=2026-02-03')).status, 403);

  server.loginAs(SUPERUSER);
  assert.equal((await server.request('GET', '/api/reports/occasional?from=2026-02-05&to=2026-02-01')).status, 400);
});
