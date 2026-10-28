const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');

const SHEET = SHEETS.EXPENSES;
const QUANTITY_SHEET = SHEETS.EXPENSE_QUANTITIES;
const UNPAID_RECEIPTS_SHEET = SHEETS.UNPAID_RECEIPTS;
const UNPAID_ITEMS_SHEET = SHEETS.UNPAID_RECEIPT_ITEMS;
const RECEIPT_PAYMENTS_SHEET = SHEETS.RECEIPT_PAYMENTS;
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
const QUANTITY_C = { ID: 0, EXPENSE_ID: 1, CATEGORY_ID: 2, NAME: 3, UNIT: 4, AMOUNT: 5, CREATED_AT: 6, UPDATED_AT: 7, SOURCE_RECEIPT_ID: 8, UNIT_PRICE: 9, TOTAL_AMOUNT: 10 };
const RECEIPT_C = { ID: 0, RECEIVED_DATE: 1, TYPE_ID: 2, CATEGORY: 3, REMARKS: 4, SUBMITTED_BY: 5, TOTAL_AMOUNT: 6, CREATED_AT: 7, UPDATED_AT: 8, PAID_AMOUNT: 9 };
const RECEIPT_ITEM_C = { ID: 0, RECEIPT_ID: 1, CATEGORY_ID: 2, NAME: 3, UNIT: 4, AMOUNT: 5, CREATED_AT: 6, UPDATED_AT: 7 };
const RECEIPT_PAYMENT_C = { ID: 0, RECEIPT_ID: 1, EXPENSE_ID: 2, AMOUNT: 3, CREATED_AT: 4, CREATED_BY: 5 };

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

function quantityRowToObj(row) {
  return {
    id: row[QUANTITY_C.ID] || '', expenseId: row[QUANTITY_C.EXPENSE_ID] || '', quantityCategoryId: row[QUANTITY_C.CATEGORY_ID] || '',
    name: row[QUANTITY_C.NAME] || '', unit: row[QUANTITY_C.UNIT] || '', amount: parseFloat(row[QUANTITY_C.AMOUNT]) || 0,
    createdAt: row[QUANTITY_C.CREATED_AT] || '', updatedAt: row[QUANTITY_C.UPDATED_AT] || '',
    sourceReceiptId: row[QUANTITY_C.SOURCE_RECEIPT_ID] || '',
    unitPrice: parseFloat(row[QUANTITY_C.UNIT_PRICE]) || 0,
    totalAmount: row[QUANTITY_C.TOTAL_AMOUNT] === undefined || row[QUANTITY_C.TOTAL_AMOUNT] === '' ? '' : Number(row[QUANTITY_C.TOTAL_AMOUNT])
  };
}

function quantityObjToRow(quantity) {
  return [quantity.id, quantity.expenseId, quantity.quantityCategoryId, quantity.name, quantity.unit, quantity.amount, quantity.createdAt, quantity.updatedAt, quantity.sourceReceiptId || '', quantity.unitPrice || '', quantity.totalAmount ?? ''];
}

function parseUnitPrice(value) {
  if (value === undefined || value === null || value === '') return 0;
  const price = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(price * 100)) return NaN;
  return Math.round((price + Number.EPSILON) * 100) / 100;
}

// Called before any write so a bad price cannot leave an expense half saved.
function quantityPriceError(quantityLists) {
  const invalid = quantityLists.some(list => Array.isArray(list) && list.some(quantity => Number.isNaN(parseUnitPrice(quantity?.unitPrice)) || Number.isNaN(parseUnitPrice(quantity?.totalAmount))));
  return invalid ? 'Unit price and total must be valid non-negative numbers. Leave unknown values blank.' : '';
}

