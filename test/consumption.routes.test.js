const test = require('node:test');
const assert = require('node:assert/strict');

const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();

const { startTestServer } = require('./helpers/test-server');
const consumptionRouter = require('../routes/consumption');

const CASHIER = { id: 'user-cashier', username: 'cashier', displayName: 'Cashier', role: 'cashier' };
const SUPERUSER = { id: 'user-super', username: 'admin', displayName: 'Admin', role: 'superuser' };

// ExpenseQuantityCategories: ID, CategoryID, Name, Unit, SortOrder, Status, AutoConsume
const QUANTITY_CATEGORIES = [
  ['qcat-chicken', 'cat-food', 'Chicken', 'KG', 1, 'Active', ''],
  ['qcat-milk', 'cat-food', 'Milk', 'Litre', 2, 'Active', ''],
  ['qcat-onion', 'cat-food', 'Onion', 'KG', 3, 'Active', ''],
  ['qcat-veg', 'cat-food', 'Vegetables', 'KG', 4, 'Active', 'TRUE']
];

function businessToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const TODAY = businessToday();
const server = startTestServer('/api/consumption', consumptionRouter);

// Expenses row is 20 wide (indexes 0..19). We only need ID + Date so pad the rest.
function expenseRow(id, date) {
  const row = new Array(20).fill('');
  row[0] = id;
  row[1] = date;
  return row;
}

// UnpaidReceipts row is 10 wide.
function receiptRow(id, receivedDate) {
  const row = new Array(10).fill('');
  row[0] = id;
  row[1] = receivedDate;
  return row;
}

// ExpenseQuantities: ID, ExpenseID, QuantityCategoryID, QuantityName, Unit, Amount, CreatedAt, UpdatedAt, SourceReceiptID
function paidRow(id, expenseId, quantityCategoryId, name, unit, amount) {
  return [id, expenseId, quantityCategoryId, name, unit, amount, '', '', ''];
}
// UnpaidReceiptItems: ID, ReceiptID, QuantityCategoryID, QuantityName, Unit, Amount, CreatedAt, UpdatedAt
function unpaidRow(id, receiptId, quantityCategoryId, name, unit, amount) {
  return [id, receiptId, quantityCategoryId, name, unit, amount, '', ''];
}

test.beforeEach(() => {
  sheets.reset();
  sheets.setRows(SHEETS.EXPENSE_QUANTITY_CATEGORIES, QUANTITY_CATEGORIES);
  // Incoming: chicken 5 kg (paid, dated 2020-01-01) + 3 kg (unpaid, dated 2020-01-01); milk 20 L (paid); onion 10 kg (unpaid).
  sheets.setRows(SHEETS.EXPENSES, [expenseRow('exp-1', '2020-01-01'), expenseRow('exp-2', '2020-01-01')]);
  sheets.setRows(SHEETS.UNPAID_RECEIPTS, [receiptRow('rcpt-1', '2020-01-01')]);
  sheets.setRows(SHEETS.EXPENSE_QUANTITIES, [
    paidRow('eq-1', 'exp-1', 'qcat-chicken', 'Chicken', 'KG', 5),
    paidRow('eq-2', 'exp-2', 'qcat-milk', 'Milk', 'Litre', 20)
  ]);
  sheets.setRows(SHEETS.UNPAID_RECEIPT_ITEMS, [
    unpaidRow('ri-1', 'rcpt-1', 'qcat-chicken', 'Chicken', 'KG', 3),
    unpaidRow('ri-2', 'rcpt-1', 'qcat-onion', 'Onion', 'KG', 10)
  ]);
  sheets.setRows(SHEETS.QUANTITY_CONSUMPTIONS, []);
  server.loginAs(CASHIER);
});

test.after(() => server.close());

test('rejects unauthenticated requests', async () => {
  server.logout();
  assert.equal((await server.request('GET', '/api/consumption')).status, 401);
  assert.equal((await server.request('GET', '/api/consumption/stock')).status, 401);
  assert.equal((await server.request('GET', '/api/consumption/preview?date=2026-01-01&quantityCategoryId=qcat-chicken')).status, 401);
  assert.equal((await server.request('POST', '/api/consumption', {})).status, 401);
});

test('stock returns full incoming when no observation exists', async () => {
  const res = await server.request('GET', '/api/consumption/stock');
  assert.equal(res.status, 200);
  const chicken = res.body.data.find(row => row.quantityCategoryId === 'qcat-chicken');
  assert.equal(chicken.incoming, 8);
  assert.equal(chicken.incomingPaid, 5);
  assert.equal(chicken.incomingUnpaid, 3);
  assert.equal(chicken.consumed, 0);
  assert.equal(chicken.remaining, 8);
  assert.equal(chicken.lastObservation, null);
});

