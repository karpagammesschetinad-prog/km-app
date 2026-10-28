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

test('report returns only selected dates, categories and mode with optional quantities', async () => {
  server.loginAs(SUPERUSER);
  sheets.setRows(SHEETS.EXPENSES, [
    expenseRow({ id: 'selected', date: '2026-02-02', category: 'Milk' }),
    expenseRow({ id: 'old', date: '2026-01-01', category: 'Milk' }),
    expenseRow({ id: 'other', date: '2026-02-02', category: 'Rice' }),
    expenseRow({ id: 'occasional', date: '2026-02-02', category: 'Repair', mode: 'Occasional', typeId: 'type-occasional' })
  ]);
  sheets.setRows(SHEETS.EXPENSE_QUANTITIES, [
    ['q1', 'selected', 'milk', 'Milk', 'Litre', 10], ['q2', 'old', 'milk', 'Milk', 'Litre', 20]
  ]);
  const url = '/api/expenses/report?from=2026-02-01&to=2026-02-28&typeId=type-cash&category=Milk&mode=Daily';
  let res = await server.request('GET', url);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.expenses.map(item => item.id), ['selected']);
  assert.deepEqual(res.body.data.quantities, []);
  res = await server.request('GET', url + '&quantities=1');
  assert.deepEqual(res.body.data.quantities.map(item => item.id), ['q1']);
});

test('report endpoint enforces access and validates date filters', async () => {
  assert.equal((await server.request('GET', '/api/expenses/report')).status, 403);
  server.logout();
  assert.equal((await server.request('GET', '/api/expenses/report')).status, 401);
  server.loginAs(SUPERUSER);
  assert.equal((await server.request('GET', '/api/expenses/report?from=2026-03-01&to=2026-02-01')).status, 400);
  assert.equal((await server.request('GET', '/api/expenses/report?from=2026-02-30')).status, 400);
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

test('bulk save records configured quantity values against its expense row', async () => {
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 120, typeId: 'type-cash', quantities: [
      { quantityCategoryId: 'quantity-1', name: 'Volume', unit: 'Litre', amount: 5 }
    ] }]
  });

  assert.equal(res.status, 200);
  const expenseId = sheets.getRows(SHEETS.EXPENSES)[0][0];
  assert.deepEqual(sheets.getRows(SHEETS.EXPENSE_QUANTITIES)[0].slice(1, 6), [expenseId, 'quantity-1', 'Volume', 'Litre', 5]);
});

test('all quantities can be cleared from a saved zero-payment expense', async () => {
  const created = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Milk', typeId: 'type-cash', amount: 0,
      quantities: [{ quantityCategoryId: 'milk', name: 'Milk', unit: 'Litre', amount: 5 }] }]
  });
  assert.equal(created.status, 200);
  const id = created.body.data[0].id;
  const cleared = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ id, category: 'Milk', typeId: 'type-cash', amount: 0, quantities: [] }]
  });
  assert.equal(cleared.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES).length, 0);
});

test('expense quantity and price are optional independently', async () => {
  for (const quantities of [undefined, [], [{ quantityCategoryId: 'milk', name: 'Milk', unit: 'Litre', amount: 5, unitPrice: '' }]]) {
    sheets.setRows(SHEETS.EXPENSES, []);
    sheets.setRows(SHEETS.EXPENSE_QUANTITIES, []);
    const res = await server.request('POST', '/api/expenses/bulk', {
      date: '2026-01-05', entries: [{ category: 'Milk', typeId: 'type-cash', amount: 100, quantities }]
    });
    assert.equal(res.status, 200);
    assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][4], 100);
    assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES).length, quantities?.length || 0);
  }
});

test('bulk save records custom on-spot quantity values', async () => {
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Auto fare', amount: 120, typeId: 'type-cash', onSpot: true, quantities: [
      { quantityCategoryId: 'onspot:type-cash:Trips', name: 'Trips', unit: 'Count', amount: 2 }
    ] }]
  });

  assert.equal(res.status, 200);
  assert.deepEqual(sheets.getRows(SHEETS.EXPENSE_QUANTITIES)[0].slice(2, 6), ['onspot:type-cash:Trips', 'Trips', 'Count', 2]);
});

