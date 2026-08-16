/**
 * BizTracker — Google Apps Script Backend
 *
 * HOW TO DEPLOY:
 * 1. Go to https://script.google.com → New Project → paste this file
 * 2. Set SPREADSHEET_ID constant below to your sheet ID
 * 3. Deploy → New Deployment → Web App
 *    - Execute as: Me
 *    - Who has access: Anyone  (auth is handled by this script)
 * 4. Copy the Web App URL → paste into mobile/js/api.js as GAS_URL
 *
 * FIRST-TIME SETUP — run once from the Apps Script editor:
 * 5. Select function "setInitialPasswords" from the dropdown → click Run
 *    This re-hashes all user passwords in GAS-compatible format.
 *    Default passwords:  admin→Admin@123  karthi→Karthi@123
 *                        chemban→Chemban@123  cashier→Cashier@123
 *    You can change them in INITIAL_PASSWORDS below before running.
 */

const SPREADSHEET_ID = '1PQ7h6awJjFnwIG6j0hPpxKlRazbQKdhybWs5IuMELzE';

const SHEETS = {
  EXPENSES:     'Expenses',
  EMPLOYEES:    'Employees',
  SALARIES:     'Salaries',
  CATEGORIES:   'ExpenseCategories',
  USERS:        'Users'
};

const USER_COL = { ID:0, USERNAME:1, DISPLAY_NAME:2, ROLE:3, PASSWORD_HASH:4, STATUS:5, CREATED_AT:6, PERMISSIONS:7 };
const EXP_COL  = { ID:0, DATE:1, CATEGORY:2, DESCRIPTION:3, AMOUNT:4, EMP_ID:5, EMP_NAME:6, SUBMITTED_BY:7,
                   APPROVAL_STATUS:8, APPROVED_BY:9, APPROVED_AT:10, REJECTION_REASON:11, CREATED_AT:12 };
const CAT_COL  = { ID:0, NAME:1, SORT_ORDER:2, STATUS:3 };
const EMP_COL  = { ID:0, NAME:1, EMAIL:2, DEPARTMENT:3, POSITION:4, BASE_SALARY:5, JOIN_DATE:6, STATUS:7 };
const SAL_COL  = { ID:0, EMP_ID:1, EMP_NAME:2, MONTH:3, YEAR:4, BASE_SALARY:5, ALLOWANCES:6,
                   DEDUCTIONS:7, NET_SALARY:8, PAYMENT_DATE:9, STATUS:10 };

/* ============================================================
   ENTRY POINTS
   ============================================================ */

function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  try {
    const params  = e.parameter || {};
    const action  = params.action || '';
    const method  = params.method || (e.postData ? 'POST' : 'GET');
    let   body    = {};
    if (e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch(_) {}
    }

    // --- Auth ---
    if (action === 'login')  return json(login(body));
    if (action === 'me')     return json(me(params.token));
    if (action === 'logout') return json({ success: true });

    // All other actions require a valid token
    const user = verifyToken(params.token);
    if (!user) return json({ success: false, message: 'Unauthorized.' }, 401);

    // --- Expenses ---
    if (action === 'getExpenses')   return json(getExpenses());
    if (action === 'bulkExpenses')  return json(bulkExpenses(body, user));
    if (action === 'approveDate')   return json(approveDate(body, user));
    if (action === 'rejectDate')    return json(rejectDate(body, user));
    if (action === 'deleteExpense') return json(deleteExpense(body, user));

    // --- Categories ---
    if (action === 'getCategories')    return json(getCategories());
    if (action === 'createCategory')   return json(createCategory(body, user));
    if (action === 'updateCategory')   return json(updateCategory(body, user));
    if (action === 'deleteCategory')   return json(deleteCategoryRow(body, user));

    // --- Employees ---
    if (action === 'getEmployees')   return json(getEmployees());
    if (action === 'createEmployee') return json(createEmployee(body, user));
    if (action === 'updateEmployee') return json(updateEmployee(body, user));
    if (action === 'deleteEmployee') return json(deleteEmployee(body, user));

    // --- Salaries ---
    if (action === 'getSalaries')   return json(getSalaries());
    if (action === 'createSalary')  return json(createSalary(body, user));
    if (action === 'updateSalary')  return json(updateSalary(body, user));
    if (action === 'deleteSalary')  return json(deleteSalary(body, user));

    // --- Users (super user only) ---
    if (action === 'getUsers')    return json(getUsers(user));
    if (action === 'createUser')  return json(createUser(body, user));
    if (action === 'updateUser')  return json(updateUser(body, user));
    if (action === 'deleteUser')  return json(deleteUser(body, user));

    return json({ success: false, message: 'Unknown action: ' + action }, 400);
  } catch (err) {
    return json({ success: false, message: err.message });
  }
}