test('preview reports incoming since prior observation', async () => {
  const res = await server.request('GET', '/api/consumption/preview?date=' + TODAY + '&quantityCategoryId=qcat-chicken');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.priorEntry, null);
  assert.equal(res.body.data.priorAvailable, 0);
  assert.equal(res.body.data.incomingSincePrior, 8);
  assert.equal(res.body.data.availableBeforeEntry, 8);
});

test('recording available stock derives usedAmount from the difference', async () => {
  const post = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: 5, remarks: 'lunch prep'
  });
  assert.equal(post.status, 201);
  assert.equal(post.body.data.availableStock, 5);
  assert.equal(post.body.data.usedAmount, 3);

  const stock = await server.request('GET', '/api/consumption/stock');
  const chicken = stock.body.data.find(row => row.quantityCategoryId === 'qcat-chicken');
  assert.equal(chicken.consumed, 3);
  assert.equal(chicken.remaining, 5);
  assert.equal(chicken.lastObservation.availableStock, 5);
});

test('rejects reported stock higher than available unless override is set', async () => {
  const block = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-milk', availableStock: 25
  });
  assert.equal(block.status, 409);
  assert.equal(block.body.code, 'STOCK_ANOMALY_HIGH');
  assert.equal(sheets.getRows(SHEETS.QUANTITY_CONSUMPTIONS).length, 0);

  const forced = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-milk', availableStock: 25, allowAnomaly: true
  });
  assert.equal(forced.status, 201);
  // usedAmount goes negative (anomaly) — the system just records it and moves on.
  assert.equal(forced.body.data.usedAmount, -5);
  assert.equal(sheets.getRows(SHEETS.QUANTITY_CONSUMPTIONS).length, 1);
});

test('requires the payload fields and an existing quantity', async () => {
  assert.equal((await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken'
  })).status, 400);
  assert.equal((await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: 'abc'
  })).status, 400);
  assert.equal((await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-missing', availableStock: 1
  })).status, 404);
});

test('rejects negative available stock (over-consumption) unless override is set', async () => {
  const block = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: -1
  });
  assert.equal(block.status, 409);
  assert.equal(block.body.code, 'STOCK_ANOMALY_OVERCONSUMED');

  const forced = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: -1, allowAnomaly: true
  });
  assert.equal(forced.status, 201);
  assert.equal(forced.body.data.availableStock, -1);
  assert.equal(forced.body.data.usedAmount, 9);
});

test('recording zero available stock is treated as over-consumption and requires override', async () => {
  const blocked = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: 0
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'STOCK_ANOMALY_OVERCONSUMED');

  const forced = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: 0, allowAnomaly: true
  });
  assert.equal(forced.status, 201);
  assert.equal(forced.body.data.usedAmount, 8);
});

