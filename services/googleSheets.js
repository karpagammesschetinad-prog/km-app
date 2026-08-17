const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const SHEETS = {
  EXPENSES: 'Expenses',
  EMPLOYEES: 'Employees',
  SALARIES: 'Salaries',
  EXPENSE_CATEGORIES: 'ExpenseCategories',
  USERS: 'Users',
  LEAVES: 'Leaves',
  SALARY_PAYMENTS: 'SalaryPayments'
};

const HEADERS = {
  EXPENSES: ['ID', 'Date', 'Category', 'Description', 'Amount', 'EmployeeID', 'EmployeeName', 'SubmittedBy', 'ApprovalStatus', 'ApprovedBy', 'ApprovedAt', 'RejectionReason', 'CreatedAt'],
  EMPLOYEES: ['ID', 'Name', 'Address', 'Phone', 'StartDate', 'PerDaySalary', 'DailyPetta', 'Status', 'DailySalaryEnabled'],
  LEAVES: ['ID', 'EmployeeID', 'EmployeeName', 'StartDateTime', 'EndDateTime', 'Remarks', 'CreatedBy', 'CreatedAt'],
  SALARY_PAYMENTS: ['ID', 'EmployeeID', 'EmployeeName', 'PaymentDate', 'Amount', 'Remarks', 'CreatedBy', 'CreatedAt'],
  SALARIES: ['ID', 'EmployeeID', 'EmployeeName', 'Month', 'Year', 'BaseSalary', 'Allowances', 'Deductions', 'NetSalary', 'PaymentDate', 'Status'],
  EXPENSE_CATEGORIES: ['ID', 'Name', 'SortOrder', 'Status'],
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
  const auth = await getAuthClient();
  return google.sheets({ version: 'v4', auth });
}

async function initializeSheets() {
  if (!SPREADSHEET_ID) {
    throw new Error('SPREADSHEET_ID environment variable is not set.');
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
    }
  }
}

async function getAllRows(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A2:Z`
  });
  return (res.data.values || []).filter(row => row.length > 0 && row[0]);
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
}

async function updateRow(sheetName, rowIndex, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex}:Z${rowIndex}`,
    valueInputOption: 'RAW',
    resource: { values: [values] }
  });
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

module.exports = { SHEETS, initializeSheets, getAllRows, appendRow, updateRow, deleteRow, findRowById };