test('quantity unit prices are stored independently of the expense amount and returned on read', async () => {
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 120, typeId: 'type-cash', quantities: [
      { quantityCategoryId: 'quantity-1', name: 'Volume', unit: 'Litre', amount: 10, unitPrice: 52.5 },
      { quantityCategoryId: 'onspot:type-cash:Curd', name: 'Curd', unit: 'KG', amount: 2 }
    ] }]
  });

  assert.equal(res.status, 200);
  const rows = sheets.getRows(SHEETS.EXPENSE_QUANTITIES);
  assert.equal(rows[0][9], 52.5);
  assert.equal(rows[1][9], '');
  const read = (await server.request('GET', '/api/expenses/quantities')).body.data;
  assert.deepEqual(read.map(quantity => quantity.unitPrice), [52.5, 0]);
  assert.equal(sheets.getRows(SHEETS.EXPENSES)[0][4], 120);
});

test('resaving quantities replaces the stored unit price', async () => {
  const entry = unitPrice => ({ category: 'Milk', amount: 120, typeId: 'type-cash', quantities: [
    { quantityCategoryId: 'quantity-1', name: 'Volume', unit: 'Litre', amount: 10, unitPrice }
  ] });
  await server.request('POST', '/api/expenses/bulk', { date: '2026-01-05', entries: [entry(50)] });
  await server.request('POST', '/api/expenses/bulk', { date: '2026-01-05', entries: [entry('48.25')] });
  const rows = sheets.getRows(SHEETS.EXPENSE_QUANTITIES);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][9], 48.25);
});

test('quantity totals persist independently of rounded unit prices and payment amounts', async () => {
  const result = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Milk', typeId: 'type-cash', amount: 20,
      quantities: [{ quantityCategoryId: 'milk', name: 'Milk', unit: 'Litre', amount: 3, unitPrice: 33.33, totalAmount: 100 }] }]
  });
  assert.equal(result.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES)[0][10], 100);
  const read = await server.request('GET', '/api/expenses/quantities');
  assert.equal(read.body.data[0].totalAmount, 100);
  assert.equal(read.body.data[0].unitPrice, 33.33);
});

test('occasional quantity updates round extra decimal precision instead of failing', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'occ-precision', category: 'Repair', typeId: 'type-occasional', mode: 'Occasional', amount: 100 })]);
  const res = await server.request('PUT', '/api/expenses/occasional/occ-precision', {
    date: '2026-01-05', category: 'Repair', typeId: 'type-occasional', amount: 100,
    quantities: [{ quantityCategoryId: 'parts', name: 'Parts', unit: 'Count', amount: 3,
      unitPrice: '33.3333333333', totalAmount: '100.00000000001' }]
  });
  assert.equal(res.status, 200);
  const stored = sheets.getRows(SHEETS.EXPENSE_QUANTITIES)[0];
  assert.equal(stored[9], 33.33);
  assert.equal(stored[10], 100);
});

test('bulk quantities accept floating point totals and half-cent rates', async () => {
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Milk', typeId: 'type-cash', amount: 10,
      quantities: [{ quantityCategoryId: 'milk', name: 'Milk', unit: 'Litre', amount: 3, unitPrice: 1.005, totalAmount: 0.1 + 0.2 }] }]
  });
  assert.equal(res.status, 200);
  const stored = sheets.getRows(SHEETS.EXPENSE_QUANTITIES)[0];
  assert.equal(stored[9], 1.01);
  assert.equal(stored[10], 0.3);
});