async function replaceExpenseQuantities(expenseId, quantities) {
  const rows = await getAllRows(QUANTITY_SHEET);
  // Rows sourced from a receipt are managed by the receipt link flow; leave them alone here.
  const oldRows = rows.map((row, index) => ({ row: quantityRowToObj(row), index: index + 2 }))
    .filter(item => item.row.expenseId === expenseId && !item.row.sourceReceiptId);
  for (const item of oldRows.sort((first, second) => second.index - first.index)) await deleteRow(QUANTITY_SHEET, item.index);
  const now = new Date().toISOString();
  for (const quantity of quantities || []) {
    const amount = parseFloat(quantity.amount);
    if (!(amount > 0) || !quantity.name || !quantity.unit) continue;
    await appendRow(QUANTITY_SHEET, quantityObjToRow({
      id: uuidv4(), expenseId, quantityCategoryId: String(quantity.quantityCategoryId), name: String(quantity.name),
      unit: String(quantity.unit), amount, unitPrice: parseUnitPrice(quantity.unitPrice),
      totalAmount: quantity.totalAmount === undefined || quantity.totalAmount === '' || quantity.totalAmount === null ? '' : parseUnitPrice(quantity.totalAmount), createdAt: now, updatedAt: now
    }));
  }
}

function unpaidReceiptRowToObj(row) {
  return {
    id: row[RECEIPT_C.ID] || '', receivedDate: row[RECEIPT_C.RECEIVED_DATE] || '',
    typeId: row[RECEIPT_C.TYPE_ID] || '', category: row[RECEIPT_C.CATEGORY] || '',
    remarks: row[RECEIPT_C.REMARKS] || '', submittedBy: row[RECEIPT_C.SUBMITTED_BY] || '',
    totalAmount: parseFloat(row[RECEIPT_C.TOTAL_AMOUNT]) || 0,
    paidAmount: parseFloat(row[RECEIPT_C.PAID_AMOUNT]) || 0,
    createdAt: row[RECEIPT_C.CREATED_AT] || '', updatedAt: row[RECEIPT_C.UPDATED_AT] || ''
  };
}

function unpaidReceiptObjToRow(receipt) {
  return [
    receipt.id, receipt.receivedDate, receipt.typeId, receipt.category,
    receipt.remarks, receipt.submittedBy, receipt.totalAmount,
    receipt.createdAt, receipt.updatedAt, receipt.paidAmount || 0
  ];
}

function unpaidItemRowToObj(row) {
  return {
    id: row[RECEIPT_ITEM_C.ID] || '', receiptId: row[RECEIPT_ITEM_C.RECEIPT_ID] || '',
    quantityCategoryId: row[RECEIPT_ITEM_C.CATEGORY_ID] || '', name: row[RECEIPT_ITEM_C.NAME] || '',
    unit: row[RECEIPT_ITEM_C.UNIT] || '', amount: parseFloat(row[RECEIPT_ITEM_C.AMOUNT]) || 0,
    createdAt: row[RECEIPT_ITEM_C.CREATED_AT] || '', updatedAt: row[RECEIPT_ITEM_C.UPDATED_AT] || ''
  };
}

function unpaidItemObjToRow(item) {
  return [item.id, item.receiptId, item.quantityCategoryId, item.name, item.unit, item.amount, item.createdAt, item.updatedAt];
}

async function replaceReceiptItems(receiptId, items) {
  const rows = await getAllRows(UNPAID_ITEMS_SHEET);
  const oldRows = rows.map((row, index) => ({ row: unpaidItemRowToObj(row), index: index + 2 }))
    .filter(item => item.row.receiptId === receiptId);
  for (const item of oldRows.sort((first, second) => second.index - first.index)) await deleteRow(UNPAID_ITEMS_SHEET, item.index);
  const now = new Date().toISOString();
  const saved = [];
  for (const item of items || []) {
    const amount = parseFloat(item.amount);
    if (!(amount > 0) || !item.name || !item.unit) continue;
    const obj = {
      id: uuidv4(), receiptId, quantityCategoryId: String(item.quantityCategoryId || ''),
      name: String(item.name), unit: String(item.unit), amount, createdAt: now, updatedAt: now
    };
    await appendRow(UNPAID_ITEMS_SHEET, unpaidItemObjToRow(obj));
    saved.push(obj);
  }
  return saved;
}