function json(data, code) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   SIMPLE TOKEN AUTH (stores tokens in Script Properties)
   ============================================================ */

function makeToken(userId) {
  const token = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  // Store token → userId,expiry (8 hours)
  const expiry = Date.now() + 8 * 60 * 60 * 1000;
  props.setProperty('tok_' + token, userId + '|' + expiry);
  return token;
}

function verifyToken(token) {
  if (!token) return null;
  const props = PropertiesService.getScriptProperties();
  const val   = props.getProperty('tok_' + token);
  if (!val) return null;
  const [userId, expiry] = val.split('|');
  if (Date.now() > parseInt(expiry)) { props.deleteProperty('tok_' + token); return null; }
  // Find user
  const rows = getSheetRows(SHEETS.USERS);
  const row  = rows.find(r => r[USER_COL.ID] === userId);
  if (!row || row[USER_COL.STATUS] !== 'Active') return null;
  return rowToUser(row);
}

function login(body) {
  const { username, password } = body;
  if (!username || !password) return { success: false, message: 'Username and password required.' };
  const rows = getSheetRows(SHEETS.USERS);
  const row  = rows.find(r => (r[USER_COL.USERNAME] || '').toLowerCase() === username.toLowerCase());
  if (!row || row[USER_COL.STATUS] !== 'Active') return { success: false, message: 'Invalid username or password.' };
  // bcrypt not available in GAS — use SHA-256 based simple hash check
  // Passwords stored as: sha256(password + salt) where salt is stored in hash as "hash:salt"
  if (!checkPassword(password, row[USER_COL.PASSWORD_HASH])) return { success: false, message: 'Invalid username or password.' };
  const user  = rowToUser(row);
  const token = makeToken(user.id);
  return { success: true, data: { ...user, token } };
}

function me(token) {
  const user = verifyToken(token);
  if (!user) return { success: false, message: 'Not authenticated.' };
  return { success: true, data: user };
}

/* ============================================================
   PASSWORD HASHING (GAS-compatible, SHA-256 + salt)
   ============================================================ */

function hashPassword(password) {
  const salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    password + salt, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  return hash + ':' + salt;
}

function checkPassword(password, stored) {
  if (!stored) return false;
  // Support both old bcrypt hashes (from desktop) and new GAS hashes
  if (stored.startsWith('$2')) {
    // bcrypt hash from desktop — cannot verify in GAS
    // Fall back: check against default passwords stored in script properties
    const props = PropertiesService.getScriptProperties();
    const plain  = props.getProperty('plain_' + stored.slice(0,10));
    return plain === password;
  }
  const [hash, salt] = stored.split(':');
  if (!salt) return false;
  const attempt = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    password + salt, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  return attempt === hash;
}

/* ============================================================
   USERS
   ============================================================ */

function rowToUser(row) {
  let perms = null;
  try { if (row[USER_COL.PERMISSIONS]) perms = JSON.parse(row[USER_COL.PERMISSIONS]); } catch(_) {}
  return {
    id: row[USER_COL.ID], username: row[USER_COL.USERNAME],
    displayName: row[USER_COL.DISPLAY_NAME], role: row[USER_COL.ROLE],
    status: row[USER_COL.STATUS], createdAt: row[USER_COL.CREATED_AT],
    permissions: perms
  };
}

