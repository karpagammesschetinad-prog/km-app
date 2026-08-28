const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SPREADSHEET_ID_DEVELOPMENT = 'test-spreadsheet';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: 'test@example.com', private_key: 'key' });

const calls = { get: 0, append: 0 };
let resolveGet = null;

const sheetsApi = {
  spreadsheets: {
    values: {
      get: () => {
        calls.get++;
        return new Promise(resolve => {
          resolveGet = () => resolve({ data: { values: [['row-1', 'a'], ['row-2', 'b']] } });
        });
      },
      append: async () => { calls.append++; }
    }
  }
};

// Stub googleapis before the service loads it.
require.cache[require.resolve('googleapis')] = {
  id: 'googleapis',
  filename: 'googleapis',
  loaded: true,
  exports: { google: { auth: { JWT: function () {} }, sheets: () => sheetsApi } },
  children: [],
  paths: []
};

const { getAllRows, appendRow } = require('../services/googleSheets');

const flush = () => new Promise(resolve => setImmediate(resolve));

function releaseGet() {
  const resolve = resolveGet;
  resolveGet = null;
  if (resolve) resolve();
}

// Starts a read, lets it reach the stubbed API, then releases the response.
async function read(sheet) {
  const pending = getAllRows(sheet);
  await flush();
  releaseGet();
  return pending;
}

test.beforeEach(() => {
  calls.get = 0;
  calls.append = 0;
});

test('concurrent reads of one sheet share a single API call', async () => {
  const first = getAllRows('Expenses');
  const second = getAllRows('Expenses');
  await flush();
  releaseGet();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.get, 1);
  assert.deepEqual(a, b);
});

test('a cached read within the TTL makes no API call', async () => {
  const rows = await getAllRows('Expenses');
  assert.equal(calls.get, 0);
  assert.equal(rows.length, 2);
});

test('callers cannot mutate the cached rows', async () => {
  const rows = await getAllRows('Expenses');
  rows[0][0] = 'mutated';

  const fresh = await getAllRows('Expenses');
  assert.equal(fresh[0][0], 'row-1');
});

test('a write invalidates the cache for that sheet only', async () => {
  await read('Sales');
  calls.get = 0;

  await appendRow('Expenses', ['row-3']);

  await read('Sales');
  assert.equal(calls.get, 0, 'Sales should still be cached');

  await read('Expenses');
  assert.equal(calls.get, 1, 'Expenses should be refetched after the write');
});

test('a write during an in-flight read does not repopulate a stale cache', async () => {
  const inFlight = getAllRows('Employees');
  await flush();
  await appendRow('Employees', ['row-9']);
  releaseGet();
  await inFlight;
  calls.get = 0;

  await read('Employees');
  assert.equal(calls.get, 1, 'the pre-write response must not be served from cache');
});