test('invalid unit prices are rejected before anything is saved', async () => {
  for (const unitPrice of [-1, 'abc', '1e400']) {
    const res = await server.request('POST', '/api/expenses/bulk', {
      date: '2026-01-05',
      entries: [{ category: 'Milk', amount: 120, typeId: 'type-cash', quantities: [
        { quantityCategoryId: 'quantity-1', name: 'Volume', unit: 'Litre', amount: 5, unitPrice }
      ] }]
    });
    assert.equal(res.status, 400, `unit price ${unitPrice}`);
  }
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 0);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES).length, 0);
  const occasional = await server.request('POST', '/api/expenses/occasional', {
    date: '2026-01-05', category: 'Repair', typeId: 'type-occasional', amount: 400,
    quantities: [{ quantityCategoryId: 'onspot:x', name: 'Bolts', unit: 'Count', amount: 4, unitPrice: -5 }]
  });
  assert.equal(occasional.status, 400);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 0);
});

test('occasional quantities keep their unit price and updates validate it', async () => {
  const created = await server.request('POST', '/api/expenses/occasional', {
    date: '2026-01-05', category: 'Repair', typeId: 'type-occasional', amount: 400,
    quantities: [{ quantityCategoryId: 'onspot:x', name: 'Bolts', unit: 'Count', amount: 4, unitPrice: 25 }]
  });
  assert.equal(created.status, 201);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES)[0][9], 25);
  const id = created.body.data.id;
  const bad = await server.request('PUT', `/api/expenses/occasional/${id}`, {
    date: '2026-01-05', category: 'Repair', typeId: 'type-occasional', amount: 400,
    quantities: [{ quantityCategoryId: 'onspot:x', name: 'Bolts', unit: 'Count', amount: 4, unitPrice: 'free' }]
  });
  assert.equal(bad.status, 400);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES)[0][9], 25);
  const good = await server.request('PUT', `/api/expenses/occasional/${id}`, {
    date: '2026-01-05', category: 'Repair', typeId: 'type-occasional', amount: 400,
    quantities: [{ quantityCategoryId: 'onspot:x', name: 'Bolts', unit: 'Count', amount: 4, unitPrice: 30 }]
  });
  assert.equal(good.status, 200);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES)[0][9], 30);
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

test('bulk save persists a zero-amount entry when it carries quantities', async () => {
  const res = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 0, typeId: 'type-cash', quantities: [
      { quantityCategoryId: 'qcat-milk', name: 'Milk', unit: 'Litre', amount: 5 }
    ] }]
  });

  assert.equal(res.status, 200);
  const expenseRows = sheets.getRows(SHEETS.EXPENSES);
  assert.equal(expenseRows.length, 1);
  assert.equal(expenseRows[0][2], 'Milk');
  assert.equal(parseFloat(expenseRows[0][4]), 0);
  const quantityRows = sheets.getRows(SHEETS.EXPENSE_QUANTITIES);
  assert.equal(quantityRows.length, 1);
  assert.equal(parseFloat(quantityRows[0][5]), 5);
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