function getUsers(currentUser) {
  if (currentUser.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const rows = getSheetRows(SHEETS.USERS);
  return { success: true, data: rows.map(r => rowToUser(r)) };
}

function createUser(body, currentUser) {
  if (currentUser.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { username, displayName, role, password } = body;
  if (!username || !displayName || !role || !password) return { success: false, message: 'All fields required.' };
  const rows = getSheetRows(SHEETS.USERS);
  if (rows.some(r => (r[USER_COL.USERNAME]||'').toLowerCase() === username.toLowerCase()))
    return { success: false, message: 'Username already exists.' };
  const id  = Utilities.getUuid();
  const now = new Date().toISOString();
  appendSheetRow(SHEETS.USERS, [id, username.toLowerCase(), displayName, role, hashPassword(password), 'Active', now, '']);
  return { success: true };
}

function updateUser(body, currentUser) {
  if (currentUser.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { id, displayName, role, status, password, permissions } = body;
  const rows = getSheetRows(SHEETS.USERS);
  const idx  = rows.findIndex(r => r[USER_COL.ID] === id);
  if (idx < 0) return { success: false, message: 'User not found.' };
  const row  = rows[idx];
  if (role && role !== 'superuser' && row[USER_COL.ROLE] === 'superuser') {
    const suCount = rows.filter(r => r[USER_COL.ROLE] === 'superuser' && r[USER_COL.STATUS] === 'Active' && r[USER_COL.ID] !== id).length;
    if (suCount === 0) return { success: false, message: 'Cannot demote the only super user.' };
  }
  const updated = [...row];
  if (displayName !== undefined) updated[USER_COL.DISPLAY_NAME] = displayName;
  if (role        !== undefined) updated[USER_COL.ROLE]         = role;
  if (status      !== undefined) updated[USER_COL.STATUS]       = status;
  if (password)                  updated[USER_COL.PASSWORD_HASH] = hashPassword(password);
  if (permissions !== undefined) updated[USER_COL.PERMISSIONS]  = JSON.stringify(permissions);
  updateSheetRow(SHEETS.USERS, idx + 1, updated); // +1 for header
  return { success: true };
}

function deleteUser(body, currentUser) {
  if (currentUser.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { id } = body;
  const rows = getSheetRows(SHEETS.USERS);
  const idx  = rows.findIndex(r => r[USER_COL.ID] === id);
  if (idx < 0) return { success: false, message: 'User not found.' };
  if (rows[idx][USER_COL.ROLE] === 'superuser') return { success: false, message: 'Super users cannot be deleted.' };
  if (id === currentUser.id) return { success: false, message: 'Cannot delete your own account.' };
  deleteSheetRow(SHEETS.USERS, idx + 1);
  return { success: true };
}

/* ============================================================
   EXPENSES
   ============================================================ */

function getExpenses() {
  const rows = getSheetRows(SHEETS.EXPENSES);
  return { success: true, data: rows.map(r => ({
    id: r[EXP_COL.ID], date: r[EXP_COL.DATE], category: r[EXP_COL.CATEGORY],
    description: r[EXP_COL.DESCRIPTION], amount: parseFloat(r[EXP_COL.AMOUNT]) || 0,
    employeeId: r[EXP_COL.EMP_ID], employeeName: r[EXP_COL.EMP_NAME],
    submittedBy: r[EXP_COL.SUBMITTED_BY], approvalStatus: r[EXP_COL.APPROVAL_STATUS],
    approvedBy: r[EXP_COL.APPROVED_BY], approvedAt: r[EXP_COL.APPROVED_AT],
    rejectionReason: r[EXP_COL.REJECTION_REASON], createdAt: r[EXP_COL.CREATED_AT]
  })) };
}

function bulkExpenses(body, user) {
  const { date, remarks, items } = body;
  if (!date || !items) return { success: false, message: 'date and items required.' };
  const isSU   = user.role === 'superuser';
  const status = isSU ? 'Approved' : 'Pending';
  const sheet  = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEETS.EXPENSES);
  const all    = getSheetRows(SHEETS.EXPENSES);
  // Remove existing rows for this date (delete from bottom)
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i][EXP_COL.DATE] === date) deleteSheetRow(SHEETS.EXPENSES, i + 1);
  }
  const now = new Date().toISOString();
  items.forEach(item => {
    const id = Utilities.getUuid();
    appendSheetRow(SHEETS.EXPENSES, [
      id, date, item.category, remarks || '', item.amount,
      '', '', user.username, status, isSU ? user.username : '', isSU ? now : '', '', now
    ]);
  });
  return { success: true };
}

function approveDate(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { date } = body;
  const rows = getSheetRows(SHEETS.EXPENSES);
  const now  = new Date().toISOString();
  rows.forEach((r, i) => {
    if (r[EXP_COL.DATE] === date && r[EXP_COL.APPROVAL_STATUS] === 'Pending') {
      const updated = [...r];
      updated[EXP_COL.APPROVAL_STATUS] = 'Approved';
      updated[EXP_COL.APPROVED_BY]     = user.username;
      updated[EXP_COL.APPROVED_AT]     = now;
      updateSheetRow(SHEETS.EXPENSES, i + 1, updated);
    }
  });
  return { success: true };
}

function rejectDate(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { date, reason } = body;
  const rows = getSheetRows(SHEETS.EXPENSES);
  rows.forEach((r, i) => {
    if (r[EXP_COL.DATE] === date &&
       (r[EXP_COL.APPROVAL_STATUS] === 'Pending' || r[EXP_COL.APPROVAL_STATUS] === 'Approved')) {
      const updated = [...r];
      updated[EXP_COL.APPROVAL_STATUS] = 'Rejected';
      updated[EXP_COL.REJECTION_REASON] = reason || '';
      updateSheetRow(SHEETS.EXPENSES, i + 1, updated);
    }
  });
  return { success: true };
}

