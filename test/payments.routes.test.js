const test = require('node:test');
const assert = require('node:assert/strict');

const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();

const { startTestServer } = require('./helpers/test-server');
const paymentsRouter = require('../routes/payments');

const CASHIER = { id: 'user-cashier', username: 'cashier', displayName: 'Cashier', role: 'cashier' };
const SUPERUSER = { id: 'user-super', username: 'admin', displayName: 'Admin', role: 'superuser' };

const CATEGORY_TYPES = [
  ['type-general', 'General', 1, 'Active', 'All', '', 'General', 'Daily Cash'],
  ['type-limited', 'Owner Only', 2, 'Active', 'Limited', SUPERUSER.id, 'Owner Only', 'Daily Cash'],
  ['type-morning', 'Morning', 3, 'Active', 'All', '', 'Morning', 'Daily Cash']
];

// Employees: ID, Name, Address, Phone, StartDate, PerDaySalary, DailyPetta, Status, DailySalaryEnabled, TemporaryEmployee
const EMPLOYEES = [
  ['emp-perm', 'Ravi', '', '', '2025-01-01', 500, 50, 'Active', 'true', 'false'],
  ['emp-temp', 'Kumar', '', '', '2025-01-01', 400, 0, 'Active', 'false', 'true']
];

function businessToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const TODAY = businessToday();
const server = startTestServer('/api/payments', paymentsRouter);

test.beforeEach(() => {
  sheets.reset();
  sheets.setRows(SHEETS.EXPENSE_CATEGORY_TYPES, CATEGORY_TYPES);
  sheets.setRows(SHEETS.EMPLOYEES, EMPLOYEES);
  sheets.setRows(SHEETS.SALARY_PAYMENTS, []);
  sheets.setRows(SHEETS.EXPENSES, []);
  server.loginAs(CASHIER);
});

test.after(() => server.close());

test('rejects unauthenticated requests', async () => {
  server.logout();
  assert.equal((await server.request('GET', '/api/payments')).status, 401);
  assert.equal((await server.request('DELETE', '/api/payments/any')).status, 401);
});

test('requires a positive amount', async () => {
  const res = await server.request('POST', '/api/payments', {
    employeeId: 'emp-perm', employeeName: 'Ravi', paymentDate: TODAY, amount: 0
  });
  assert.equal(res.status, 400);
});

test('a cashier can only record payments dated today', async () => {
  const res = await server.request('POST', '/api/payments', {
    employeeId: 'emp-perm', employeeName: 'Ravi', paymentDate: '2026-01-05', amount: 300
  });
  assert.equal(res.status, 400);

  server.loginAs(SUPERUSER);
  const superRes = await server.request('POST', '/api/payments', {
    employeeId: 'emp-perm', employeeName: 'Ravi', paymentDate: '2026-01-05', amount: 300
  });
  assert.equal(superRes.status, 201);
});

test('a plain payment does not create an expense row', async () => {
  const res = await server.request('POST', '/api/payments', {
    employeeId: 'emp-perm', employeeName: 'Ravi', paymentDate: TODAY, amount: 300
  });

  assert.equal(res.status, 201);
  assert.equal(sheets.getRows(SHEETS.SALARY_PAYMENTS).length, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 0);
});

test('addAsExpense links the expense row back to the payment', async () => {
  const res = await server.request('POST', '/api/payments', {
    employeeId: 'emp-perm', employeeName: 'Ravi', paymentDate: TODAY, amount: 300,
    addAsExpense: true, expenseTypeId: 'type-general'
  });

  const expense = sheets.getRows(SHEETS.EXPENSES)[0];
  assert.equal(expense[5], 'emp-perm');
  assert.equal(expense[13], 'type-general');
  assert.equal(expense[15], res.body.data.id);
  assert.equal(expense[8], 'Pending');
});

