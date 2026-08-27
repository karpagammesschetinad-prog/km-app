const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { environment, getSpreadsheetId } = require('../config/environment');

const SPREADSHEET_ID = getSpreadsheetId();
const ROW_CACHE_TTL_MS = 10000;
let sheetsClientPromise = null;
const rowCache = new Map();

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
  PETTA_HISTORY: 'PettaHistory'
};

const HEADERS = {
  EXPENSES: ['ID', 'Date', 'Category', 'Description', 'Amount', 'EmployeeID', 'EmployeeName', 'SubmittedBy', 'ApprovalStatus', 'ApprovedBy', 'ApprovedAt', 'RejectionReason', 'CreatedAt', 'CategoryTypeID', 'IsOnSpot', 'PaymentID', 'Shift', 'ExpenseMode'],
  SALES: ['ID', 'Date', 'Morning', 'Afternoon', 'Dinner', 'TotalSales', 'ExpenseTotal', 'Remaining', 'EnteredBy', 'CreatedAt', 'MorningEnteredBy', 'AfternoonEnteredBy', 'DinnerEnteredBy'],
  SALES_ENTRIES: ['ID', 'Date', 'Shift', 'PaymentType', 'OnlineVendor', 'Amount', 'EnteredBy', 'CreatedAt', 'UpdatedAt'],
  EMPLOYEES: ['ID', 'Name', 'Address', 'Phone', 'StartDate', 'PerDaySalary', 'DailyPetta', 'Status', 'DailySalaryEnabled', 'TemporaryEmployee'],
  LEAVES: ['ID', 'EmployeeID', 'EmployeeName', 'StartDateTime', 'EndDateTime', 'Remarks', 'CreatedBy', 'CreatedAt'],
  SALARY_PAYMENTS: ['ID', 'EmployeeID', 'EmployeeName', 'PaymentDate', 'Amount', 'Remarks', 'CreatedBy', 'CreatedAt'],
  PETTA_HISTORY:   ['ID', 'EmployeeID', 'EmployeeName', 'EffectiveDate', 'Amount', 'Remarks', 'CreatedBy', 'CreatedAt'],
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
          resource: { values: [['FY_START_MONTH', '4'], ['FY_START_DAY', '1'], ['FY_START_DATE', ''], ['FY_END_DATE', ''], ['IDLE_TIMEOUT_MINUTES', '15']] }
        });
      }
    }
  }
}

async function getAllRows(sheetName) {
  const cached = rowCache.get(sheetName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows.map(row => [...row]);
  }
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });
  const rows = (res.data.values || []).filter(row => row.length > 0 && row[0]);
  rowCache.set(sheetName, { rows, expiresAt: Date.now() + ROW_CACHE_TTL_MS });
  return rows.map(row => [...row]);
}

async function appendRow(sheetName, values) {
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

module.exports = { SHEETS, HEADERS, initializeSheets, getAllRows, appendRow, updateRow, deleteRow, findRowById };
