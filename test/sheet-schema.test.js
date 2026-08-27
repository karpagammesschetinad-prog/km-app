/* Guards against silent schema drift: every column index constant used by a route
   must still point at the header it was written for. Insert a column in HEADERS
   without updating the routes and these assertions fail. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { HEADERS } = require('../services/googleSheets');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

// Reads a `const NAME = { ... };` literal out of a route file.
function readColumnMap(file, constantName) {
  const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
  const start = source.indexOf(`const ${constantName} = {`);
  assert.notEqual(start, -1, `${file} no longer declares ${constantName}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') {
      depth--;
      if (depth === 0) return new Function(`return ${source.slice(open, i + 1)}`)();
    }
  }
  throw new Error(`Could not parse ${constantName} in ${file}`);
}

const EXPENSE_COLUMNS = {
  ID: 'ID', DATE: 'Date', CATEGORY: 'Category', DESCRIPTION: 'Description', AMOUNT: 'Amount',
  EMP_ID: 'EmployeeID', EMPLOYEE_ID: 'EmployeeID', EMP_NAME: 'EmployeeName',
  SUBMITTED_BY: 'SubmittedBy', APPROVAL_STATUS: 'ApprovalStatus', APPROVED_BY: 'ApprovedBy',
  APPROVED_AT: 'ApprovedAt', REJECTION_REASON: 'RejectionReason', CREATED_AT: 'CreatedAt',
  TYPE_ID: 'CategoryTypeID', ON_SPOT: 'IsOnSpot', PAYMENT_ID: 'PaymentID', SHIFT: 'Shift', MODE: 'ExpenseMode'
};

const CATEGORY_TYPE_COLUMNS = {
  ID: 'ID', NAME: 'Name', ORDER: 'SortOrder', STATUS: 'Status',
  ACCESS_MODE: 'AccessMode', ALLOWED_USERS: 'AllowedUserIDs', WORKFLOW: 'ExpenseWorkflow'
};

const USER_COLUMNS = {
  ID: 'ID', USERNAME: 'Username', DISPLAY_NAME: 'DisplayName', ROLE: 'Role',
  PASSWORD_HASH: 'PasswordHash', STATUS: 'Status', CREATED_AT: 'CreatedAt', PERMISSIONS: 'Permissions'
};

const CASES = [
  { file: 'expenses.js', constant: 'C', sheet: 'EXPENSES', columns: EXPENSE_COLUMNS },
  { file: 'expenses.js', constant: 'TYPE_C', sheet: 'EXPENSE_CATEGORY_TYPES', columns: CATEGORY_TYPE_COLUMNS },
  { file: 'payments.js', constant: 'EXPENSE_C', sheet: 'EXPENSES', columns: EXPENSE_COLUMNS },
  { file: 'payments.js', constant: 'TYPE_C', sheet: 'EXPENSE_CATEGORY_TYPES', columns: CATEGORY_TYPE_COLUMNS },
  {
    file: 'payments.js', constant: 'C', sheet: 'SALARY_PAYMENTS',
    columns: {
      ID: 'ID', EMP_ID: 'EmployeeID', EMP_NAME: 'EmployeeName', DATE: 'PaymentDate',
      AMOUNT: 'Amount', REMARKS: 'Remarks', CREATED_BY: 'CreatedBy', CREATED_AT: 'CreatedAt'
    }
  },
  {
    file: 'payments.js', constant: 'EMPLOYEE_C', sheet: 'EMPLOYEES',
    columns: { ID: 'ID', NAME: 'Name' }
  },
  {
    file: 'salaries.js', constant: 'C', sheet: 'SALARIES',
    columns: {
      ID: 'ID', EMP_ID: 'EmployeeID', EMP_NAME: 'EmployeeName', MONTH: 'Month', YEAR: 'Year',
      BASE: 'BaseSalary', ALLOW: 'Allowances', DED: 'Deductions', NET: 'NetSalary',
      PAY_DATE: 'PaymentDate', STATUS: 'Status'
    }
  },
  {
    file: 'employees.js', constant: 'C', sheet: 'EMPLOYEES',
    columns: {
      ID: 'ID', NAME: 'Name', ADDRESS: 'Address', PHONE: 'Phone', START: 'StartDate',
      PER_DAY: 'PerDaySalary', PETTA: 'DailyPetta', STATUS: 'Status',
      DAILY_PAY: 'DailySalaryEnabled', TEMPORARY: 'TemporaryEmployee'
    }
  },
  {
    file: 'leaves.js', constant: 'C', sheet: 'LEAVES',
    columns: {
      ID: 'ID', EMP_ID: 'EmployeeID', EMP_NAME: 'EmployeeName', START: 'StartDateTime',
      END: 'EndDateTime', REMARKS: 'Remarks', CREATED_BY: 'CreatedBy', CREATED_AT: 'CreatedAt'
    }
  },
  {
    file: 'petta.js', constant: 'C', sheet: 'PETTA_HISTORY',
    columns: {
      ID: 'ID', EMP_ID: 'EmployeeID', EMP_NAME: 'EmployeeName', EFFECTIVE_DATE: 'EffectiveDate',
      AMOUNT: 'Amount', REMARKS: 'Remarks', CREATED_BY: 'CreatedBy', CREATED_AT: 'CreatedAt'
    }
  },
  {
    file: 'sales.js', constant: 'C', sheet: 'SALES',
    columns: {
      ID: 'ID', DATE: 'Date', MORNING: 'Morning', AFTERNOON: 'Afternoon', DINNER: 'Dinner',
      TOTAL: 'TotalSales', EXPENSES: 'ExpenseTotal', REMAINING: 'Remaining',
      ENTERED_BY: 'EnteredBy', CREATED_AT: 'CreatedAt', MORNING_BY: 'MorningEnteredBy',
      AFTERNOON_BY: 'AfternoonEnteredBy', DINNER_BY: 'DinnerEnteredBy'
    }
  },
  {
    file: 'salesEntries.js', constant: 'C', sheet: 'SALES_ENTRIES',
    columns: {
      ID: 'ID', DATE: 'Date', SHIFT: 'Shift', PAYMENT_TYPE: 'PaymentType', VENDOR: 'OnlineVendor',
      AMOUNT: 'Amount', ENTERED_BY: 'EnteredBy', CREATED_AT: 'CreatedAt', UPDATED_AT: 'UpdatedAt'
    }
  },
  {
    file: 'categories.js', constant: 'C', sheet: 'EXPENSE_CATEGORIES',
    columns: {
      ID: 'ID', NAME: 'Name', ORDER: 'SortOrder', STATUS: 'Status',
      TYPE_ID: 'CategoryTypeID', EXCLUDE_CASH: 'ExcludeDailyCashSales'
    }
  },
  { file: 'categories.js', constant: 'EXPENSE_C', sheet: 'EXPENSES', columns: EXPENSE_COLUMNS },
  { file: 'users.js', constant: 'C', sheet: 'USERS', columns: USER_COLUMNS },
  { file: 'auth.js', constant: 'C', sheet: 'USERS', columns: USER_COLUMNS }
];

for (const { file, constant, sheet, columns } of CASES) {
  test(`${file} ${constant} matches the ${sheet} header row`, () => {
    const map = readColumnMap(file, constant);
    const headers = HEADERS[sheet];

    for (const [key, index] of Object.entries(map)) {
      const expected = columns[key];
      assert.ok(expected, `${file} ${constant}.${key} is not described in this test — add it`);
      assert.equal(headers[index], expected,
        `${file} ${constant}.${key} points at "${headers[index]}" but should be "${expected}"`);
    }
  });
}

test('every sheet has a header definition with unique, non-empty names', () => {
  const { SHEETS } = require('../services/googleSheets');
  for (const key of Object.keys(SHEETS)) {
    const headers = HEADERS[key];
    assert.ok(Array.isArray(headers) && headers.length, `${key} has no header definition`);
    assert.ok(headers.every(name => typeof name === 'string' && name.trim()), `${key} has a blank header`);
    assert.equal(new Set(headers).size, headers.length, `${key} has duplicate headers`);
  }
});