test('rejecting a missing category type records a placeholder that survives until the type is resubmitted', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'exp-milk', category: 'Milk', approvalStatus: 'Approved' })]);
  server.loginAs(SUPERUSER);

  const rejected = await server.request('POST', '/api/expenses/reject/2026-01-05', {
    reason: 'Owner draw is missing.', missingTypeIds: ['type-limited']
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.updated, 1);
  const afterReject = sheets.getRows(SHEETS.EXPENSES);
  assert.equal(afterReject.length, 2);
  const placeholder = afterReject.find(row => row[13] === 'type-limited');
  assert.ok(placeholder, 'a placeholder row is added for the missing type');
  assert.equal(placeholder[2], '');
  assert.equal(Number(placeholder[4]), 0);
  assert.equal(placeholder[8], 'Rejected');

  // Duplicate reject on the same missing type does not add another placeholder.
  const rejectedAgain = await server.request('POST', '/api/expenses/reject/2026-01-05', {
    reason: 'still missing', missingTypeIds: ['type-limited']
  });
  assert.equal(rejectedAgain.body.data.updated, 0);
  assert.equal(sheets.getRows(SHEETS.EXPENSES).length, 2);

  // Cashier saves an unrelated on-spot entry — the placeholder is preserved because the missing type is still unaddressed.
  server.loginAs(CASHIER);
  const partial = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [{ category: 'Auto fare', amount: 80, typeId: 'type-cash', onSpot: true }]
  });
  assert.equal(partial.status, 200);
  assert.ok(sheets.getRows(SHEETS.EXPENSES).some(row => row[13] === 'type-limited' && row[8] === 'Rejected'));

  // Superuser submits the previously-missing type — placeholder is removed and the new entry is recorded.
  server.loginAs(SUPERUSER);
  const resubmit = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05', entries: [
      { category: 'Auto fare', amount: 80, typeId: 'type-cash', onSpot: true },
      { category: 'Owner Draw', amount: 400, typeId: 'type-limited' }
    ]
  });
  assert.equal(resubmit.status, 200);
  const finalRows = sheets.getRows(SHEETS.EXPENSES);
  assert.ok(!finalRows.some(row => row[2] === '' && row[8] === 'Rejected'), 'placeholder is removed');
  assert.ok(finalRows.some(row => row[2] === 'Owner Draw' && row[13] === 'type-limited'));
});

test('reject rejects the request when nothing is selected', async () => {
  sheets.setRows(SHEETS.EXPENSES, [expenseRow({ id: 'exp-milk', approvalStatus: 'Approved' })]);
  server.loginAs(SUPERUSER);
  const res = await server.request('POST', '/api/expenses/reject/2026-01-05', { reason: 'x' });
  assert.equal(res.status, 400);
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

test('unpaid receipt CRUD writes the header row and line items', async () => {
  const created = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 500, remarks: 'Vendor A',
    items: [
      { name: 'Volume', unit: 'Litre', amount: 8 },
      { name: 'Bottles', unit: 'Count', amount: 4 }
    ]
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.ok(id);
  assert.equal(created.body.data.items.length, 2);

  const listed = await server.request('GET', '/api/expenses/unpaid');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].totalAmount, 500);
  assert.equal(listed.body.data[0].items.length, 2);

  const updated = await server.request('PUT', `/api/expenses/unpaid/${id}`, {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 600, remarks: 'Vendor A (revised)',
    items: [{ name: 'Volume', unit: 'Litre', amount: 10 }]
  });
  assert.equal(updated.status, 200);
  assert.equal(sheets.getRows(SHEETS.UNPAID_RECEIPTS)[0][6], 600);
  assert.equal(sheets.getRows(SHEETS.UNPAID_RECEIPT_ITEMS).length, 1);

  const deleted = await server.request('DELETE', `/api/expenses/unpaid/${id}`);
  assert.equal(deleted.status, 200);
  assert.equal(sheets.getRows(SHEETS.UNPAID_RECEIPTS).length, 0);
  assert.equal(sheets.getRows(SHEETS.UNPAID_RECEIPT_ITEMS).length, 0);
});

test('unpaid receipt POST refuses a category type the user cannot access', async () => {
  const denied = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-limited', category: 'Owner Draw',
    totalAmount: 100, items: [{ name: 'Volume', unit: 'Count', amount: 1 }]
  });
  assert.equal(denied.status, 403);
});

