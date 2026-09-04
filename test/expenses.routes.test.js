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
    typeId: 'type-cash', onSpot: false, paymentId: '', shift: '', mode: 'Daily Cash', updatedBy: '', updatedAt: '',
    ...overrides
  };
  return [
    o.id, o.date, o.category, o.description, o.amount, o.employeeId, o.employeeName,
    o.submittedBy, o.approvalStatus, o.approvedBy, o.approvedAt, o.rejectionReason,
    o.createdAt, o.typeId, o.onSpot ? 'TRUE' : '', o.paymentId, o.shift, o.mode, o.updatedBy, o.updatedAt
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

test('concurrent saves for one date do not create duplicate daily expenses', async () => {
  const payload = {
    date: '2026-01-05', entries: [{ category: 'Milk', amount: 120, typeId: 'type-cash' }]
  };

  const [first, second] = await Promise.all([
    server.request('POST', '/api/expenses/bulk', payload),
    server.request('POST', '/api/expenses/bulk', payload)
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][4], 120);
});

test('an ID-less save updates the existing category-type row instead of duplicating it', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'exp-milk', amount: 10 })]);

  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Milk', amount: 120, typeId: 'type-cash' }]
  });

  assert.equal(res.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][0], 'exp-milk');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][4], 120);
});

test('a corrected category matches its existing row despite case and whitespace changes', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'exp-milk', category: 'Milk', approvalStatus: 'Rejected' })]);

  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: ' milk ', amount: 120, typeId: 'type-cash' }]
  });

  assert.equal(res.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][0], 'exp-milk');
});

test('the same date, category type, and category is updated instead of duplicated as on-spot', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ category: 'Milk', typeId: 'type-cash' })]);

  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Milk', amount: 120, typeId: 'type-cash', onSpot: true }]
  });
  assert.equal(res.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][14], 'TRUE');
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

test('bulk save updates submitted expense IDs in place', async () => {
  const createdAt = '2026-01-05T10:00:00.000Z';
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'exp-milk', amount: 10, createdAt })]);

  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ id: 'exp-milk', category: 'Milk', amount: 250, typeId: 'type-cash' }]
  });

  assert.equal(res.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][0], 'exp-milk');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][4], 250);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][12], createdAt);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][18], CASHIER.username);
  assert.ok(sheets.getRows(SHEETS.EXPENSES)[0][19]);
});

test('bulk save refuses an approved date', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ approvalStatus: 'Approved' })]);
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 60, typeId: 'type-cash' }]
  });
  assert.equal(res.status, 409);
});

test('an approved employee expense does not lock daily expense corrections', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ employeeId: 'emp-1', approvalStatus: 'AutoApproved' })]);

  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Milk', amount: 60, typeId: 'type-cash' }]
  });
  assert.equal(res.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 2);
});

test('a rejected auto-approved date can be corrected and saved', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ approvalStatus: 'AutoApproved', submittedBy: 'admin' })]);
  server.loginAs(SUPERUSER);

  const rejected = await server.request('POST', '/api/expenses/reject/2026-01-05', { reason: 'Correct the amount.', expenseIds: ['exp-1'] });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.updated, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Rejected');

  server.loginAs(CASHIER);
  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Milk', amount: 60, typeId: 'type-cash' }]
  });
  assert.equal(saved.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Pending');
});

test('a rejected row can be corrected when the submitted row ID is stale', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'current-id', approvalStatus: 'Rejected' })]);

  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ id: 'stale-id', category: 'Milk', amount: 60, typeId: 'type-cash' }]
  });

  assert.equal(saved.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][0], 'current-id');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Pending');
});

test('a renamed rejected on-spot expense can be corrected with a stale row ID', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'current-id', category: 'Old auto fare', onSpot: true, approvalStatus: 'Rejected' })]);

  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ id: 'stale-id', category: 'Corrected auto fare', amount: 60, typeId: 'type-cash', onSpot: true }]
  });

  assert.equal(saved.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][2], 'Corrected auto fare');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Pending');
});

test('rejecting one category preserves approved categories and resubmits only the rejected one', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'exp-milk', category: 'Milk', approvalStatus: 'Approved' }),
    expenseRow({ id: 'exp-secret', category: 'Owner Draw', typeId: 'type-limited', approvalStatus: 'Approved' })
  ]);
  server.loginAs(SUPERUSER);

  const rejected = await server.request('POST', '/api/expenses/reject/2026-01-05', {
    reason: 'Correct owner draw.', expenseIds: ['exp-secret']
  });
  assert.equal(rejected.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Approved');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[1][8], 'Rejected');

  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Owner Draw', amount: 500, typeId: 'type-limited' }]
  });
  assert.equal(saved.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Approved');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[1][8], 'Pending');
});