// Accumulate `payableAmount` currency toward an unpaid receipt. Payments are logged in ReceiptPayments so links can be reversed;
// item quantities are transferred to the settling expense only once the balance reaches zero. Receipts are never deleted here.
async function consumeUnpaidLink(receiptId, requestedAmount, expenseId, username) {
  const found = await findRowById(UNPAID_RECEIPTS_SHEET, receiptId);
  if (!found) throw new Error(`Unpaid receipt ${receiptId} not found.`);
  const receipt = unpaidReceiptRowToObj(found.row);
  const balance = +((receipt.totalAmount - receipt.paidAmount) || 0).toFixed(2);
  const consumePayable = Number.isFinite(requestedAmount) && requestedAmount > 0
    ? Math.min(requestedAmount, balance || requestedAmount)
    : balance;
  if (!(consumePayable > 0)) return { receipt, consumedPayable: 0, consumedItems: [] };
  const newPaid = +(receipt.paidAmount + consumePayable).toFixed(2);
  const fullyPaid = newPaid + 0.001 >= receipt.totalAmount;
  const now = new Date().toISOString();
  await appendRow(RECEIPT_PAYMENTS_SHEET, [uuidv4(), receiptId, expenseId, consumePayable, now, username || '']);
  await updateRow(UNPAID_RECEIPTS_SHEET, found.index, unpaidReceiptObjToRow({
    ...receipt, paidAmount: newPaid, updatedAt: now,
    submittedBy: receipt.submittedBy || username
  }));
  let consumedItems = [];
  if (fullyPaid) {
    const itemRows = (await getAllRows(UNPAID_ITEMS_SHEET)).map(unpaidItemRowToObj)
      .filter(item => item.receiptId === receiptId);
    consumedItems = itemRows.map(item => ({ ...item, consumedAmount: item.amount, sourceReceiptId: receiptId }));
  }
  return { receipt, consumedPayable: consumePayable, consumedItems };
}

// Append quantity rows linked to an expense from consumed unpaid entries. `sourceReceiptId` marks the origin so links can be reversed.
async function appendLinkedQuantityRows(expenseId, consumed) {
  const now = new Date().toISOString();
  for (const item of consumed) {
    if (!(item.consumedAmount > 0)) continue;
    await appendRow(QUANTITY_SHEET, quantityObjToRow({
      id: uuidv4(), expenseId, quantityCategoryId: String(item.quantityCategoryId || ''),
      name: String(item.name || ''), unit: String(item.unit || ''), amount: item.consumedAmount,
      createdAt: now, updatedAt: now, sourceReceiptId: String(item.sourceReceiptId || '')
    }));
  }
}