test('bulk save linking the full payable keeps the receipt (settled) and records all items on the expense', async () => {
  const created = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 400,
    items: [
      { name: 'Volume', unit: 'Litre', amount: 8 },
      { name: 'Bottles', unit: 'Count', amount: 4 }
    ]
  });
  const unpaidId = created.body.data.id;

  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{
      category: 'Milk', amount: 400, typeId: 'type-cash',
      linkedUnpaid: [{ unpaidId, amount: 400 }]
    }]
  });
  assert.equal(saved.status, 200);
  const receipts = sheets.getRows(SHEETS.UNPAID_RECEIPTS);
  assert.equal(receipts.length, 1);
  assert.equal(Number(receipts[0][9]), 400);
  assert.equal(sheets.getRows(SHEETS.UNPAID_RECEIPT_ITEMS).length, 2);
  assert.equal(sheets.getRows(SHEETS.RECEIPT_PAYMENTS).length, 1);
  const quantityRows = sheets.getRows(SHEETS.EXPENSE_QUANTITIES);
  assert.equal(quantityRows.length, 2);
  assert.equal(quantityRows.every(row => row[8] === unpaidId), true);
  // The list endpoint hides the receipt once balance reaches zero.
  const listed = await server.request('GET', '/api/expenses/unpaid');
  assert.equal(listed.body.data.length, 0);
});

test('bulk save partial payment increments PaidAmount without writing expense quantities', async () => {
  const created = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 500,
    items: [
      { name: 'Volume', unit: 'Litre', amount: 10 },
      { name: 'Bottles', unit: 'Count', amount: 5 }
    ]
  });
  const unpaidId = created.body.data.id;

  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{
      category: 'Milk', amount: 300, typeId: 'type-cash',
      linkedUnpaid: [{ unpaidId, amount: 300 }]
    }]
  });
  assert.equal(saved.status, 200);
  const remainingReceipts = sheets.getRows(SHEETS.UNPAID_RECEIPTS);
  assert.equal(remainingReceipts.length, 1);
  assert.equal(Number(remainingReceipts[0][6]), 500);
  assert.equal(Number(remainingReceipts[0][9]), 300);
  const remainingItems = sheets.getRows(SHEETS.UNPAID_RECEIPT_ITEMS);
  assert.equal(remainingItems.length, 2);
  assert.equal(Number(remainingItems.find(row => row[3] === 'Volume')[5]), 10);
  assert.equal(Number(remainingItems.find(row => row[3] === 'Bottles')[5]), 5);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES).length, 0);
  assert.equal(sheets.getRows(SHEETS.RECEIPT_PAYMENTS).length, 1);
});

test('bulk save that finishes the balance transfers every item to the settling expense', async () => {
  const created = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 500,
    items: [
      { name: 'Volume', unit: 'Litre', amount: 10 },
      { name: 'Bottles', unit: 'Count', amount: 5 }
    ]
  });
  const unpaidId = created.body.data.id;

  await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 300, typeId: 'type-cash', linkedUnpaid: [{ unpaidId, amount: 300 }] }]
  });
  const final = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-06',
    entries: [{ category: 'Milk', amount: 200, typeId: 'type-cash', linkedUnpaid: [{ unpaidId, amount: 200 }] }]
  });
  assert.equal(final.status, 200);
  const receipts = sheets.getRows(SHEETS.UNPAID_RECEIPTS);
  assert.equal(receipts.length, 1);
  assert.equal(Number(receipts[0][9]), 500);
  assert.equal(sheets.getRows(SHEETS.RECEIPT_PAYMENTS).length, 2);
  const quantityRows = sheets.getRows(SHEETS.EXPENSE_QUANTITIES);
  assert.equal(quantityRows.length, 2);
  assert.equal(Number(quantityRows.find(row => row[3] === 'Volume')[5]), 10);
  assert.equal(Number(quantityRows.find(row => row[3] === 'Bottles')[5]), 5);
});

test('a receipt can be linked to multiple expenses in one save and payment history is exposed', async () => {
  const created = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 500,
    items: [{ name: 'Volume', unit: 'Litre', amount: 10 }]
  });
  const unpaidId = created.body.data.id;

  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [
      { category: 'Milk', amount: 300, typeId: 'type-cash', linkedUnpaid: [{ unpaidId, amount: 300 }] },
      { category: 'Auto fare', amount: 200, typeId: 'type-cash', onSpot: true, linkedUnpaid: [{ unpaidId, amount: 200 }] }
    ]
  });
  assert.equal(saved.status, 200);
  const receipts = sheets.getRows(SHEETS.UNPAID_RECEIPTS);
  assert.equal(Number(receipts[0][9]), 500);
  assert.equal(sheets.getRows(SHEETS.RECEIPT_PAYMENTS).length, 2);
  const listed = await server.request('GET', '/api/expenses/unpaid');
  assert.equal(listed.body.data.length, 0);
});

