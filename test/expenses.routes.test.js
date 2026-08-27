const test = require('node:test');
const assert = require('node:assert/strict');

const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();

// Router must be required after the stub is installed.
const { startTestServer } = require('./helpers/test-server');
const expensesRouter = require('../routes/expenses');

const CASHIER = { id: 'user-cashier', username: 'cashier', role: 'cashier' };
const SUPERUSER = { id: 'user-super', username: 'admin', role: 'superuser' };

const CATEGORY_TYPES = [
  ['type-cash', 'General', 1, 'Active', 'All', '', 'General', 'Daily Cash'],
  ['type-limited', 'Owner Only', 2, 'Active', 'Limited', SUPERUSER.id, 'Owner Only', 'Daily Cash'],
  ['type-occasional', 'Occasional', 3, 'Active', 'All', '', 'Occasional', 'Occasional']
];

const CATEGORIES = [
  ['cat-milk', 'Milk', 1, 'Active', 'type-cash'],
  ['cat-secret', 'Owner Draw', 2, 'Active', 'type-limited'],
  ['cat-repair', 'Repair', 3, 'Active', 'type-occasional']
];

function expenseRow(overrides = {}) {
  const o = {
    id: 'exp-1', date: '2026-01-05', category: 'Milk', description: '', amount: 100,
    employeeId: '', employeeName: '', submittedBy: 'cashier', approvalStatus: 'Pending',
    approvedBy: '', approvedAt: '', rejectionReason: '', createdAt: new Date().toISOString(),
    typeId: 'type-cash', onSpot: false, paymentId: '', shift: '', mode: 'Daily Cash',
    ...overrides
  };
  return [
    o.id, o.date, o.category, o.description, o.amount, o.employeeId, o.employeeName,
    o.submittedBy, o.approvalStatus, o.approvedBy, o.approvedAt, o.rejectionReason,
    o.createdAt, o.typeId, o.onSpot ? 'TRUE' : '', o.paymentId, o.shift, o.mode
  ];
}

const server = startTestServer('/api/expenses', expensesRouter);

test.beforeEach(() => {
  sheets.reset();
  sheets.setRows(SHEETS.EXPENSE_CATEGORY_TYPES, CATEGORY_TYPES);
  sheets.setRows(SHEETS.EXPENSE_CATEGORIES, CATEGORIES);
  sheets.setRows(SHEETS.EXPENSES, []);
  server.loginAs(CASHIER);
});

test.after(() => server.close());

test('rejects unauthenticated requests', async () => {
  server.logout();
  const res = await server.request('GET', '/api/expenses');
  assert.equal(res.status, 401);
});

test('bulk save rejects future dates', async () => {
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2099-01-01',
    entries: [{ category: 'Milk', amount: 50, typeId: 'type-cash' }]
  });
  assert.equal(res.status, 400);
});

test('bulk save accepts an on-spot category that is not in the master list', async () => {
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Auto fare', amount: 80, typeId: 'type-cash', onSpot: true }],
    remarks: 'note'
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  const rows = sheets.getRows(SHEETS.EXPENSES);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2], 'Auto fare');
  assert.equal(rows[0][14], 'TRUE');
  assert.equal(rows[0][17], 'Daily Cash');
});

test('bulk save skips entries with a non-positive amount', async () => {
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [
      { category: 'Milk', amount: 120, typeId: 'type-cash' },
      { category: 'Auto fare', amount: 0, typeId: 'type-cash', onSpot: true }
    ]
  });

  assert.equal(res.status, 200);
  assert.deepEqual(sheets.getRows(SHEETS.EXPENSES).map(row => row[2]), ['Milk']);
});

test('bulk save denies categories from a restricted type', async () => {
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Owner Draw', amount: 500, typeId: 'type-limited' }]
  });
  assert.equal(res.status, 403);
});