// Reverse every payment this expense made against a receipt: drop payment log rows, restore the receipt balance, and clean linked quantity rows.
async function reverseReceiptLink(expenseId, receiptId) {
  const paymentRows = (await getAllRows(RECEIPT_PAYMENTS_SHEET))
    .map((row, index) => ({
      obj: {
        id: row[RECEIPT_PAYMENT_C.ID] || '', receiptId: row[RECEIPT_PAYMENT_C.RECEIPT_ID] || '',
        expenseId: row[RECEIPT_PAYMENT_C.EXPENSE_ID] || '', amount: parseFloat(row[RECEIPT_PAYMENT_C.AMOUNT]) || 0
      },
      index: index + 2
    }))
    .filter(entry => entry.obj.receiptId === receiptId && entry.obj.expenseId === expenseId);
  if (!paymentRows.length) return 0;
  const reversedAmount = paymentRows.reduce((sum, entry) => sum + entry.obj.amount, 0);
  for (const entry of paymentRows.sort((first, second) => second.index - first.index)) await deleteRow(RECEIPT_PAYMENTS_SHEET, entry.index);
  const quantityRows = (await getAllRows(QUANTITY_SHEET))
    .map((row, index) => ({ obj: quantityRowToObj(row), index: index + 2 }))
    .filter(entry => entry.obj.expenseId === expenseId && entry.obj.sourceReceiptId === receiptId);
  for (const entry of quantityRows.sort((first, second) => second.index - first.index)) await deleteRow(QUANTITY_SHEET, entry.index);
  const receiptFound = await findRowById(UNPAID_RECEIPTS_SHEET, receiptId);
  if (receiptFound) {
    const receipt = unpaidReceiptRowToObj(receiptFound.row);
    const newPaid = Math.max(0, +(receipt.paidAmount - reversedAmount).toFixed(2));
    await updateRow(UNPAID_RECEIPTS_SHEET, receiptFound.index, unpaidReceiptObjToRow({
      ...receipt, paidAmount: newPaid, updatedAt: new Date().toISOString()
    }));
  }
  return reversedAmount;
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

router.get('/report', requireSuperUser, async (req, res) => {
  try {
    const { from = '', to = '', mode = 'Daily' } = req.query;
    const validDate = value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
    if (!validDate(from) || !validDate(to) || (from && to && from > to) || !['Daily', 'Occasional', 'All', 'None'].includes(mode)) {
      return res.status(400).json({ success: false, message: 'Select a valid report date range and expense mode.' });
    }
    const typeIds = new Set([].concat(req.query.typeId || []));
    const categories = new Set([].concat(req.query.category || []).map(value => String(value).trim().toLowerCase()));
    const expenses = (await getAllRows(SHEET)).map(rowToObj).filter(expense =>
      (!from || expense.date >= from) && (!to || expense.date <= to) &&
      (!typeIds.size || typeIds.has(expense.typeId)) &&
      (!categories.size || categories.has(String(expense.category).trim().toLowerCase())) &&
      mode !== 'None' && (mode === 'All' || (mode === 'Occasional') === (expense.mode === 'Occasional')));
    let quantities = [];
    if (req.query.quantities === '1' && expenses.length) {
      const ids = new Set(expenses.map(expense => expense.id));
      quantities = (await getAllRows(QUANTITY_SHEET)).map(quantityRowToObj).filter(quantity => ids.has(quantity.expenseId));
    }
    res.json({ success: true, data: { expenses, quantities } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/quantities', requireAuth, async (req, res) => {
  try {
    const expenseIds = new Set((await getAllRows(SHEET)).map(rowToObj).map(expense => expense.id));
    const quantities = (await getAllRows(QUANTITY_SHEET)).map(quantityRowToObj)
      .filter(quantity => expenseIds.has(quantity.expenseId));
    res.json({ success: true, data: quantities });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/unpaid', requireAuth, async (req, res) => {
  try {
    const access = await getExpenseAccess(req.session.user, true);
    const includeSettled = req.query.includeSettled === '1' || req.query.includeSettled === 'true';
    const receipts = (await getAllRows(UNPAID_RECEIPTS_SHEET)).map(unpaidReceiptRowToObj)
      .filter(receipt => (includeSettled || (receipt.totalAmount - receipt.paidAmount) > 0.001)
        && (receipt.typeId ? access.allowedTypes.has(receipt.typeId) : true));
    const validIds = new Set(receipts.map(receipt => receipt.id));
    const itemsByReceipt = new Map();
    (await getAllRows(UNPAID_ITEMS_SHEET)).map(unpaidItemRowToObj)
      .filter(item => validIds.has(item.receiptId))
      .forEach(item => {
        if (!itemsByReceipt.has(item.receiptId)) itemsByReceipt.set(item.receiptId, []);
        itemsByReceipt.get(item.receiptId).push(item);
      });
    const paymentsByReceipt = new Map();
    (await getAllRows(RECEIPT_PAYMENTS_SHEET))
      .map(row => ({
        id: row[RECEIPT_PAYMENT_C.ID] || '', receiptId: row[RECEIPT_PAYMENT_C.RECEIPT_ID] || '',
        expenseId: row[RECEIPT_PAYMENT_C.EXPENSE_ID] || '', amount: parseFloat(row[RECEIPT_PAYMENT_C.AMOUNT]) || 0,
        createdAt: row[RECEIPT_PAYMENT_C.CREATED_AT] || '', createdBy: row[RECEIPT_PAYMENT_C.CREATED_BY] || ''
      }))
      .filter(payment => validIds.has(payment.receiptId))
      .forEach(payment => {
        if (!paymentsByReceipt.has(payment.receiptId)) paymentsByReceipt.set(payment.receiptId, []);
        paymentsByReceipt.get(payment.receiptId).push(payment);
      });
    const data = receipts.map(receipt => ({
      ...receipt,
      items: itemsByReceipt.get(receipt.id) || [],
      payments: (paymentsByReceipt.get(receipt.id) || []).sort((first, second) => (first.createdAt || '').localeCompare(second.createdAt || ''))
    }));
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/unpaid', requireAuth, async (req, res) => {
  try {
    const { receivedDate, typeId, category, remarks, totalAmount, items } = req.body;
    const total = parseFloat(totalAmount);
    if (!receivedDate || !typeId || !category || !(total > 0) || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'receivedDate, typeId, category, a positive total amount and at least one item are required.' });
    }
    if (receivedDate > getBusinessDate()) return res.status(400).json({ success: false, message: 'Future dates cannot be used.' });
    if (items.some(item => !item.name || !item.unit || !(parseFloat(item.amount) > 0))) {
      return res.status(400).json({ success: false, message: 'Every item needs a name, unit and a positive quantity.' });
    }
    const access = await getExpenseAccess(req.session.user, true);
    if (!access.allowedTypes.has(String(typeId))) return res.status(403).json({ success: false, message: 'Access denied for this category type.' });
    const now = new Date().toISOString();
    const receipt = {
      id: uuidv4(), receivedDate: String(receivedDate), typeId: String(typeId),
      category: String(category).trim(), remarks: String(remarks || ''),
      submittedBy: req.session.user.username, totalAmount: total,
      createdAt: now, updatedAt: now
    };
    await appendRow(UNPAID_RECEIPTS_SHEET, unpaidReceiptObjToRow(receipt));
    const savedItems = await replaceReceiptItems(receipt.id, items);
    res.status(201).json({ success: true, data: { ...receipt, items: savedItems } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/unpaid/:id', requireAuth, async (req, res) => {
  try {
    const found = await findRowById(UNPAID_RECEIPTS_SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Unpaid receipt not found.' });
    const current = unpaidReceiptRowToObj(found.row);
    const access = await getExpenseAccess(req.session.user, true);
    if (current.typeId && !access.allowedTypes.has(current.typeId)) return res.status(403).json({ success: false, message: 'Access denied.' });
    const { receivedDate, typeId, category, remarks, totalAmount, items } = req.body;
    const total = parseFloat(totalAmount);
    if (!receivedDate || !typeId || !category || !(total > 0) || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: 'receivedDate, typeId, category, a positive total amount and at least one item are required.' });
    }
    if (items.some(item => !item.name || !item.unit || !(parseFloat(item.amount) > 0))) {
      return res.status(400).json({ success: false, message: 'Every item needs a name, unit and a positive quantity.' });
    }
    if (!access.allowedTypes.has(String(typeId))) return res.status(403).json({ success: false, message: 'Access denied for this category type.' });
    const updated = {
      ...current,
      receivedDate: String(receivedDate), typeId: String(typeId), category: String(category).trim(),
      remarks: String(remarks || ''), totalAmount: total, updatedAt: new Date().toISOString()
    };
    await updateRow(UNPAID_RECEIPTS_SHEET, found.index, unpaidReceiptObjToRow(updated));
    const savedItems = await replaceReceiptItems(updated.id, items);
    res.json({ success: true, data: { ...updated, items: savedItems } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/unpaid/:id', requireAuth, async (req, res) => {
  try {
    const found = await findRowById(UNPAID_RECEIPTS_SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Unpaid receipt not found.' });
    const current = unpaidReceiptRowToObj(found.row);
    const access = await getExpenseAccess(req.session.user, true);
    if (current.typeId && !access.allowedTypes.has(current.typeId)) return res.status(403).json({ success: false, message: 'Access denied.' });
    await replaceReceiptItems(current.id, []);
    await deleteRow(UNPAID_RECEIPTS_SHEET, found.index);
    res.json({ success: true, message: 'Unpaid receipt deleted.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Detach a previously-linked receivable from an expense (only while the expense is still editable).
router.delete('/:expenseId/unpaid-link/:receiptId', requireAuth, async (req, res) => {
  try {
    const { expenseId, receiptId } = req.params;
    const foundExpense = await findRowById(SHEET, expenseId);
    if (!foundExpense) return res.status(404).json({ success: false, message: 'Expense not found.' });
    const expense = rowToObj(foundExpense.row);
    if (expense.approvalStatus === 'Approved' || expense.approvalStatus === 'AutoApproved') {
      return res.status(409).json({ success: false, message: 'Approved expenses cannot be edited.' });
    }
    const access = await getExpenseAccess(req.session.user, true);
    if (expense.typeId ? !access.allowedTypes.has(expense.typeId) : !access.allowedCategories.has(expense.category)) {
      return res.status(403).json({ success: false, message: 'Access denied for this expense category.' });
    }
    const reversed = await reverseReceiptLink(expenseId, receiptId);
    if (!(reversed > 0)) return res.status(404).json({ success: false, message: 'No link found between this expense and receipt.' });
    res.json({ success: true, data: { reversedAmount: reversed } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
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
    const priceError = quantityPriceError(entries.map(entry => entry?.quantities));
    if (priceError) return res.status(400).json({ success: false, message: priceError });
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
    // Preserve placeholder rejections (empty category) until the cashier submits an entry for that type.
    const submittedTypeIds = new Set(matchedEntries.map(entry => String(entry.typeId || '')));
    const toDelete = editableRows.filter(item => {
      if (submittedIds.has(item.row.id)) return false;
      if (!item.row.category && item.row.approvalStatus === 'Rejected' && !submittedTypeIds.has(String(item.row.typeId))) return false;
      return true;
    }).map(item => item.index);
    const saved = [];
    for (const entry of matchedEntries) {
      const amount = parseFloat(entry.amount) || 0;
      const hasQuantities = Array.isArray(entry.quantities)
        && entry.quantities.some(quantity => parseFloat(quantity.amount) > 0);
      const hasLinks = Array.isArray(entry.linkedUnpaid) && entry.linkedUnpaid.length > 0;
      // Skip an entry only when there is nothing to store — a quantity- or link-only row is still meaningful.
      if (!entry.category || (!(amount > 0) && !hasQuantities && !hasLinks && !entry.id)) continue;
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
      await replaceExpenseQuantities(obj.id, entry.quantities);
      if (Array.isArray(entry.linkedUnpaid) && entry.linkedUnpaid.length) {
        const consumedItems = [];
        for (const link of entry.linkedUnpaid) {
          if (!link || !link.unpaidId) continue;
          const result = await consumeUnpaidLink(String(link.unpaidId), parseFloat(link.amount), obj.id, user.username);
          consumedItems.push(...result.consumedItems);
        }
        await appendLinkedQuantityRows(obj.id, consumedItems);
      }
      saved.push(obj);
    }
    for (let i = toDelete.length - 1; i >= 0; i--) {
      await replaceExpenseQuantities(rows[toDelete[i] - 2][C.ID], []);
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
    const { date, category, typeId, amount, remarks, quantities, linkedUnpaid } = req.body;
    if (!date || !category || !typeId || !(parseFloat(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'date, category, typeId and a positive amount are required.' });
    }
    if (date > getBusinessDate()) return res.status(400).json({ success: false, message: 'Future dates cannot be used.' });
    const priceError = quantityPriceError([quantities]);
    if (priceError) return res.status(400).json({ success: false, message: priceError });
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
    await replaceExpenseQuantities(obj.id, quantities);
    if (Array.isArray(linkedUnpaid) && linkedUnpaid.length) {
      const consumedItems = [];
      for (const link of linkedUnpaid) {
        if (!link || !link.unpaidId) continue;
        const result = await consumeUnpaidLink(String(link.unpaidId), parseFloat(link.amount), obj.id, user.username);
        consumedItems.push(...result.consumedItems);
      }
      await appendLinkedQuantityRows(obj.id, consumedItems);
    }
    res.status(201).json({ success: true, data: obj });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
});

router.put('/occasional/:id', requireAuth, async (req, res) => {
  try {
    const { date, category, typeId, amount, remarks, quantities, linkedUnpaid } = req.body;
    if (!date || !category || !typeId || !(parseFloat(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'date, category, typeId and a positive amount are required.' });
    }
    const priceError = quantityPriceError([quantities]);
    if (priceError) return res.status(400).json({ success: false, message: priceError });
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
    await replaceExpenseQuantities(updated.id, quantities);
    if (Array.isArray(linkedUnpaid) && linkedUnpaid.length) {
      const consumedItems = [];
      for (const link of linkedUnpaid) {
        if (!link || !link.unpaidId) continue;
        const result = await consumeUnpaidLink(String(link.unpaidId), parseFloat(link.amount), updated.id, req.session.user.username);
        consumedItems.push(...result.consumedItems);
      }
      await appendLinkedQuantityRows(updated.id, consumedItems);
    }
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
    const { reason, expenseIds, missingTypeIds } = req.body;
    const mode = req.body?.mode === 'Occasional' ? 'Occasional' : 'Daily';
    const ids = Array.isArray(expenseIds) ? expenseIds : [];
    const missingIds = Array.isArray(missingTypeIds) ? missingTypeIds : [];
    if (!ids.length && !missingIds.length) {
      return res.status(400).json({ success: false, message: 'Select at least one category or category type to reject.' });
    }
    const selectedIds = new Set(ids.map(String));
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
    // Placeholder rejected rows flag missing category types so the cashier is notified and can enter them.
    if (missingIds.length) {
      const typeRows = await getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES);
      const typeById = new Map(typeRows.map(row => [row[TYPE_C.ID] || '', row]));
      const existingPlaceholders = new Set(rows.map(rowToObj)
        .filter(obj => obj.date === date && !obj.employeeId && !obj.category && obj.approvalStatus === 'Rejected')
        .map(obj => obj.typeId));
      for (const typeId of missingIds.map(String)) {
        if (existingPlaceholders.has(typeId)) continue;
        const typeRow = typeById.get(typeId);
        if (!typeRow) continue;
        const typeMode = workflowToMode(typeRow[TYPE_C.WORKFLOW]);
        if ((mode === 'Occasional') !== (typeMode === 'Occasional')) continue;
        const now = new Date().toISOString();
        await appendRow(SHEET, objToRow({
          id: uuidv4(), date, category: '', description: '', amount: 0,
          employeeId: '', employeeName: '', submittedBy: '', approvalStatus: 'Rejected',
          approvedBy: user.username, approvedAt: now, rejectionReason: reason || '',
          createdAt: now, typeId, onSpot: false, paymentId: '', shift: '', mode: typeMode,
          updatedBy: user.username, updatedAt: now
        }));
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
    await replaceExpenseQuantities(expense.id, []);
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Expense deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
