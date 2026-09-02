const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { AsyncLocalStorage } = require('node:async_hooks');
const { environment, getSpreadsheetId } = require('../config/environment');

const SPREADSHEET_ID = getSpreadsheetId();
const ROW_CACHE_TTL_MS = 10000;
let sheetsClientPromise = null;
const rowCache = new Map();
const inFlightReads = new Map();
const cacheEpoch = new Map();

// Counts real Sheets API calls for the current HTTP request.
const metricsStore = new AsyncLocalStorage();

function trackSheetUsage(handler) {
  return metricsStore.run({ reads: 0, writes: 0, cacheHits: 0, coalesced: 0, sheets: {} }, handler);
}

function getSheetUsage() {
  return metricsStore.getStore();
}

function countUsage(kind, sheetName) {
  const usage = metricsStore.getStore();
  if (!usage) return;
  usage[kind]++;
  usage.sheets[sheetName] = usage.sheets[sheetName] || { reads: 0, writes: 0, cacheHits: 0, coalesced: 0 };
  usage.sheets[sheetName][kind]++;
}

const SHEETS = {
  EXPENSES: 'Expenses',
  SALES: 'Sales',
  SALES_ENTRIES: 'SalesEntries',
  EMPLOYEES: 'Employees',
  SALARIES: 'Salaries',
  EXPENSE_CATEGORIES: 'ExpenseCategories',
  EXPENSE_CATEGORY_TYPES: 'ExpenseCategoryTypes',
  SETTINGS: 'Settings',
  USERS: 'Users',
  LEAVES: 'Leaves',
  SALARY_PAYMENTS: 'SalaryPayments',
  PETTA_HISTORY: 'PettaHistory',
  SALARY_HISTORY: 'SalaryHistory'
};

const HEADERS = {
  EXPENSES: ['ID', 'Date', 'Category', 'Description', 'Amount', 'EmployeeID', 'EmployeeName', 'SubmittedBy', 'ApprovalStatus', 'ApprovedBy', 'ApprovedAt', 'RejectionReason', 'CreatedAt', 'CategoryTypeID', 'IsOnSpot', 'PaymentID', 'Shift', 'ExpenseMode'],
  SALES: ['ID', 'Date', 'Morning', 'Afternoon', 'Dinner', 'TotalSales', 'ExpenseTotal', 'Remaining', 'EnteredBy', 'CreatedAt', 'MorningEnteredBy', 'AfternoonEnteredBy', 'DinnerEnteredBy'],
  SALES_ENTRIES: ['ID', 'Date', 'Shift', 'PaymentType', 'OnlineVendor', 'Amount', 'EnteredBy', 'CreatedAt', 'UpdatedAt'],
  EMPLOYEES: ['ID', 'Name', 'Address', 'Phone', 'StartDate', 'PerDaySalary', 'DailyPetta', 'Status', 'DailySalaryEnabled', 'TemporaryEmployee', 'OpeningBalance'],
  LEAVES: ['ID', 'EmployeeID', 'EmployeeName', 'StartDateTime', 'EndDateTime', 'Remarks', 'CreatedBy', 'CreatedAt'],
  SALARY_PAYMENTS: ['ID', 'EmployeeID', 'EmployeeName', 'PaymentDate', 'Amount', 'Remarks', 'CreatedBy', 'CreatedAt'],
  PETTA_HISTORY:   ['ID', 'EmployeeID', 'EmployeeName', 'EffectiveDate', 'Amount', 'Remarks', 'CreatedBy', 'CreatedAt'],
  SALARY_HISTORY:  ['ID', 'EmployeeID', 'EmployeeName', 'EffectiveDate', 'Amount', 'Remarks', 'CreatedBy', 'CreatedAt'],
  SALARIES: ['ID', 'EmployeeID', 'EmployeeName', 'Month', 'Year', 'BaseSalary', 'Allowances', 'Deductions', 'NetSalary', 'PaymentDate', 'Status'],
  EXPENSE_CATEGORIES: ['ID', 'Name', 'SortOrder', 'Status', 'CategoryTypeID', 'ExcludeDailyCashSales'],
  EXPENSE_CATEGORY_TYPES: ['ID', 'Name', 'SortOrder', 'Status', 'AccessMode', 'AllowedUserIDs', 'DisplayText', 'ExpenseWorkflow'],
  SETTINGS: ['Key', 'Value'],
  USERS: ['ID', 'Username', 'DisplayName', 'Role', 'PasswordHash', 'Status', 'CreatedAt', 'Permissions']
};

async function getAuthClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set.');
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

async function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = getAuthClient().then(auth => google.sheets({ version: 'v4', auth }));
  }
  return sheetsClientPromise;
}

function invalidateRowCache(sheetName) {
  rowCache.delete(sheetName);
  // A read started before this write would return pre-write rows.
  inFlightReads.delete(sheetName);
  cacheEpoch.set(sheetName, (cacheEpoch.get(sheetName) || 0) + 1);
}