test('a partial correction updates a matching pending row instead of reporting a duplicate', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'exp-rejected', category: 'Milk', approvalStatus: 'Rejected' }),
    expenseRow({ id: 'exp-pending', category: 'Owner Draw', typeId: 'type-limited', approvalStatus: 'Pending' })
  ]);
  server.loginAs(SUPERUSER);

  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Owner Draw', amount: 500, typeId: 'type-limited' }]
  });

  assert.equal(saved.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][0], 'exp-pending');
});

test('a pending corrected row can be saved again beside an approved row', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'exp-approved', category: 'Milk', approvalStatus: 'Approved' }),
    expenseRow({ id: 'exp-correction', category: 'Owner Draw', typeId: 'type-limited', approvalStatus: 'Pending', amount: 100 })
  ]);
  server.loginAs(SUPERUSER);

  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ id: 'exp-correction', category: 'Owner Draw', amount: 500, typeId: 'type-limited' }]
  });

  assert.equal(saved.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 2);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Approved');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[1][4], 500);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[1][8], 'Pending');
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

test('listing follows the configured auto-approval enablement and delay', async () => {
  const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ createdAt: oldDate })]);
  sheets.setRows(SHEETS.SETTINGS, [['AUTO_APPROVAL_ENABLED', 'true'], ['AUTO_APPROVAL_DAYS', '5']]);

  let res = await server.request('GET', '/api/expenses');
  assert.equal(res.body.data[0].approvalStatus, 'Pending', 'a three-day-old expense must wait for a five-day delay');

  sheets.setRows(SHEETS.SETTINGS, [['AUTO_APPROVAL_ENABLED', 'false'], ['AUTO_APPROVAL_DAYS', '1']]);
  res = await server.request('GET', '/api/expenses');
  assert.equal(res.body.data[0].approvalStatus, 'Pending', 'disabled auto approval must not approve the expense');
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

test('an occasional expense is updated in place while pending', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'occ-1', category: 'Repair', typeId: 'type-occasional', mode: 'Occasional', amount: 400 })]);

  const res = await server.request('PUT', '/api/expenses/occasional/occ-1', {
    date: '2026-01-05', category: 'Repair', typeId: 'type-occasional', amount: 550, remarks: 'fan repair'
  });

  assert.equal(res.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][0], 'occ-1');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][4], 550);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Pending');
});

test('an approved occasional expense cannot be edited', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'occ-1', category: 'Repair', typeId: 'type-occasional', mode: 'Occasional', approvalStatus: 'Approved' })]);

  const res = await server.request('PUT', '/api/expenses/occasional/occ-1', {
    date: '2026-01-05', category: 'Repair', typeId: 'type-occasional', amount: 550
  });

  assert.equal(res.status, 409);
});

test('occasional expenses cannot duplicate date, category type, and category', async () => {
  const payload = { date: '2026-01-05', category: 'Repair', typeId: 'type-occasional', amount: 400 };
  assert.equal((await server.request('POST', '/api/expenses/occasional', payload)).status, 201);
  assert.equal((await server.request('POST', '/api/expenses/occasional', payload)).status, 409);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 1);
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

  const rejected = await server.request('POST', '/api/expenses/reject/2026-01-05', { reason: 'wrong total', expenseIds: ['exp-1'] });
  assert.equal(rejected.body.data.updated, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Rejected');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][11], 'wrong total');
});

test('daily and occasional approval actions only update their own expense mode', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'daily', submittedBy: 'cashier', mode: 'Daily Cash', updatedBy: 'cashier', updatedAt: '2026-01-05T10:00:00.000Z' }),
    expenseRow({ id: 'occasional', category: 'Repair', typeId: 'type-occasional', submittedBy: 'cashier', mode: 'Occasional' })
  ]);
  server.loginAs(SUPERUSER);

  let res = await server.request('POST', '/api/expenses/approve/2026-01-05', { mode: 'Daily' });
  assert.equal(res.body.data.updated, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Approved');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][18], 'cashier');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][19], '2026-01-05T10:00:00.000Z');
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[1][8], 'Pending');

  res = await server.request('POST', '/api/expenses/approve/2026-01-05', { mode: 'Occasional' });
  assert.equal(res.body.data.updated, 1);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[1][8], 'Approved');
});

test('a super user cannot approve their own submission', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ submittedBy: SUPERUSER.username })]);
  server.loginAs(SUPERUSER);

  const res = await server.request('POST', '/api/expenses/approve/2026-01-05');
  assert.equal(res.body.data.updated, 0);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][8], 'Pending');
});
