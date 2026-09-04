const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');

const SHEET = SHEETS.EXPENSES;
const bulkSaveLocks = new Map();
// Columns: ID, Date, Category, Description, Amount, EmployeeID, EmployeeName,
//          SubmittedBy, ApprovalStatus, ApprovedBy, ApprovedAt, RejectionReason, CreatedAt
const C = {
  ID: 0, DATE: 1, CATEGORY: 2, DESCRIPTION: 3, AMOUNT: 4,
  EMP_ID: 5, EMP_NAME: 6,
  SUBMITTED_BY: 7, APPROVAL_STATUS: 8, APPROVED_BY: 9,
  APPROVED_AT: 10, REJECTION_REASON: 11, CREATED_AT: 12,
  TYPE_ID: 13, ON_SPOT: 14, PAYMENT_ID: 15, SHIFT: 16, MODE: 17, UPDATED_BY: 18, UPDATED_AT: 19
};

const TYPE_C = { ID: 0, NAME: 1, ORDER: 2, STATUS: 3, ACCESS_MODE: 4, ALLOWED_USERS: 5, WORKFLOW: 7 };

async function withBulkSaveLock(date, operation) {
  const previous = bulkSaveLocks.get(date) || Promise.resolve();
  const queued = previous.then(operation);
  const completion = queued.catch(() => {});
  bulkSaveLocks.set(date, completion);
  try {
    return await queued;
  } finally {
    if (bulkSaveLocks.get(date) === completion) bulkSaveLocks.delete(date);
  }
}

function normalizeWorkflow(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'occasional' || normalized === 'occasional_excluded') return 'Occasional';
  if (normalized === 'daily non cash' || normalized === 'daily_non_cash' || normalized === 'dailycashexcluded') return 'Daily Non Cash';
  return 'Daily Cash';
}

function workflowToMode(workflow) {
  const normalized = normalizeWorkflow(workflow);
  if (normalized === 'Occasional') return 'Occasional';
  if (normalized === 'Daily Non Cash') return 'Daily Non Cash';
  return 'Daily Cash';
}

function normalizeExpenseMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'occasional') return 'Occasional';
  if (normalized === 'daily non cash' || normalized === 'daily_non_cash') return 'Daily Non Cash';
  return 'Daily Cash';
}

function isOccasionalMode(value) {
  return normalizeExpenseMode(value) === 'Occasional';
}

function expenseIdentity(date, typeId, category) {
  return `${date}|${typeId}|${String(category || '').trim().toLowerCase()}`;
}

function getBusinessDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function typeAllowed(row, user) {
  if (user.role === 'superuser') return true;
  if ((row[TYPE_C.STATUS] || 'Active') !== 'Active') return false;
  if (row[TYPE_C.ACCESS_MODE] !== 'Limited') return true;
  return String(row[TYPE_C.ALLOWED_USERS] || '').split(',').map(v => v.trim()).includes(user.id);
}

async function getVisibleCategoryNames(user, includeInactive = false) {
  const [categoryRows, typeRows] = await Promise.all([
    getAllRows(SHEETS.EXPENSE_CATEGORIES), getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES)
  ]);
  const allowedTypes = new Set(typeRows.filter(row => typeAllowed(row, user)).map(row => row[TYPE_C.ID] || ''));
    const legacyType = typeRows.find(row => (row[TYPE_C.NAME] || '') === 'General') || typeRows.find(row => parseInt(row[TYPE_C.ORDER]) === 1) || typeRows[0];
    const hasGeneral = !legacyType || typeAllowed(legacyType, user);
  return new Set(categoryRows.filter(row => {
    if (!includeInactive && (row[3] || 'Active') !== 'Active') return false;
    return row[4] ? allowedTypes.has(row[4]) : hasGeneral;
  }).map(row => row[1] || '').filter(Boolean));
}