async function initializeSheets() {
  if (!SPREADSHEET_ID) {
    throw new Error(`No spreadsheet configured for ${environment}. Set SPREADSHEET_ID_${environment.toUpperCase()}.`);
  }

  const sheets = await getSheetsClient();
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = spreadsheet.data.sheets.map(s => s.properties.title);

  for (const [key, name] of Object.entries(SHEETS)) {
    if (!existing.includes(name)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: [{ addSheet: { properties: { title: name } } }] }
      });
    }

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${name}!A1:Z1`
    });

    const currentHeader = res.data.values?.[0] || [];
    const expectedHeader = HEADERS[key];

    // Migrate old Employees header to new schema
    if (key === 'EMPLOYEES' && currentHeader[2] === 'Email') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${name}!A1`,
        valueInputOption: 'RAW',
        resource: { values: [expectedHeader] }
      });
    }

    // If schema has grown (new columns appended), update header row.
    const headerIsPrefix = currentHeader.every((h, i) => h === expectedHeader[i]);
    if (currentHeader.length > 0 && headerIsPrefix && currentHeader.length < expectedHeader.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${name}!A1`,
        valueInputOption: 'RAW',
        resource: { values: [expectedHeader] }
      });
    }

    if (!res.data.values || res.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${name}!A1`,
        valueInputOption: 'RAW',
        resource: { values: [HEADERS[key]] }
      });
      // Seed defaults on first creation
      if (key === 'USERS') {
        const bcrypt = require('bcryptjs');
        const defaultUsers = [
          { username: 'admin',   displayName: 'Admin',   role: 'superuser', password: 'Admin@123'   },
          { username: 'karthi',  displayName: 'Karthi',  role: 'superuser', password: 'Karthi@123'  },
          { username: 'chemban', displayName: 'Chemban', role: 'superuser', password: 'Chemban@123' },
          { username: 'cashier', displayName: 'Cashier', role: 'cashier',   password: 'Cashier@123' }
        ];
        const now = new Date().toISOString();
        const seedRows = [];
        for (const u of defaultUsers) {
          const hash = await bcrypt.hash(u.password, 10);
          seedRows.push([uuidv4(), u.username, u.displayName, u.role, hash, 'Active', now]);
        }
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${name}!A1`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: { values: seedRows }
        });
      }
      if (key === 'EXPENSE_CATEGORIES') {
        const defaults = ['Milk','Kadeswara','Jeyadevi','Illai','Oil','Egg','Water','Vegetables','Medicine','Electricity','Other'];
        const seedValues = defaults.map((n, i) => [uuidv4(), n, i + 1, 'Active']);
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${name}!A1`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: { values: seedValues }
        });
      }
      if (key === 'EXPENSE_CATEGORY_TYPES') {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${name}!A1`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: { values: [[uuidv4(), 'General', 1, 'Active', 'All', '', 'General', 'Daily Cash']] }
        });
      }
      if (key === 'SETTINGS') {
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${name}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
          resource: { values: [['FY_START_MONTH', '4'], ['FY_START_DAY', '1'], ['FY_START_DATE', ''], ['FY_END_DATE', ''], ['IDLE_TIMEOUT_MINUTES', '15'], ['AUTO_SAVE_ENABLED', 'true']] }
        });
      }
    }
  }
}

async function getAllRows(sheetName) {
  const cached = rowCache.get(sheetName);
  if (cached && cached.expiresAt > Date.now()) {
    countUsage('cacheHits', sheetName);
    return cached.rows.map(row => [...row]);
  }
  // Concurrent reads of the same sheet share one API call instead of racing.
  let pending = inFlightReads.get(sheetName);
  if (!pending) {
    countUsage('reads', sheetName);
    pending = fetchRows(sheetName).finally(() => inFlightReads.delete(sheetName));
    inFlightReads.set(sheetName, pending);
  } else {
    countUsage('coalesced', sheetName);
  }
  const rows = await pending;
  return rows.map(row => [...row]);
}

async function fetchRows(sheetName) {
  const epoch = cacheEpoch.get(sheetName) || 0;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });
  const rows = (res.data.values || []).filter(row => row.length > 0 && row[0]);
  if ((cacheEpoch.get(sheetName) || 0) === epoch) {
    rowCache.set(sheetName, { rows, expiresAt: Date.now() + ROW_CACHE_TTL_MS });
  }
  return rows;
}

async function appendRow(sheetName, values) {
  countUsage('writes', sheetName);
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [values] }
  });
  invalidateRowCache(sheetName);
}

async function updateRow(sheetName, rowIndex, values) {
  countUsage('writes', sheetName);
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex}:Z${rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [values] }
  });
  invalidateRowCache(sheetName);
}

async function deleteRow(sheetName, rowIndex) {
  // Each delete costs two API calls: metadata lookup plus the batch update.
  countUsage('writes', sheetName);
  countUsage('writes', sheetName);
  const sheets = await getSheetsClient();
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = spreadsheet.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found.`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1, // 0-based
            endIndex: rowIndex        // exclusive
          }
        }
      }]
    }
  });
  invalidateRowCache(sheetName);
}

async function findRowById(sheetName, id) {
  const rows = await getAllRows(sheetName);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === id) {
      return { row: rows[i], index: i + 2 }; // +1 for header, +1 for 0→1-based
    }
  }
  return null;
}

module.exports = { SHEETS, HEADERS, initializeSheets, getAllRows, appendRow, updateRow, deleteRow, findRowById, trackSheetUsage, getSheetUsage };
