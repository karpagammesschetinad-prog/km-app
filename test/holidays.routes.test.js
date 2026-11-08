const test = require('node:test');
const assert = require('node:assert/strict');
const { installSheetsStub, SHEETS } = require('./helpers/sheets-stub');
const sheets = installSheetsStub();
let failNextWrite = false;
const appendRow = sheets.appendRow;
sheets.appendRow = async (...args) => {
  if (failNextWrite) {
    failNextWrite = false;
    throw new Error('Stub write failed');
  }
  return appendRow(...args);
};
// The main integration supplies this constant; keep this isolated test usable before it lands.
SHEETS.RESTAURANT_HOLIDAYS = 'RestaurantHolidays';
const { startTestServer } = require('./helpers/test-server');
const router = require('../routes/holidays');
const { holidayRowToObj, holidayLeaveRecords, getRestaurantHolidayLeaves } = require('../services/restaurantHolidays');

const ADMIN = { id: 'admin', displayName: 'Admin', role: 'superuser' };
const CASHIER = { id: 'cashier', displayName: 'Cashier', role: 'cashier' };
const server = startTestServer('/api/holidays', router);
const payload = (startDate = '2026-11-09', endDate = startDate, reason = 'Restaurant closed') => ({ startDate, endDate, reason });
const holidayRow = (id, start, end = start) => [id, start, end, 'Festival', 'Creator', '2026-01-01T00:00:00.000Z', '', ''];

test.beforeEach(() => {
  sheets.reset();
  failNextWrite = false;
  server.loginAs(ADMIN);
});
test.after(() => server.close());

test('all endpoints require authentication', async () => {
  server.logout();
  for (const [method, path, body] of [
    ['GET', '/api/holidays'], ['POST', '/api/holidays', payload()],
    ['PUT', '/api/holidays/missing', payload()], ['DELETE', '/api/holidays/missing']
  ]) assert.equal((await server.request(method, path, body)).status, 401);
});

test('cashier can GET holidays latest-first but cannot manage them', async () => {
  sheets.setRows(SHEETS.RESTAURANT_HOLIDAYS, [holidayRow('old', '2025-01-01'), holidayRow('new', '2099-01-01')]);
  server.loginAs(CASHIER);
  const list = await server.request('GET', '/api/holidays');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map(item => item.id), ['new', 'old']);
  assert.equal((await server.request('POST', '/api/holidays', payload())).status, 403);
  assert.equal((await server.request('PUT', '/api/holidays/old', payload())).status, 403);
  assert.equal((await server.request('DELETE', '/api/holidays/old')).status, 403);
  assert.equal(sheets.getRows(SHEETS.RESTAURANT_HOLIDAYS).length, 2);
});

test('CRUD allows future dates, trims reason and preserves creation audit on edits', async () => {
  const created = await server.request('POST', '/api/holidays', payload('2099-12-30', '2099-12-31', '  Festival  '));
  assert.equal(created.status, 201);
  assert.equal(created.body.data.reason, 'Festival');
  assert.equal(created.body.data.createdBy, 'Admin');
  assert.ok(Number.isFinite(Date.parse(created.body.data.createdAt)));
  assert.equal(created.body.data.updatedAt, '');
  const id = created.body.data.id;
  server.loginAs({ ...ADMIN, displayName: 'Editor' });
  const edited = await server.request('PUT', '/api/holidays/' + id, payload('2099-12-30', '2099-12-31', 'Maintenance'));
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.id, id);
  assert.equal(edited.body.data.createdBy, 'Admin');
  assert.equal(edited.body.data.createdAt, created.body.data.createdAt);
  assert.equal(edited.body.data.updatedBy, 'Editor');
  assert.ok(Number.isFinite(Date.parse(edited.body.data.updatedAt)));
  assert.deepEqual((await server.request('GET', '/api/holidays')).body.data, [edited.body.data]);
  assert.equal((await server.request('DELETE', '/api/holidays/' + id)).status, 200);
  assert.deepEqual(sheets.getRows(SHEETS.RESTAURANT_HOLIDAYS), []);
  assert.equal((await server.request('PUT', '/api/holidays/' + id, payload())).status, 404);
  assert.equal((await server.request('DELETE', '/api/holidays/' + id)).status, 404);
});

test('rejects impossible, malformed and reversed ISO ranges', async () => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00',
    '2026-1-01', '2026-01-01T00:00', '', null, 20260101]) {
    assert.equal((await server.request('POST', '/api/holidays', payload(date, '2026-12-31'))).status, 400);
    assert.equal((await server.request('POST', '/api/holidays', payload('2026-01-01', date))).status, 400);
  }
  assert.equal((await server.request('POST', '/api/holidays', payload('2026-11-10', '2026-11-09'))).status, 400);
  assert.deepEqual(sheets.getRows(SHEETS.RESTAURANT_HOLIDAYS), []);
});

test('requires a string reason of at most 200 trimmed characters', async () => {
  for (const reason of [undefined, null, '', '   ', 123, {}, 'x'.repeat(201)]) {
    assert.equal((await server.request('POST', '/api/holidays', { startDate: '2026-11-09', endDate: '2026-11-09', reason })).status, 400);
  }
  assert.equal((await server.request('POST', '/api/holidays', payload('2026-11-09', '2026-11-09', 'x'.repeat(200)))).status, 201);
});