async function getExpenseAccess(user, includeInactive = false) {
  const [categoryRows, typeRows] = await Promise.all([
    getAllRows(SHEETS.EXPENSE_CATEGORIES), getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES)
  ]);
  const allowedTypes = new Set(typeRows.filter(row => typeAllowed(row, user)).map(row => row[TYPE_C.ID] || ''));
  const legacyType = typeRows.find(row => (row[TYPE_C.NAME] || '') === 'General') || typeRows.find(row => parseInt(row[TYPE_C.ORDER]) === 1) || typeRows[0];
  const categoryTypes = new Map(categoryRows.map(row => [row[1] || '', row[4] || legacyType?.[TYPE_C.ID] || '']));
  const typeModes = new Map(typeRows.map(row => [row[TYPE_C.ID] || '', workflowToMode(row[TYPE_C.WORKFLOW])]));
  const allowedCategories = new Set(categoryRows.filter(row => (includeInactive || (row[3] || 'Active') === 'Active') && (row[4] ? allowedTypes.has(row[4]) : !legacyType || typeAllowed(legacyType, user))).map(row => row[1] || ''));
  return { allowedTypes, allowedCategories, categoryTypes, typeModes, legacyTypeId: legacyType?.[TYPE_C.ID] || '' };
}

function rowToObj(row) {
  return {
    id:               row[C.ID]              || '',
    date:             row[C.DATE]            || '',
    category:         row[C.CATEGORY]        || '',
    description:      row[C.DESCRIPTION]     || '',
    amount:           parseFloat(row[C.AMOUNT]) || 0,
    employeeId:       row[C.EMP_ID]          || '',
    employeeName:     row[C.EMP_NAME]        || '',
    submittedBy:      row[C.SUBMITTED_BY]    || '',
    approvalStatus:   row[C.APPROVAL_STATUS] || 'Pending',
    approvedBy:       row[C.APPROVED_BY]     || '',
    approvedAt:       row[C.APPROVED_AT]     || '',
    rejectionReason:  row[C.REJECTION_REASON]|| '',
    createdAt:        row[C.CREATED_AT]      || '',
    typeId:           row[C.TYPE_ID]         || '',
    onSpot:           String(row[C.ON_SPOT] || '').toLowerCase() === 'true',
    paymentId:        row[C.PAYMENT_ID] || '',
    shift:            row[C.SHIFT] || '',
    mode:             normalizeExpenseMode(row[C.MODE]),
    updatedBy:         row[C.UPDATED_BY] || '',
    updatedAt:         row[C.UPDATED_AT] || ''
  };
}

function objToRow(o) {
  return [
    o.id, o.date, o.category, o.description, o.amount,
    o.employeeId, o.employeeName,
    o.submittedBy, o.approvalStatus, o.approvedBy,
    o.approvedAt, o.rejectionReason, o.createdAt, o.typeId || '', o.onSpot ? 'TRUE' : '', o.paymentId || '', o.shift || '', normalizeExpenseMode(o.mode), o.updatedBy || '', o.updatedAt || ''
  ];
}

async function getAutoApprovalSettings() {
  const rows = await getAllRows(SHEETS.SETTINGS);
  const enabled = rows.find(row => row[0] === 'AUTO_APPROVAL_ENABLED')?.[1];
  const configuredDays = parseInt(rows.find(row => row[0] === 'AUTO_APPROVAL_DAYS')?.[1], 10);
  return { enabled: enabled === undefined || enabled === '' || String(enabled).toLowerCase() === 'true', days: configuredDays >= 1 ? configuredDays : 2 };
}

// Auto-approve pending rows only when the setting is enabled and their delay has passed.
async function runAutoApproval(rows) {
  const settings = await getAutoApprovalSettings();
  if (!settings.enabled) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - settings.days);
  for (let i = 0; i < rows.length; i++) {
    const obj = rowToObj(rows[i]);
    if (obj.approvalStatus === 'Pending') {
      const created = new Date(obj.createdAt);
      if (!isNaN(created) && created < cutoff) {
        obj.approvalStatus = 'AutoApproved';
        obj.approvedBy     = 'system';
        obj.approvedAt     = new Date().toISOString();
        await updateRow(SHEET, i + 2, objToRow(obj));
        rows[i] = objToRow(obj); // update in-memory copy
      }
    }
  }
}