test('multiple observations chain — used per period reflects the drop', async () => {
  server.loginAs(SUPERUSER);
  const first = await server.request('POST', '/api/consumption', {
    date: '2026-01-01', quantityCategoryId: 'qcat-chicken', availableStock: 6
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.usedAmount, 2); // 8 available, observed 6 → 2 used

  const second = await server.request('POST', '/api/consumption', {
    date: '2026-01-02', quantityCategoryId: 'qcat-chicken', availableStock: 4
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.data.usedAmount, 2); // dropped from 6 to 4

  const list = await server.request('GET', '/api/consumption?quantityCategoryId=qcat-chicken');
  assert.equal(list.body.data.length, 2);
  const totalUsed = list.body.data.reduce((sum, entry) => sum + entry.usedAmount, 0);
  assert.equal(totalUsed, 4);

  const stockRes = await server.request('GET', '/api/consumption/stock');
  const chicken = stockRes.body.data.find(row => row.quantityCategoryId === 'qcat-chicken');
  assert.equal(chicken.remaining, 4);
  assert.equal(chicken.consumed, 4);
});

test('cashier can only record today; superuser can backdate', async () => {
  const cashier = await server.request('POST', '/api/consumption', {
    date: '2020-06-01', quantityCategoryId: 'qcat-chicken', availableStock: 5
  });
  assert.equal(cashier.status, 400);

  server.loginAs(SUPERUSER);
  const admin = await server.request('POST', '/api/consumption', {
    date: '2020-06-01', quantityCategoryId: 'qcat-chicken', availableStock: 5
  });
  assert.equal(admin.status, 201);
});

test('rejects future-dated entries even for superuser', async () => {
  server.loginAs(SUPERUSER);
  const res = await server.request('POST', '/api/consumption', {
    date: '2099-01-01', quantityCategoryId: 'qcat-chicken', availableStock: 1
  });
  assert.equal(res.status, 400);
});

test('list filters by date range and quantity', async () => {
  server.loginAs(SUPERUSER);
  await server.request('POST', '/api/consumption', {
    date: '2026-01-05', quantityCategoryId: 'qcat-chicken', availableStock: 7
  });
  await server.request('POST', '/api/consumption', {
    date: '2026-02-10', quantityCategoryId: 'qcat-milk', availableStock: 18
  });
  await server.request('POST', '/api/consumption', {
    date: '2026-02-11', quantityCategoryId: 'qcat-chicken', availableStock: 6
  });

  const january = await server.request('GET', '/api/consumption?startDate=2026-01-01&endDate=2026-01-31');
  assert.equal(january.body.data.length, 1);

  const chickenOnly = await server.request('GET', '/api/consumption?quantityCategoryId=qcat-chicken');
  assert.equal(chickenOnly.body.data.length, 2);
});

test('only superuser can edit or delete entries', async () => {
  server.loginAs(SUPERUSER);
  const post = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: 6
  });
  const id = post.body.data.id;

  server.loginAs(CASHIER);
  const editBlocked = await server.request('PUT', `/api/consumption/${id}`, { availableStock: 5 });
  assert.equal(editBlocked.status, 403);
  const deleteBlocked = await server.request('DELETE', `/api/consumption/${id}`);
  assert.equal(deleteBlocked.status, 403);

  server.loginAs(SUPERUSER);
  const editOk = await server.request('PUT', `/api/consumption/${id}`, { availableStock: 4, remarks: 'adjusted' });
  assert.equal(editOk.status, 200);
  assert.equal(editOk.body.data.availableStock, 4);
  assert.equal(editOk.body.data.usedAmount, 4);
  const deleteOk = await server.request('DELETE', `/api/consumption/${id}`);
  assert.equal(deleteOk.status, 200);
  assert.equal(sheets.getRows(SHEETS.QUANTITY_CONSUMPTIONS).length, 0);
});

test('edits exclude the current entry when checking prior availability', async () => {
  server.loginAs(SUPERUSER);
  const post = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: 3
  });
  const id = post.body.data.id;
  // Without excluding self, availableBefore would be 3 (the previous entry). With exclusion it goes back to 8.
  const update = await server.request('PUT', `/api/consumption/${id}`, { availableStock: 7 });
  assert.equal(update.status, 200);
  assert.equal(update.body.data.usedAmount, 1);
});

test('incoming that arrives after the last observation shows up in remaining', async () => {
  server.loginAs(SUPERUSER);
  await server.request('POST', '/api/consumption', {
    date: '2026-01-01', quantityCategoryId: 'qcat-onion', availableStock: 2
  });

  sheets.setRows(SHEETS.EXPENSES, [
    ...sheets.getRows(SHEETS.EXPENSES), expenseRow('exp-3', '2026-02-01')
  ]);
  sheets.setRows(SHEETS.EXPENSE_QUANTITIES, [
    ...sheets.getRows(SHEETS.EXPENSE_QUANTITIES),
    paidRow('eq-3', 'exp-3', 'qcat-onion', 'Onion', 'KG', 5)
  ]);

  const stockRes = await server.request('GET', '/api/consumption/stock');
  const onion = stockRes.body.data.find(row => row.quantityCategoryId === 'qcat-onion');
  // Prior observation was 2 kg; 5 kg arrived after → remaining should be 7 kg.
  assert.equal(onion.incoming, 15);
  assert.equal(onion.remaining, 7);
  assert.equal(onion.consumed, 8);
});

// Same-day POSTs now overwrite each other so the sheet keeps a single row per (date, quantity).
test('a second same-day POST updates the existing row instead of appending', async () => {
  server.loginAs(SUPERUSER);
  const first = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: 6
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.usedAmount, 2);
  const firstId = first.body.data.id;

  const preview = await server.request('GET',
    `/api/consumption/preview?date=${TODAY}&quantityCategoryId=qcat-chicken`);
  // Available before the same-day update must equal current remaining = incoming(8) − consumed(2) = 6.
  assert.equal(preview.body.data.availableBeforeEntry, 6);
  assert.equal(preview.body.data.priorAvailable, 6);

  const stock = await server.request('GET', '/api/consumption/stock');
  const chicken = stock.body.data.find(row => row.quantityCategoryId === 'qcat-chicken');
  assert.equal(chicken.remaining, 6);

  // Second same-day POST → status 200, same row updated, availableStock=4 → derived used=8−4=4.
  const second = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-chicken', availableStock: 4
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.replacedExisting, true);
  assert.equal(second.body.data.id, firstId);
  assert.equal(second.body.data.usedAmount, 4);

  // Only one row per (date, quantity) is stored.
  const rows = sheets.getRows(SHEETS.QUANTITY_CONSUMPTIONS)
    .filter(row => row[1] === TODAY && row[2] === 'qcat-chicken');
  assert.equal(rows.length, 1);
});