test('bulk save keeps rows the user cannot see when replacing a date', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'exp-visible', category: 'Milk', amount: 10 }),
    expenseRow({ id: 'exp-hidden', category: 'Owner Draw', typeId: 'type-limited', amount: 900 })
  ]);

  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 250, typeId: 'type-cash' }]
  });

  assert.equal(res.status, 200);
  const rows = sheets.getRows(SHEETS.EXPENSES);
  assert.equal(rows.length, 2);
  assert.ok(rows.some(row => row[0] === 'exp-hidden'));
  assert.ok(rows.some(row => row[2] === 'Milk' && Number(row[4]) === 250));
});

test('bulk save refuses an approved date', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ approvalStatus: 'Approved' })]);
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 60, typeId: 'type-cash' }]
  });
  assert.equal(res.status, 409);
});

test('listing hides expenses belonging to a restricted type', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'exp-visible' }),
    expenseRow({ id: 'exp-hidden', category: 'Owner Draw', typeId: 'type-limited' })
  ]);

  const res = await server.request('GET', '/api/expenses');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map(item => item.id), ['exp-visible']);

  server.loginAs(SUPERUSER);
  const superRes = await server.request('GET', '/api/expenses');
  assert.deepEqual(superRes.body.data.map(item => item.id), ['exp-visible', 'exp-hidden']);
});

test('listing auto-approves pending rows older than the cutoff', async () => {
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ createdAt: oldDate })]);

  const res = await server.request('GET', '/api/expenses');
  assert.equal(res.body.data[0].approvalStatus, 'AutoApproved');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'AutoApproved');
});

test('occasional expense requires an occasional type', async () => {
  const res = await server.request('POST', '/api/expenses/occasional', {
    date: '2026-01-05', category: 'Milk', typeId: 'type-cash', amount: 40
  });
  assert.equal(res.status, 403);
});

test('occasional expense is stored with Occasional mode', async () => {
  const res = await server.request('POST', '/api/expenses/occasional', {
    date: '2026-01-05', category: 'Repair', typeId: 'type-occasional', amount: 400, remarks: 'fan'
  });

  assert.equal(res.status, 201);
  const rows = sheets.getRows(SHEETS.EXPENSES);
  assert.equal(rows[0][17], 'Occasional');
  assert.equal(rows[0][3], 'fan');
});

test('delete removes an on-spot expense but not a regular one', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'exp-regular' }),
    expenseRow({ id: 'exp-onspot', category: 'Auto fare', onSpot: true })
  ]);

  const blocked = await server.request('DELETE', '/api/expenses/exp-regular');
  assert.equal(blocked.status, 403);

  const removed = await server.request('DELETE', '/api/expenses/exp-onspot');
  assert.equal(removed.status, 200);
  assert.deepEqual(sheets.getRows(SHEETS.EXPENSES).map(row => row[0]), ['exp-regular']);
});

test('delete refuses an approved on-spot expense', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'exp-onspot', category: 'Auto fare', onSpot: true, approvalStatus: 'Approved' })
  ]);

  const res = await server.request('DELETE', '/api/expenses/exp-onspot');
  assert.equal(res.status, 409);
});

test('approve and reject are limited to super users', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow()]);

  const denied = await server.request('POST', '/api/expenses/approve/2026-01-05');
  assert.equal(denied.status, 403);

  server.loginAs(SUPERUSER);
  const approved = await server.request('POST', '/api/expenses/approve/2026-01-05');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.updated, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Approved');

  const rejected = await server.request('POST', '/api/expenses/reject/2026-01-05', { reason: 'wrong total' });
  assert.equal(rejected.body.data.updated, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Rejected');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][11], 'wrong total');
});

test('a super user cannot approve their own submission', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ submittedBy: SUPERUSER.username })]);
  server.loginAs(SUPERUSER);

  const res = await server.request('POST', '/api/expenses/approve/2026-01-05');
  assert.equal(res.body.data.updated, 0);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Pending');
});