function deleteExpense(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { id } = body;
  const rows = getSheetRows(SHEETS.EXPENSES);
  const idx  = rows.findIndex(r => r[EXP_COL.ID] === id);
  if (idx < 0) return { success: false, message: 'Not found.' };
  deleteSheetRow(SHEETS.EXPENSES, idx + 1);
  return { success: true };
}

/* ============================================================
   CATEGORIES
   ============================================================ */

function getCategories() {
  const rows = getSheetRows(SHEETS.CATEGORIES);
  return { success: true, data: rows.map(r => ({
    id: r[CAT_COL.ID], name: r[CAT_COL.NAME],
    sortOrder: parseInt(r[CAT_COL.SORT_ORDER]) || 0, status: r[CAT_COL.STATUS]
  })) };
}

function createCategory(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { name, sortOrder, status } = body;
  if (!name) return { success: false, message: 'Name required.' };
  appendSheetRow(SHEETS.CATEGORIES, [Utilities.getUuid(), name, sortOrder || 0, status || 'Active']);
  return { success: true };
}

function updateCategory(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { id, name, sortOrder, status } = body;
  const rows = getSheetRows(SHEETS.CATEGORIES);
  const idx  = rows.findIndex(r => r[CAT_COL.ID] === id);
  if (idx < 0) return { success: false, message: 'Not found.' };
  const updated = [...rows[idx]];
  if (name      !== undefined) updated[CAT_COL.NAME]       = name;
  if (sortOrder !== undefined) updated[CAT_COL.SORT_ORDER] = sortOrder;
  if (status    !== undefined) updated[CAT_COL.STATUS]     = status;
  updateSheetRow(SHEETS.CATEGORIES, idx + 1, updated);
  return { success: true };
}

function deleteCategoryRow(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { id } = body;
  const rows = getSheetRows(SHEETS.CATEGORIES);
  const idx  = rows.findIndex(r => r[CAT_COL.ID] === id);
  if (idx < 0) return { success: false, message: 'Not found.' };
  deleteSheetRow(SHEETS.CATEGORIES, idx + 1);
  return { success: true };
}

/* ============================================================
   EMPLOYEES
   ============================================================ */

function getEmployees() {
  const rows = getSheetRows(SHEETS.EMPLOYEES);
  return { success: true, data: rows.map(r => ({
    id: r[EMP_COL.ID], name: r[EMP_COL.NAME], email: r[EMP_COL.EMAIL],
    department: r[EMP_COL.DEPARTMENT], position: r[EMP_COL.POSITION],
    baseSalary: parseFloat(r[EMP_COL.BASE_SALARY]) || 0,
    joinDate: r[EMP_COL.JOIN_DATE], status: r[EMP_COL.STATUS]
  })) };
}

function createEmployee(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { name, email, department, position, baseSalary, joinDate, status } = body;
  if (!name) return { success: false, message: 'Name required.' };
  appendSheetRow(SHEETS.EMPLOYEES, [Utilities.getUuid(), name, email||'', department||'', position||'', baseSalary||0, joinDate||'', status||'Active']);
  return { success: true };
}

function updateEmployee(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { id, name, email, department, position, baseSalary, joinDate, status } = body;
  const rows = getSheetRows(SHEETS.EMPLOYEES);
  const idx  = rows.findIndex(r => r[EMP_COL.ID] === id);
  if (idx < 0) return { success: false, message: 'Not found.' };
  const updated = [...rows[idx]];
  if (name       !== undefined) updated[EMP_COL.NAME]        = name;
  if (email      !== undefined) updated[EMP_COL.EMAIL]       = email;
  if (department !== undefined) updated[EMP_COL.DEPARTMENT]  = department;
  if (position   !== undefined) updated[EMP_COL.POSITION]    = position;
  if (baseSalary !== undefined) updated[EMP_COL.BASE_SALARY] = baseSalary;
  if (joinDate   !== undefined) updated[EMP_COL.JOIN_DATE]   = joinDate;
  if (status     !== undefined) updated[EMP_COL.STATUS]      = status;
  updateSheetRow(SHEETS.EMPLOYEES, idx + 1, updated);
  return { success: true };
}

function deleteEmployee(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { id } = body;
  const rows = getSheetRows(SHEETS.EMPLOYEES);
  const idx  = rows.findIndex(r => r[EMP_COL.ID] === id);
  if (idx < 0) return { success: false, message: 'Not found.' };
  deleteSheetRow(SHEETS.EMPLOYEES, idx + 1);
  return { success: true };
}