// GET all
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await getAllRows(SHEET);
    await runAutoApproval(rows);
    const access = await getExpenseAccess(req.session.user, true);
    const data = rows.map(rowToObj).filter(exp => {
      if (exp.employeeId) return true;
      return exp.typeId ? access.allowedTypes.has(exp.typeId) : access.allowedCategories.has(exp.category);
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Expense not found.' });
    const expense = rowToObj(found.row);
    const access = await getExpenseAccess(req.session.user, true);
    if (!expense.employeeId && !(expense.typeId ? access.allowedTypes.has(expense.typeId) : access.allowedCategories.has(expense.category))) return res.status(403).json({ success: false, message: 'Access denied for this expense category.' });
    res.json({ success: true, data: expense });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST bulk save
router.post('/bulk', requireAuth, async (req, res) => {
  return withBulkSaveLock(String(req.body?.date || ''), async () => {
    try {
    const { date, entries, remarks } = req.body;
    if (!date || !Array.isArray(entries)) {
      return res.status(400).json({ success: false, message: 'date and entries[] are required.' });
    }
    const todayDate = getBusinessDate();
    if (date > todayDate) return res.status(400).json({ success: false, message: 'Future dates cannot be saved.' });
    const user = req.session.user;
    const isSuperUser = user.role === 'superuser';
    const approvalStatus = 'Pending';
    const access = await getExpenseAccess(user);
    const categoryNames = new Map([...access.categoryTypes.keys()].map(name => [String(name).trim().toLowerCase(), name]));
    const normalizedEntries = entries.map(entry => {
      const category = String(entry.category || '').trim();
      return { ...entry, category: entry.onSpot ? category : (categoryNames.get(category.toLowerCase()) || category) };
    });
    const validEntries = normalizedEntries.filter(entry => {
      const typeId = String(entry.typeId || access.categoryTypes.get(entry.category) || access.legacyTypeId);
      return access.allowedTypes.has(typeId) && (entry.onSpot || access.allowedCategories.has(String(entry.category)));
    }).map(entry => {
      const typeId = String(entry.typeId || access.categoryTypes.get(entry.category) || access.legacyTypeId);
      return {
        ...entry,
        typeId,
        mode: access.typeModes.get(typeId) || 'Daily Cash'
      };
    });
    const rows = await getAllRows(SHEET);
    const dateRows = rows.map(rowToObj).filter(row => row.date === date && !row.employeeId && !isOccasionalMode(row.mode));
    const rejectedRows = dateRows.filter(row => row.approvalStatus === 'Rejected');
    const partialCorrection = rejectedRows.length > 0 || (dateRows.some(row => row.approvalStatus === 'Pending') &&
      dateRows.some(row => row.approvalStatus === 'Approved' || row.approvalStatus === 'AutoApproved'));
    if (!validEntries.length && !rejectedRows.length) return res.status(403).json({ success: false, message: 'You do not have access to the selected expense categories.' });
    if (!partialCorrection && dateRows.some(row => row.approvalStatus === 'Approved' || row.approvalStatus === 'AutoApproved')) {
      return res.status(409).json({ success: false, message: 'Approved dates cannot be edited.' });
    }

    // Corrections update rejected rows only; normal pending entries update in place.
    const editableRows = [];
    for (let i = 0; i < rows.length; i++) {
      const existing = rowToObj(rows[i]);
      if (
        rows[i][C.DATE] === date &&
        !rows[i][C.EMP_ID] &&
        !isOccasionalMode(rows[i][C.MODE]) &&
        (partialCorrection ? existing.approvalStatus === 'Rejected' || existing.approvalStatus === 'Pending' : true) &&
        (existing.typeId ? access.allowedTypes.has(existing.typeId) : access.allowedCategories.has(existing.category))
      ) {
        editableRows.push({ row: existing, index: i + 2 });
      }
    }
    const editableById = new Map(editableRows.map(item => [item.row.id, item]));
    const writableRows = rows.map((row, index) => ({ row: rowToObj(row), index: index + 2 })).filter(item =>
      item.row.date === date && !item.row.employeeId && !isOccasionalMode(item.row.mode) &&
      item.row.approvalStatus !== 'Approved' && item.row.approvalStatus !== 'AutoApproved' &&
      (item.row.typeId ? access.allowedTypes.has(item.row.typeId) : access.allowedCategories.has(item.row.category)));
    const writableById = new Map(writableRows.map(item => [item.row.id, item]));
    const entryKey = entry => expenseIdentity(date, entry.typeId, entry.category);
    const submittedKeys = validEntries.map(entryKey);
    if (new Set(submittedKeys).size !== submittedKeys.length) {
      return res.status(400).json({ success: false, message: 'Each category can be entered only once per category type.' });
    }
    const matchedEntries = validEntries.map(entry => {
      if (entry.id && writableById.has(String(entry.id))) return entry;
      const identity = entryKey(entry);
      const matches = writableRows.filter(item =>
        expenseIdentity(item.row.date, item.row.typeId, item.row.category) === identity);
      if (matches.length > 1) throw new Error('Duplicate expense rows exist for this category. Resolve them before saving.');
      if (matches.length === 1) return { ...entry, id: matches[0].row.id };
      return partialCorrection ? { ...entry, id: '' } : entry;
    });
    const writableIds = new Set(writableRows.map(item => item.row.id));
    const submittedIdentities = new Set(matchedEntries.map(entryKey));
    const conflicts = rows.map(rowToObj).filter(existing =>
      submittedIdentities.has(expenseIdentity(existing.date, existing.typeId, existing.category)) &&
      !existing.employeeId &&
      !writableIds.has(existing.id));
    if (conflicts.length) {
      return res.status(409).json({ success: false, message: 'An expense already exists for this date, category type, and category.' });
    }
    const submittedIds = new Set(matchedEntries.map(entry => String(entry.id || '')).filter(Boolean));
    if ([...submittedIds].some(id => !writableById.has(id))) {
      return res.status(409).json({ success: false, message: 'This expense was changed by another user. Refresh and try again.' });
    }
    const toDelete = editableRows.filter(item => !submittedIds.has(item.row.id)).map(item => item.index);
    const saved = [];
    for (const entry of matchedEntries) {
      const amount = parseFloat(entry.amount);
      if (!entry.category || !(amount > 0)) continue;
      const existing = entry.id ? writableById.get(String(entry.id))?.row : null;
      const obj = {
        id: existing?.id || uuidv4(), date,
        category: String(entry.category),
        description: String(remarks || ''),
        amount,
        employeeId: '', employeeName: '',
        submittedBy:    existing?.submittedBy || user.username,
        approvalStatus,
        approvedBy:     '',
        approvedAt:     '',
        rejectionReason: '',
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedBy: user.username,
        updatedAt: new Date().toISOString(),
        typeId: entry.typeId,
        onSpot: !!entry.onSpot,
        mode: entry.mode
      };
      if (existing) await updateRow(SHEET, writableById.get(existing.id).index, objToRow(obj));
      else await appendRow(SHEET, objToRow(obj));
      saved.push(obj);
    }
    for (let i = toDelete.length - 1; i >= 0; i--) {
      await deleteRow(SHEET, toDelete[i]);
    }
    res.json({ success: true, data: saved });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
});

// POST a single occasional expense. These entries are intentionally excluded from daily cash-sales totals.
router.post('/occasional', requireAuth, async (req, res) => {
  return withBulkSaveLock(String(req.body?.date || ''), async () => {
    try {
    const { date, category, typeId, amount, remarks } = req.body;
    if (!date || !category || !typeId || !(parseFloat(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'date, category, typeId and a positive amount are required.' });
    }
    if (date > getBusinessDate()) return res.status(400).json({ success: false, message: 'Future dates cannot be used.' });
    const user = req.session.user;
    const access = await getExpenseAccess(user);
    if (!access.allowedTypes.has(typeId) || !access.allowedCategories.has(String(category)) || access.typeModes.get(typeId) !== 'Occasional') {
      return res.status(403).json({ success: false, message: 'You do not have access to this occasional expense category.' });
    }
    const rows = await getAllRows(SHEET);
    if (rows.map(rowToObj).some(existing => expenseIdentity(existing.date, existing.typeId, existing.category) === expenseIdentity(date, typeId, category))) {
      return res.status(409).json({ success: false, message: 'An expense already exists for this date, category type, and category.' });
    }
    const obj = {
      id: uuidv4(), date, category: String(category), description: String(remarks || ''), amount: parseFloat(amount),
      employeeId: '', employeeName: '', submittedBy: user.username, approvalStatus: 'Pending', approvedBy: '', approvedAt: '',
      rejectionReason: '', createdAt: new Date().toISOString(), updatedBy: user.username, updatedAt: new Date().toISOString(), typeId, onSpot: false, paymentId: '', mode: 'Occasional'
    };
    await appendRow(SHEET, objToRow(obj));
    res.status(201).json({ success: true, data: obj });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
});

router.put('/occasional/:id', requireAuth, async (req, res) => {
  try {
    const { date, category, typeId, amount, remarks } = req.body;
    if (!date || !category || !typeId || !(parseFloat(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'date, category, typeId and a positive amount are required.' });
    }
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Occasional expense not found.' });
    const existing = rowToObj(found.row);
    if (!isOccasionalMode(existing.mode)) return res.status(400).json({ success: false, message: 'This expense is not occasional.' });
    if (existing.approvalStatus === 'Approved' || existing.approvalStatus === 'AutoApproved') {
      return res.status(409).json({ success: false, message: 'Approved expenses cannot be edited.' });
    }
    const access = await getExpenseAccess(req.session.user);
    if (!access.allowedTypes.has(typeId) || !access.allowedCategories.has(String(category)) || access.typeModes.get(typeId) !== 'Occasional') {
      return res.status(403).json({ success: false, message: 'You do not have access to this occasional expense category.' });
    }
    const rows = await getAllRows(SHEET);
    if (rows.map(rowToObj).some(row => row.id !== existing.id &&
      expenseIdentity(row.date, row.typeId, row.category) === expenseIdentity(date, typeId, category))) {
      return res.status(409).json({ success: false, message: 'An expense already exists for this date, category type, and category.' });
    }
    const updated = {
      ...existing, date, category: String(category).trim(), typeId, amount: parseFloat(amount),
      description: String(remarks || ''), approvalStatus: 'Pending', approvedBy: '', approvedAt: '', rejectionReason: '',
      updatedBy: req.session.user.username, updatedAt: new Date().toISOString(), mode: 'Occasional'
    };
    await updateRow(SHEET, found.index, objToRow(updated));
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST approve a date (super user only)
router.post('/approve/:date', requireSuperUser, async (req, res) => {
  try {
    const { date } = req.params;
    const mode = req.body?.mode === 'Occasional' ? 'Occasional' : 'Daily';
    const user = req.session.user;
    const rows = await getAllRows(SHEET);
    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      const obj = rowToObj(rows[i]);
      if (obj.date === date && (mode === 'Occasional' ? isOccasionalMode(obj.mode) : !isOccasionalMode(obj.mode)) &&
        obj.approvalStatus === 'Pending' && obj.submittedBy !== user.username) {
        obj.approvalStatus = 'Approved';
        obj.approvedBy     = user.username;
        obj.approvedAt     = new Date().toISOString();
        obj.rejectionReason = '';
        await updateRow(SHEET, i + 2, objToRow(obj));
        updated++;
      }
    }
    res.json({ success: true, data: { updated } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST reject a date (super user only)
router.post('/reject/:date', requireSuperUser, async (req, res) => {
  try {
    const { date } = req.params;
    const { reason, expenseIds } = req.body;
    const mode = req.body?.mode === 'Occasional' ? 'Occasional' : 'Daily';
    if (!Array.isArray(expenseIds) || !expenseIds.length) {
      return res.status(400).json({ success: false, message: 'Select at least one category or category type to reject.' });
    }
    const selectedIds = new Set(expenseIds.map(String));
    const user = req.session.user;
    const rows = await getAllRows(SHEET);
    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      const obj = rowToObj(rows[i]);
      if (obj.date === date && selectedIds.has(obj.id) && !obj.employeeId &&
        (mode === 'Occasional' ? isOccasionalMode(obj.mode) : !isOccasionalMode(obj.mode)) &&
        (obj.approvalStatus === 'Pending' || obj.approvalStatus === 'Approved' || obj.approvalStatus === 'AutoApproved')) {
        obj.approvalStatus  = 'Rejected';
        obj.approvedBy      = user.username;
        obj.approvedAt      = new Date().toISOString();
        obj.rejectionReason = reason || '';
        await updateRow(SHEET, i + 2, objToRow(obj));
        updated++;
      }
    }
    res.json({ success: true, data: { updated } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE editable on-spot or occasional expenses
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Expense not found.' });
    const expense = rowToObj(found.row);
    const deletable = expense.onSpot || expense.mode === 'Occasional';
    if (!deletable) return res.status(403).json({ success: false, message: 'Only on-spot or occasional expenses can be deleted here.' });
    if (expense.approvalStatus === 'Approved' || expense.approvalStatus === 'AutoApproved') {
      return res.status(409).json({ success: false, message: 'Approved expenses cannot be deleted.' });
    }
    const access = await getExpenseAccess(req.session.user, true);
    if (expense.typeId ? !access.allowedTypes.has(expense.typeId) : !access.allowedCategories.has(expense.category)) {
      return res.status(403).json({ success: false, message: 'Access denied for this expense category.' });
    }
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Expense deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
