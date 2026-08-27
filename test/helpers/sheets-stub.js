/* Test harness: in-memory replacement for services/googleSheets.js.
   Installed into the require cache so routes never touch the real Sheets API. */

const sheetsModulePath = require.resolve('../../services/googleSheets');

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

function installSheetsStub() {
  const store = new Map();
  const rowsOf = sheet => {
    if (!store.has(sheet)) store.set(sheet, []);
    return store.get(sheet);
  };

  const stub = {
    SHEETS,
    async initializeSheets() {},
    async getAllRows(sheet) {
      return rowsOf(sheet).map(row => [...row]);
    },
    async appendRow(sheet, values) {
      rowsOf(sheet).push([...values]);
    },
    // rowIndex is 1-based including the header row, matching the real service.
    async updateRow(sheet, rowIndex, values) {
      rowsOf(sheet)[rowIndex - 2] = [...values];
    },
    async deleteRow(sheet, rowIndex) {
      rowsOf(sheet).splice(rowIndex - 2, 1);
    },
    async findRowById(sheet, id) {
      const rows = rowsOf(sheet);
      const index = rows.findIndex(row => row[0] === id);
      return index === -1 ? null : { row: [...rows[index]], index: index + 2 };
    },
    setRows(sheet, rows) {
      store.set(sheet, rows.map(row => [...row]));
    },
    getRows(sheet) {
      return rowsOf(sheet).map(row => [...row]);
    },
    reset() {
      store.clear();
    }
  };

  require.cache[sheetsModulePath] = {
    id: sheetsModulePath,
    filename: sheetsModulePath,
    path: sheetsModulePath,
    loaded: true,
    exports: stub,
    children: [],
    paths: []
  };

  return stub;
}

module.exports = { installSheetsStub, SHEETS };