test('a temporary employee always creates an expense and needs a shift type', async () => {
  const missingShift = await server.request('POST', '/api/payments', {
    employeeId: 'emp-temp', employeeName: 'Kumar', paymentDate: TODAY, amount: 200,
    expenseTypeId: 'type-general'
  });
  assert.equal(missingShift.status, 400);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 0);

  const withShiftType = await server.request('POST', '/api/payments', {
    employeeId: 'emp-temp', employeeName: 'Kumar', paymentDate: TODAY, amount: 200,
    expenseTypeId: 'type-morning'
  });
  assert.equal(withShiftType.status, 201);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][16], 'Morning');
});

test('a cashier cannot post an expense against a restricted type', async () => {
  const res = await server.request('POST', '/api/payments', {
    employeeId: 'emp-perm', employeeName: 'Ravi', paymentDate: TODAY, amount: 300,
    addAsExpense: true, expenseTypeId: 'type-limited'
  });
  assert.equal(res.status, 403);
  assert.equal(sheets.getRows(SHEETS.SALARY_PAYMENTS).length, 0);
});

test('a cashier only sees payments dated today', async () => {
  sheets.setRows(SHEETS.SALARY_PAYMENTS, [
    ['pay-old', 'emp-perm', 'Ravi', '2026-01-05', 100, '', 'Admin', ''],
    ['pay-today', 'emp-perm', 'Ravi', TODAY, 200, '', 'Cashier', '']
  ]);

  const cashierRes = await server.request('GET', '/api/payments');
  assert.deepEqual(cashierRes.body.data.map(item => item.id), ['pay-today']);

  server.loginAs(SUPERUSER);
  const superRes = await server.request('GET', '/api/payments');
  assert.deepEqual(superRes.body.data.map(item => item.id), ['pay-old', 'pay-today']);
});

test('deleting a payment also removes its linked expense', async () => {
  const created = await server.request('POST', '/api/payments', {
    employeeId: 'emp-perm', employeeName: 'Ravi', paymentDate: TODAY, amount: 300,
    addAsExpense: true, expenseTypeId: 'type-general'
  });

  const res = await server.request('DELETE', `/api/payments/${created.body.data.id}`);
  assert.equal(res.status, 200);
  assert.equal(sheets.getRows(SHEETS.SALARY_PAYMENTS).length, 0);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 0);
});

test('deleting a payment leaves unrelated expenses untouched', async () => {
  const created = await server.request('POST', '/api/payments', {
    employeeId: 'emp-perm', employeeName: 'Ravi', paymentDate: TODAY, amount: 300,
    addAsExpense: true, expenseTypeId: 'type-general'
  });
  sheets.setRows(SHEETS.EXPENSES, [
    ...sheets.getRows(SHEETS.EXPENSES),
    ['exp-other', TODAY, 'Milk', '', 75, '', '', 'cashier', 'Pending', '', '', '', '', 'type-general', '', '', '', 'Daily Cash']
  ]);

  await server.request('DELETE', `/api/payments/${created.body.data.id}`);
  assert.deepEqual(sheets.getRows(SHEETS.EXPENSES).map(row => row[0]), ['exp-other']);
});

test('an approved linked expense blocks the payment deletion', async () => {
  const created = await server.request('POST', '/api/payments', {
    employeeId: 'emp-perm', employeeName: 'Ravi', paymentDate: TODAY, amount: 300,
    addAsExpense: true, expenseTypeId: 'type-general'
  });
  const expenses = sheets.getRows(SHEETS.EXPENSES);
  expenses[0][8] = 'Approved';
  sheets.setRows(SHEETS.EXPENSES, expenses);

  const res = await server.request('DELETE', `/api/payments/${created.body.data.id}`);
  assert.equal(res.status, 409);
  assert.equal(sheets.getRows(SHEETS.SALARY_PAYMENTS).length, 1);
});

test('deleting an unknown payment returns 404', async () => {
  const res = await server.request('DELETE', '/api/payments/missing');
  assert.equal(res.status, 404);
});