// Regression: adding incoming stock AFTER a prior observation (same-day or backdated) must add straight
// to available. Storing usedAmount (delta) instead of availableStock (snapshot) is what makes this work.
test('new incoming added after an observation increases available stock (incoming − consumed)', async () => {
  // Post an observation: milk incoming 20 → available 10 (used 10).
  const post = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-milk', availableStock: 10
  });
  assert.equal(post.status, 201);
  assert.equal(post.body.data.usedAmount, 10);

  // Now an extra 5 L of milk gets received the SAME day (as a new paid quantity).
  sheets.setRows(SHEETS.EXPENSES, [
    ...sheets.getRows(SHEETS.EXPENSES), expenseRow('exp-milk-later', TODAY)
  ]);
  sheets.setRows(SHEETS.EXPENSE_QUANTITIES, [
    ...sheets.getRows(SHEETS.EXPENSE_QUANTITIES),
    paidRow('eq-milk-later', 'exp-milk-later', 'qcat-milk', 'Milk', 'Litre', 5)
  ]);

  const stock = await server.request('GET', '/api/consumption/stock');
  const milk = stock.body.data.find(row => row.quantityCategoryId === 'qcat-milk');
  // Total incoming = 25, consumed stays 10, so available = 15 (was 10 before the new incoming).
  assert.equal(milk.incoming, 25);
  assert.equal(milk.consumed, 10);
  assert.equal(milk.remaining, 15);

  // Preview for a new entry today confirms the same number.
  const preview = await server.request('GET',
    `/api/consumption/preview?date=${TODAY}&quantityCategoryId=qcat-milk`);
  assert.equal(preview.body.data.availableBeforeEntry, 15);
});

// Auto-consume categories skip the observation flow — every incoming is treated as fully consumed.
test('auto-consume quantities report consumed == incoming and remaining == 0', async () => {
  sheets.setRows(SHEETS.EXPENSES, [
    ...sheets.getRows(SHEETS.EXPENSES), expenseRow('exp-veg', '2020-01-01')
  ]);
  sheets.setRows(SHEETS.EXPENSE_QUANTITIES, [
    ...sheets.getRows(SHEETS.EXPENSE_QUANTITIES),
    paidRow('eq-veg', 'exp-veg', 'qcat-veg', 'Vegetables', 'KG', 7)
  ]);

  const stock = await server.request('GET', '/api/consumption/stock');
  const veg = stock.body.data.find(row => row.quantityCategoryId === 'qcat-veg');
  assert.equal(veg.autoConsume, true);
  assert.equal(veg.incoming, 7);
  assert.equal(veg.consumed, 7);
  assert.equal(veg.remaining, 0);
});

test('recording an observation for an auto-consume quantity is rejected', async () => {
  const res = await server.request('POST', '/api/consumption', {
    date: TODAY, quantityCategoryId: 'qcat-veg', availableStock: 3
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'AUTO_CONSUME');
});

// When an existing ExpenseQuantities row is edited (amount changed), /stock must reflect the new incoming.
test('editing an expense quantity is reflected in the next /stock read', async () => {
  const initial = await server.request('GET', '/api/consumption/stock');
  const chickenBefore = initial.body.data.find(row => row.quantityCategoryId === 'qcat-chicken');
  assert.equal(chickenBefore.incoming, 8);

  // Simulate an edit: the paid chicken row goes from 5 kg to 9 kg.
  const rows = sheets.getRows(SHEETS.EXPENSE_QUANTITIES);
  const index = rows.findIndex(row => row[0] === 'eq-1');
  rows[index] = paidRow('eq-1', 'exp-1', 'qcat-chicken', 'Chicken', 'KG', 9);
  sheets.setRows(SHEETS.EXPENSE_QUANTITIES, rows);

  const after = await server.request('GET', '/api/consumption/stock');
  const chickenAfter = after.body.data.find(row => row.quantityCategoryId === 'qcat-chicken');
  assert.equal(chickenAfter.incoming, 12);
  assert.equal(chickenAfter.remaining, 12);
});