/* ============================================================
   SALARIES
   ============================================================ */

function getSalaries() {
  const rows = getSheetRows(SHEETS.SALARIES);
  return { success: true, data: rows.map(r => ({
    id: r[SAL_COL.ID], employeeId: r[SAL_COL.EMP_ID], employeeName: r[SAL_COL.EMP_NAME],
    month: r[SAL_COL.MONTH], year: r[SAL_COL.YEAR],
    baseSalary: parseFloat(r[SAL_COL.BASE_SALARY])||0, allowances: parseFloat(r[SAL_COL.ALLOWANCES])||0,
    deductions: parseFloat(r[SAL_COL.DEDUCTIONS])||0, netSalary: parseFloat(r[SAL_COL.NET_SALARY])||0,
    paymentDate: r[SAL_COL.PAYMENT_DATE], status: r[SAL_COL.STATUS]
  })) };
}

function createSalary(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { employeeId, employeeName, month, year, baseSalary, allowances, deductions, netSalary, paymentDate, status } = body;
  appendSheetRow(SHEETS.SALARIES, [Utilities.getUuid(), employeeId, employeeName, month, year, baseSalary||0, allowances||0, deductions||0, netSalary||0, paymentDate||'', status||'Pending']);
  return { success: true };
}

function updateSalary(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { id, status, paymentDate } = body;
  const rows = getSheetRows(SHEETS.SALARIES);
  const idx  = rows.findIndex(r => r[SAL_COL.ID] === id);
  if (idx < 0) return { success: false, message: 'Not found.' };
  const updated = [...rows[idx]];
  if (status      !== undefined) updated[SAL_COL.STATUS]       = status;
  if (paymentDate !== undefined) updated[SAL_COL.PAYMENT_DATE] = paymentDate;
  updateSheetRow(SHEETS.SALARIES, idx + 1, updated);
  return { success: true };
}

function deleteSalary(body, user) {
  if (user.role !== 'superuser') return { success: false, message: 'Forbidden.' };
  const { id } = body;
  const rows = getSheetRows(SHEETS.SALARIES);
  const idx  = rows.findIndex(r => r[SAL_COL.ID] === id);
  if (idx < 0) return { success: false, message: 'Not found.' };
  deleteSheetRow(SHEETS.SALARIES, idx + 1);
  return { success: true };
}

/* ============================================================
   SHEET HELPERS
   ============================================================ */

function getSheetRows(sheetName) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  return data.slice(1); // skip header row
}

function appendSheetRow(sheetName, row) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(sheetName);
  sheet.appendRow(row);
}

function updateSheetRow(sheetName, rowIndex, values) {
  // rowIndex is 1-based data row (not counting header)
  const sheet   = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(sheetName);
  const sheetRow = rowIndex + 1; // +1 because header is row 1
  sheet.getRange(sheetRow, 1, 1, values.length).setValues([values]);
}

function deleteSheetRow(sheetName, rowIndex) {
  const sheet    = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(sheetName);
  const sheetRow = rowIndex + 1;
  sheet.deleteRow(sheetRow);
}

/* ============================================================
   FIRST-TIME SETUP — run once from Apps Script editor
   ============================================================
   HOW TO RUN:
   1. Open your script at https://script.google.com
   2. In the toolbar dropdown (next to the Run ▶ button),
      select  "setInitialPasswords"
   3. Click ▶ Run
   4. Done — all users now have GAS-compatible password hashes.
      You can now log in from the mobile app.
   ============================================================ */

// Change these before running if you want different default passwords
const INITIAL_PASSWORDS = {
  'admin':   'Admin@123',
  'karthi':  'Karthi@123',
  'chemban': 'Chemban@123',
  'cashier': 'Cashier@123'
};

function setInitialPasswords() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.USERS);
  if (!sheet) { Logger.log('Users sheet not found!'); return; }

  const data = sheet.getDataRange().getValues();
  // row 0 is header
  let updated = 0;
  for (let i = 1; i < data.length; i++) {
    const username = (data[i][USER_COL.USERNAME] || '').toLowerCase();
    const password = INITIAL_PASSWORDS[username];
    if (!password) {
      Logger.log('No password defined for user: ' + username + ' — skipping.');
      continue;
    }
    const newHash = hashPassword(password);
    sheet.getRange(i + 1, USER_COL.PASSWORD_HASH + 1).setValue(newHash);
    Logger.log('Updated password for: ' + username);
    updated++;
  }
  Logger.log('Done. ' + updated + ' user(s) updated.');
  SpreadsheetApp.flush();
}