test('settlement ranges persist and are returned on later reads without removing old payments', async () => {
  server.loginAs(SUPERUSER);
  sheets.setRows(SHEETS.EMPLOYEES, [['regular', 'Regular', '', '', '2020-01-01', 100, 0, 'Active', 'false', 'false']]);
  sheets.setRows(SHEETS.SALARY_PAYMENTS, [['old', 'regular', 'Regular', '2020-01-01', 10, '', 'Admin', '']]);
  const created = await server.request('POST', '/api/payments', {
    employeeId: 'regular', paymentDate: '2020-01-05', amount: 490,
    settlementStart: '2020-01-01', settlementEnd: '2020-01-05'
  });
  assert.equal(created.status, 201);
  const records = (await server.request('GET', '/api/payments?employeeId=regular')).body.data;
  assert.equal(records.length, 2);
  assert.equal(records[1].settlementStart, '2020-01-01');
  assert.equal(records[1].settlementEnd, '2020-01-05');
  const overlap = await server.request('POST', '/api/payments', {
    employeeId: 'regular', paymentDate: '2020-01-06', amount: 100,
    settlementStart: '2020-01-05', settlementEnd: '2020-01-06'
  });
  assert.equal(overlap.status, 409);
  assert.equal(sheets.getRows(SHEETS.SALARY_PAYMENTS).length, 2);
});

test('legacy settlement payments expose their archived period', async () => {
  server.loginAs(SUPERUSER);
  sheets.setRows(SHEETS.SALARY_PAYMENTS, [
    ['legacy', 'emp-perm', 'Ravi', '2020-01-05', 500, 'Salary settlement: 2020-01-01 to 2020-01-05 (includes opening pending/advance)', 'Admin', '']
  ]);
  const records = (await server.request('GET', '/api/payments')).body.data;
  assert.equal(records[0].settlementStart, '2020-01-01');
  assert.equal(records[0].settlementEnd, '2020-01-05');
});

test('settlement metadata rejects invalid dates and missing date boundaries', async () => {
  server.loginAs(SUPERUSER);
  sheets.setRows(SHEETS.EMPLOYEES, [['regular', 'Regular', '', '', '2020-01-01', 100, 0, 'Active', 'false', 'false']]);
  for (const [settlementStart, settlementEnd] of [['2020-01-01', ''], ['2020-02-30', '2020-03-01'], ['2020-01-06', '2020-01-05']]) {
    const result = await server.request('POST', '/api/payments', {
      employeeId: 'regular', paymentDate: settlementEnd || '2020-01-05', amount: 100, settlementStart, settlementEnd
    });
    assert.equal(result.status, 400);
  }
  assert.equal(sheets.getRows(SHEETS.SALARY_PAYMENTS).length, 0);
});

test('settlement bonus is persisted and returned as part of the total payment', async () => {
  server.loginAs(SUPERUSER);
  sheets.setRows(SHEETS.EMPLOYEES, [['regular', 'Regular', '', '', '2020-01-01', 100, 0, 'Active', 'false', 'false']]);
  const created = await server.request('POST', '/api/payments', {
    employeeId: 'regular', paymentDate: '2020-01-05', amount: 650.25,
    settlementStart: '2020-01-01', settlementEnd: '2020-01-05', bonusAmount: 150.25,
    addAsExpense: true, expenseTypeId: 'type-general'
  });
  assert.equal(created.status, 201);
  assert.equal(sheets.getRows(SHEETS.SALARY_PAYMENTS)[0][10], 150.25);
  const records = (await server.request('GET', '/api/payments')).body.data;
  assert.equal(records[0].bonusAmount, 150.25);
  assert.equal(records[0].amount, 650.25);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][4], 650.25);
});

test('invalid bonus amounts and non-settlement bonuses are rejected', async () => {
  server.loginAs(SUPERUSER);
  for (const bonusAmount of [-1, 'abc', '100', 1.001, 50]) {
    const result = await server.request('POST', '/api/payments', {
      employeeId: 'emp-perm', paymentDate: '2020-01-05', amount: 100, bonusAmount
    });
    assert.equal(result.status, 400);
  }
  assert.equal(sheets.getRows(SHEETS.SALARY_PAYMENTS).length, 0);
});