test('allows real leap dates and at most 366 inclusive days', async () => {
  assert.equal((await server.request('POST', '/api/holidays', payload('2024-01-01', '2024-12-31'))).status, 201);
  assert.equal((await server.request('POST', '/api/holidays', payload('2028-02-29'))).status, 201);
  assert.equal((await server.request('POST', '/api/holidays', payload('2032-01-01', '2033-01-01'))).status, 400);
});

test('rejects overlap including endpoints and containment but allows adjacent ranges', async () => {
  sheets.setRows(SHEETS.RESTAURANT_HOLIDAYS, [holidayRow('existing', '2026-11-10', '2026-11-12')]);
  for (const [start, end] of [['2026-11-09', '2026-11-10'], ['2026-11-12', '2026-11-13'],
    ['2026-11-11', '2026-11-11'], ['2026-11-09', '2026-11-13'], ['2026-11-10', '2026-11-12']]) {
    assert.equal((await server.request('POST', '/api/holidays', payload(start, end))).status, 409);
  }
  assert.equal((await server.request('POST', '/api/holidays', payload('2026-11-09'))).status, 201);
  assert.equal((await server.request('POST', '/api/holidays', payload('2026-11-13'))).status, 201);
});

test('editing ignores self but still validates dates, reason, duration and other holidays', async () => {
  const original = holidayRow('first', '2026-11-10', '2026-11-12');
  sheets.setRows(SHEETS.RESTAURANT_HOLIDAYS, [original, holidayRow('second', '2026-11-14')]);
  for (const [body, status] of [
    [payload('2026-11-10', '2026-11-14'), 409], [payload('2026-02-30'), 400],
    [payload('2026-11-10', '2026-11-12', ''), 400], [payload('2026-01-01', '2028-01-01'), 400]
  ]) assert.equal((await server.request('PUT', '/api/holidays/first', body)).status, status);
  assert.deepEqual(sheets.getRows(SHEETS.RESTAURANT_HOLIDAYS)[0], original);
  assert.equal((await server.request('PUT', '/api/holidays/first', payload('2026-11-10', '2026-11-12'))).status, 200);
});

test('concurrent overlapping creations serialize the complete read/write sequence', async () => {
  const results = await Promise.all([
    server.request('POST', '/api/holidays', payload('2026-11-10', '2026-11-12')),
    server.request('POST', '/api/holidays', payload('2026-11-12', '2026-11-14'))
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(sheets.getRows(SHEETS.RESTAURANT_HOLIDAYS).length, 1);
});

test('concurrent updates cannot create overlapping ranges', async () => {
  sheets.setRows(SHEETS.RESTAURANT_HOLIDAYS, [holidayRow('first', '2026-11-01'), holidayRow('second', '2026-11-20')]);
  const results = await Promise.all([
    server.request('PUT', '/api/holidays/first', payload('2026-11-10')),
    server.request('PUT', '/api/holidays/second', payload('2026-11-10'))
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
});

test('failed sheet writes return 500 without poisoning the mutation queue', async () => {
  failNextWrite = true;
  const failed = await server.request('POST', '/api/holidays', payload());
  assert.equal(failed.status, 500);
  assert.equal(failed.body.message, 'Stub write failed');
  assert.deepEqual(sheets.getRows(SHEETS.RESTAURANT_HOLIDAYS), []);
  assert.equal((await server.request('POST', '/api/holidays', payload('invalid'))).status, 400);
  assert.equal((await server.request('POST', '/api/holidays', payload())).status, 201);
});

test('row mapping supplies empty audit defaults for older rows', () => {
  assert.deepEqual(holidayRowToObj(['h', '2026-11-09', '2026-11-09', 'Closed']), {
    id: 'h', startDate: '2026-11-09', endDate: '2026-11-09', reason: 'Closed',
    createdBy: '', createdAt: '', updatedBy: '', updatedAt: ''
  });
});

test('synthetic unpaid leaves expand every employee with inclusive end and stable IDs', () => {
  const rows = [holidayRow('festival', '2024-02-28', '2024-02-29'), holidayRow('year-end', '2026-12-31')];
  const employees = [['e1', 'One', '', '', '', '', '', 'Active'], ['e2', 'Two', '', '', '', '', '', 'Inactive']];
  const leaves = holidayLeaveRecords(rows, employees);
  assert.equal(leaves.length, 4);
  assert.deepEqual(leaves[0], {
    id: 'holiday:festival:e1', holidayId: 'festival', isRestaurantHoliday: true,
    employeeId: 'e1', employeeName: 'One', startDateTime: '2024-02-28T00:00', endDateTime: '2024-03-01T00:00',
    remarks: 'Restaurant holiday: Festival', createdBy: 'Creator', createdAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(leaves[1].employeeId, 'e2');
  assert.equal(leaves[2].endDateTime, '2027-01-01T00:00');
  assert.deepEqual(holidayLeaveRecords([], employees), []);
  assert.deepEqual(holidayLeaveRecords(rows, []), []);
});

test('service reads both stub sheets and optionally filters synthetic leaves by employee', async () => {
  sheets.setRows(SHEETS.RESTAURANT_HOLIDAYS, [holidayRow('closure', '2026-11-09')]);
  sheets.setRows(SHEETS.EMPLOYEES, [['e1', 'One'], ['e2', 'Two']]);
  assert.equal((await getRestaurantHolidayLeaves()).length, 2);
  const filtered = await getRestaurantHolidayLeaves('e2');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'holiday:closure:e2');
  assert.equal(filtered[0].endDateTime, '2026-11-10T00:00');
  assert.deepEqual(await getRestaurantHolidayLeaves('missing'), []);
});