test('GET unpaid returns payment history for each active receipt', async () => {
  const created = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 500, items: [{ name: 'Volume', unit: 'Litre', amount: 10 }]
  });
  const unpaidId = created.body.data.id;
  await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 200, typeId: 'type-cash', linkedUnpaid: [{ unpaidId, amount: 200 }] }]
  });
  const listed = await server.request('GET', '/api/expenses/unpaid');
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].payments.length, 1);
  assert.equal(listed.body.data[0].payments[0].amount, 200);
  assert.ok(listed.body.data[0].payments[0].expenseId);
});

test('GET unpaid?includeSettled=1 keeps settled receipts and their payment history visible', async () => {
  const created = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 300, items: [{ name: 'Volume', unit: 'Litre', amount: 5 }]
  });
  const unpaidId = created.body.data.id;
  await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-06',
    entries: [{ category: 'Milk', amount: 300, typeId: 'type-cash', linkedUnpaid: [{ unpaidId, amount: 300 }] }]
  });
  const openOnly = await server.request('GET', '/api/expenses/unpaid');
  assert.equal(openOnly.body.data.length, 0);
  const withSettled = await server.request('GET', '/api/expenses/unpaid?includeSettled=1');
  assert.equal(withSettled.body.data.length, 1);
  assert.equal(withSettled.body.data[0].receivedDate, '2026-01-05');
  assert.equal(withSettled.body.data[0].paidAmount, 300);
  assert.equal(withSettled.body.data[0].payments.length, 1);
});

test('unlinking a receivable from a pending expense restores the balance and removes the linked quantities', async () => {
  const created = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 500,
    items: [{ name: 'Volume', unit: 'Litre', amount: 10 }]
  });
  const unpaidId = created.body.data.id;
  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 500, typeId: 'type-cash', linkedUnpaid: [{ unpaidId, amount: 500 }] }]
  });
  assert.equal(saved.status, 200);
  const expenseId = saved.body.data[0].id;
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES).length, 1);

  const unlinked = await server.request('DELETE', `/api/expenses/${expenseId}/unpaid-link/${unpaidId}`);
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.body.data.reversedAmount, 500);
  const receipts = sheets.getRows(SHEETS.UNPAID_RECEIPTS);
  assert.equal(Number(receipts[0][9]), 0);
  assert.equal(sheets.getRows(SHEETS.RECEIPT_PAYMENTS).length, 0);
  assert.equal(sheets.getRows(SHEETS.EXPENSE_QUANTITIES).length, 0);
  const listed = await server.request('GET', '/api/expenses/unpaid');
  assert.equal(listed.body.data.length, 1);
});

test('unlinking a receivable is blocked once the expense is approved', async () => {
  const created = await server.request('POST', '/api/expenses/unpaid', {
    receivedDate: '2026-01-05', typeId: 'type-cash', category: 'Milk',
    totalAmount: 200, items: [{ name: 'Volume', unit: 'Litre', amount: 4 }]
  });
  const unpaidId = created.body.data.id;
  const saved = await server.request('POST', '/api/expenses/bulk', {
    date: '2026-01-05',
    entries: [{ category: 'Milk', amount: 200, typeId: 'type-cash', linkedUnpaid: [{ unpaidId, amount: 200 }] }]
  });
  const expenseId = saved.body.data[0].id;
  server.loginAs(SUPERUSER);
  await server.request('POST', `/api/expenses/approve/2026-01-05`);
  const denied = await server.request('DELETE', `/api/expenses/${expenseId}/unpaid-link/${unpaidId}`);
  assert.equal(denied.status, 409);
});
