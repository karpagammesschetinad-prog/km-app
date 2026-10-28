const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');

const SHEET = SHEETS.QUANTITY_CONSUMPTIONS;
const QUANTITY_SHEET = SHEETS.EXPENSE_QUANTITIES;
const RECEIPT_ITEM_SHEET = SHEETS.UNPAID_RECEIPT_ITEMS;
const QUANTITY_CATEGORY_SHEET = SHEETS.EXPENSE_QUANTITY_CATEGORIES;
const EXPENSE_CATEGORY_SHEET = SHEETS.EXPENSE_CATEGORIES;
const EXPENSE_SHEET = SHEETS.EXPENSES;
const UNPAID_RECEIPT_SHEET = SHEETS.UNPAID_RECEIPTS;

// Sheet column index shorthand — keep aligned with HEADERS.QUANTITY_CONSUMPTIONS.
// The sheet stores `usedAmount` (a delta). The current available stock is derived at read time so that
// any incoming that gets added later flows straight into "available" without retroactively rewriting rows.
const C = {
  ID: 0, DATE: 1, QCAT_ID: 2, NAME: 3, UNIT: 4, USED_AMOUNT: 5, REMARKS: 6,
  CREATED_BY: 7, CREATED_BY_NAME: 8, CREATED_AT: 9,
  UPDATED_BY: 10, UPDATED_BY_NAME: 11, UPDATED_AT: 12
};

const QCAT_C = { ID: 0, CATEGORY_ID: 1, NAME: 2, UNIT: 3, ORDER: 4, STATUS: 5, AUTO_CONSUME: 6 };
const EQ_C = { ID: 0, EXPENSE_ID: 1, CATEGORY_ID: 2, NAME: 3, UNIT: 4, AMOUNT: 5 };
const RI_C = { ID: 0, RECEIPT_ID: 1, CATEGORY_ID: 2, NAME: 3, UNIT: 4, AMOUNT: 5 };
const EXPENSE_C = { ID: 0, DATE: 1 };
const EXPENSE_CAT_C = { ID: 0, NAME: 1 };
const RECEIPT_C = { ID: 0, RECEIVED_DATE: 1 };

function getBusinessDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function rawRowToObj(row) {
  return {
    id: row[C.ID] || '',
    date: row[C.DATE] || '',
    quantityCategoryId: row[C.QCAT_ID] || '',
    name: row[C.NAME] || '',
    unit: row[C.UNIT] || '',
    usedAmount: parseFloat(row[C.USED_AMOUNT]) || 0,
    remarks: row[C.REMARKS] || '',
    createdBy: row[C.CREATED_BY] || '',
    createdByName: row[C.CREATED_BY_NAME] || '',
    createdAt: row[C.CREATED_AT] || '',
    updatedBy: row[C.UPDATED_BY] || '',
    updatedByName: row[C.UPDATED_BY_NAME] || '',
    updatedAt: row[C.UPDATED_AT] || ''
  };
}

function objToRow(o) {
  return [
    o.id, o.date, o.quantityCategoryId, o.name, o.unit, o.usedAmount, o.remarks || '',
    o.createdBy || '', o.createdByName || '', o.createdAt || '',
    o.updatedBy || '', o.updatedByName || '', o.updatedAt || ''
  ];
}

async function loadQuantityCategories() {
  const rows = await getAllRows(QUANTITY_CATEGORY_SHEET);
  return rows.map(row => ({
    id: row[QCAT_C.ID] || '',
    categoryId: row[QCAT_C.CATEGORY_ID] || '',
    name: row[QCAT_C.NAME] || '',
    unit: row[QCAT_C.UNIT] || 'Count',
    sortOrder: parseInt(row[QCAT_C.ORDER]) || 0,
    status: row[QCAT_C.STATUS] || 'Active',
    autoConsume: String(row[QCAT_C.AUTO_CONSUME] || '').toLowerCase() === 'true'
  }));
}

// Returns Map<quantityCategoryId, { events: [{ date, amount, source }], paid, unpaid, name, unit }>.
async function loadIncomingByCategory() {
  const [expenseQtyRows, expenseRows, receiptItemRows, receiptRows] = await Promise.all([
    getAllRows(QUANTITY_SHEET), getAllRows(EXPENSE_SHEET),
    getAllRows(RECEIPT_ITEM_SHEET), getAllRows(UNPAID_RECEIPT_SHEET)
  ]);
  const expenseDates = new Map(expenseRows.map(row => [row[EXPENSE_C.ID], row[EXPENSE_C.DATE] || '']));
  const receiptDates = new Map(receiptRows.map(row => [row[RECEIPT_C.ID], row[RECEIPT_C.RECEIVED_DATE] || '']));
  const map = new Map();
  const bucketFor = (categoryId, name, unit) => {
    const key = String(categoryId || '');
    if (!key) return null;
    if (!map.has(key)) map.set(key, { events: [], paid: 0, unpaid: 0, name: name || '', unit: unit || '' });
    const bucket = map.get(key);
    if (!bucket.name && name) bucket.name = name;
    if (!bucket.unit && unit) bucket.unit = unit;
    return bucket;
  };
  for (const row of expenseQtyRows) {
    const amount = parseFloat(row[EQ_C.AMOUNT]) || 0;
    if (!(amount > 0)) continue;
    const bucket = bucketFor(row[EQ_C.CATEGORY_ID], row[EQ_C.NAME], row[EQ_C.UNIT]);
    if (!bucket) continue;
    // Missing expense row means the join failed; count it from day zero so nothing is silently dropped.
    const date = expenseDates.get(row[EQ_C.EXPENSE_ID]) || '';
    bucket.events.push({ date, amount, source: 'paid' });
    bucket.paid += amount;
  }
  for (const row of receiptItemRows) {
    const amount = parseFloat(row[RI_C.AMOUNT]) || 0;
    if (!(amount > 0)) continue;
    const bucket = bucketFor(row[RI_C.CATEGORY_ID], row[RI_C.NAME], row[RI_C.UNIT]);
    if (!bucket) continue;
    const date = receiptDates.get(row[RI_C.RECEIPT_ID]) || '';
    bucket.events.push({ date, amount, source: 'unpaid' });
    bucket.unpaid += amount;
  }
  for (const bucket of map.values()) bucket.events.sort((first, second) => first.date.localeCompare(second.date));
  return map;
}

function incomingUpTo(events, dateInclusive) {
  let total = 0;
  for (const event of events) {
    if (event.date <= dateInclusive) total += event.amount;
    else break;
  }
  return total;
}

// Walks entries chronologically per quantity and derives per-entry availableStock (snapshot of stock
// right after this observation) from the running usedAmount and incoming totals.
function annotateEntries(entriesByCategory, incomingMap) {
  const result = [];
  for (const [categoryId, entries] of entriesByCategory.entries()) {
    const events = incomingMap.get(categoryId)?.events || [];
    const sorted = [...entries].sort((first, second) =>
      first.date.localeCompare(second.date) || (first.createdAt || '').localeCompare(second.createdAt || ''));
    let runningUsed = 0;
    for (const entry of sorted) {
      const incomingAtEntry = incomingUpTo(events, entry.date);
      const availableBefore = incomingAtEntry - runningUsed;
      runningUsed += entry.usedAmount;
      const availableStock = incomingAtEntry - runningUsed;
      result.push({ ...entry, availableStock, priorAvailable: availableBefore });
    }
  }
  return result;
}

async function loadAnnotatedEntries() {
  const [rows, incomingMap] = await Promise.all([getAllRows(SHEET), loadIncomingByCategory()]);
  const entries = rows.map(rawRowToObj);
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.quantityCategoryId)) grouped.set(entry.quantityCategoryId, []);
    grouped.get(entry.quantityCategoryId).push(entry);
  }
  return { annotated: annotateEntries(grouped, incomingMap), incomingMap };
}

// Available stock as-of a given date for a single quantity, optionally ignoring one entry (for edits).
// Formula: availableBeforeEntry = totalIncomingByDate − sum(usedAmount for prior entries on ≤ this date).
async function projectAvailability(quantityCategoryId, asOfDate, excludeEntryId = null) {
  const [rows, incomingMap] = await Promise.all([getAllRows(SHEET), loadIncomingByCategory()]);
  const events = incomingMap.get(String(quantityCategoryId))?.events || [];
  const priorEntries = rows.map(rawRowToObj)
    .filter(entry => entry.quantityCategoryId === String(quantityCategoryId) && entry.id !== excludeEntryId
      && entry.date <= asOfDate)
    .sort((first, second) =>
      first.date.localeCompare(second.date) || (first.createdAt || '').localeCompare(second.createdAt || ''));
  const usedPrior = priorEntries.reduce((sum, entry) => sum + entry.usedAmount, 0);
  const incomingAsOf = incomingUpTo(events, asOfDate);
  const availableBeforeEntry = incomingAsOf - usedPrior;
  const lastPrior = priorEntries[priorEntries.length - 1];
  const priorDate = lastPrior ? lastPrior.date : '0000-00-00';
  const incomingSincePrior = incomingAsOf - incomingUpTo(events, priorDate);
  // priorAvailable = the derived availableStock of the last observation (what the user would have seen there).
  const priorAvailable = lastPrior ? (incomingUpTo(events, lastPrior.date) - usedPrior) : 0;
  return {
    priorEntry: lastPrior ? { id: lastPrior.id, date: lastPrior.date, usedAmount: lastPrior.usedAmount, availableStock: priorAvailable } : null,
    priorAvailable,
    incomingSincePrior,
    availableBeforeEntry
  };
}

async function validateAndBuildEntry({ date, availableStock, allowAnomaly }, category, excludeEntryId) {
  const stock = parseFloat(availableStock);
  if (!Number.isFinite(stock)) {
    const err = new Error('availableStock must be a number.');
    err.status = 400;
    throw err;
  }
  const projection = await projectAvailability(category.id, date, excludeEntryId);
  const availableBefore = projection.availableBeforeEntry;
  const usedAmount = availableBefore - stock;
  // Reported stock exceeds what was available — likely a missing incoming entry.
  if (stock > availableBefore + 1e-6 && !allowAnomaly) {
    const error = new Error(`Reported stock (${stock} ${category.unit}) exceeds what was available (${availableBefore.toFixed(3)} ${category.unit}). Add the missing incoming or tick the override.`);
    error.status = 409;
    error.code = 'STOCK_ANOMALY_HIGH';
    error.data = { ...projection, availableStock: stock, usedAmount };
    throw error;
  }
  // Reported stock is zero or negative — used all incoming so far, which violates the "incoming > consumed" rule.
  if (stock <= 1e-6 && !allowAnomaly) {
    const error = new Error(`Available stock cannot be zero — incoming must exceed consumed (only ${availableBefore.toFixed(3)} ${category.unit} was available). Adjust the entry or tick the override.`);
    error.status = 409;
    error.code = 'STOCK_ANOMALY_OVERCONSUMED';
    error.data = { ...projection, availableStock: stock, usedAmount };
    throw error;
  }
  return { usedAmount, projection };
}

// GET /api/consumption — list entries with server-derived usedAmount.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate, quantityCategoryId } = req.query;
    const { annotated } = await loadAnnotatedEntries();
    let data = annotated;
    if (startDate) data = data.filter(entry => entry.date >= startDate);
    if (endDate) data = data.filter(entry => entry.date <= endDate);
    if (quantityCategoryId) data = data.filter(entry => entry.quantityCategoryId === String(quantityCategoryId));
    data.sort((first, second) => (second.date || '').localeCompare(first.date || '') ||
      (second.createdAt || '').localeCompare(first.createdAt || ''));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/consumption/stock — per quantity: incoming, consumed, remaining, last observation.
router.get('/stock', requireAuth, async (req, res) => {
  try {
    const [categories, expenseCategoryRows, { annotated, incomingMap }] = await Promise.all([
      loadQuantityCategories(), getAllRows(EXPENSE_CATEGORY_SHEET), loadAnnotatedEntries()
    ]);
    const expenseCategoryNames = new Map(
      expenseCategoryRows.map(row => [row[EXPENSE_CAT_C.ID] || '', row[EXPENSE_CAT_C.NAME] || ''])
    );
    const catById = new Map(categories.map(cat => [cat.id, cat]));
    const entriesByCategory = new Map();
    const consumedByCategory = new Map();
    for (const entry of annotated) {
      const key = entry.quantityCategoryId;
      if (!entriesByCategory.has(key)) entriesByCategory.set(key, []);
      entriesByCategory.get(key).push(entry);
      consumedByCategory.set(key, (consumedByCategory.get(key) || 0) + entry.usedAmount);
    }
    const knownIds = new Set([...catById.keys(), ...incomingMap.keys(), ...entriesByCategory.keys()]);
    const data = [...knownIds].map(id => {
      const cat = catById.get(id);
      const bucket = incomingMap.get(id) || { paid: 0, unpaid: 0, name: '', unit: '', events: [] };
      const entries = entriesByCategory.get(id) || [];
      const latest = entries[entries.length - 1];
      const totalIncoming = bucket.paid + bucket.unpaid;
      const autoConsume = !!cat?.autoConsume;
      // Auto-consume quantities never carry stock — every incoming is treated as consumed the same day.
      const consumed = autoConsume ? totalIncoming : (consumedByCategory.get(id) || 0);
      const remaining = autoConsume ? 0 : totalIncoming - consumed;
      const parentCategoryId = cat?.categoryId || '';
      return {
        quantityCategoryId: id,
        name: cat?.name || bucket.name || 'Unknown',
        unit: cat?.unit || bucket.unit || '',
        status: cat?.status || (cat ? 'Active' : 'Removed'),
        autoConsume,
        sortOrder: cat?.sortOrder || 999,
        categoryId: parentCategoryId,
        categoryName: expenseCategoryNames.get(parentCategoryId) || '',
        incoming: totalIncoming,
        incomingPaid: bucket.paid,
        incomingUnpaid: bucket.unpaid,
        consumed,
        remaining,
        lastObservation: latest ? { date: latest.date, availableStock: latest.availableStock, usedAmount: latest.usedAmount, id: latest.id } : null
      };
    });
    // Group visually by parent category name, then by the quantity's configured order and name.
    data.sort((first, second) => (first.categoryName || '\uffff').localeCompare(second.categoryName || '\uffff') ||
      first.sortOrder - second.sortOrder ||
      first.name.localeCompare(second.name));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/consumption/preview — projected available-before value for a new/edited entry.
router.get('/preview', requireAuth, async (req, res) => {
  try {
    const { date, quantityCategoryId, excludeEntryId } = req.query;
    if (!date || !quantityCategoryId) {
      return res.status(400).json({ success: false, message: 'date and quantityCategoryId are required.' });
    }
    const projection = await projectAvailability(String(quantityCategoryId), String(date), excludeEntryId || null);
    res.json({ success: true, data: projection });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/consumption — record today's observed available stock.
router.post('/', requireAuth, async (req, res) => {
  try {
    const { date, quantityCategoryId, availableStock, remarks, allowAnomaly } = req.body;
    if (!date || !quantityCategoryId || availableStock === undefined || availableStock === null || availableStock === '') {
      return res.status(400).json({ success: false, message: 'date, quantityCategoryId and availableStock are required.' });
    }
    if (date > getBusinessDate()) {
      return res.status(400).json({ success: false, message: 'Future dates cannot be used.' });
    }
    if (req.session.user.role !== 'superuser' && date !== getBusinessDate()) {
      return res.status(400).json({ success: false, message: 'Only today can be recorded. Ask an admin to backdate entries.' });
    }
    const categories = await loadQuantityCategories();
    const category = categories.find(cat => cat.id === String(quantityCategoryId));
    if (!category) return res.status(404).json({ success: false, message: 'Quantity not found.' });
    if (category.autoConsume) {
      return res.status(409).json({
        success: false, code: 'AUTO_CONSUME',
        message: `${category.name} is configured to be fully consumed the same day — no observation entries are needed.`
      });
    }
    // One entry per (date, quantity): a second POST for the same day updates the existing row.
    const existingRows = await getAllRows(SHEET);
    const existingIndex = existingRows.findIndex(row =>
      row[C.DATE] === String(date) && row[C.QCAT_ID] === category.id);
    const existingEntry = existingIndex >= 0 ? rawRowToObj(existingRows[existingIndex]) : null;
    let validated;
    try {
      validated = await validateAndBuildEntry(
        { date, availableStock, allowAnomaly }, category, existingEntry?.id || null
      );
    } catch (err) {
      if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message, data: err.data });
      throw err;
    }
    const now = new Date().toISOString();
    const user = req.session.user;
    const stockValue = parseFloat(availableStock);
    if (existingEntry) {
      const updated = {
        ...existingEntry,
        date: String(date),
        usedAmount: validated.usedAmount,
        name: category.name,
        unit: category.unit,
        remarks: String(remarks || '').trim(),
        updatedBy: user.id, updatedByName: user.displayName || user.username, updatedAt: now
      };
      await updateRow(SHEET, existingIndex + 2, objToRow(updated));
      return res.status(200).json({
        success: true,
        data: { ...updated, availableStock: stockValue, priorAvailable: validated.projection.availableBeforeEntry, replacedExisting: true }
      });
    }
    const entry = {
      id: uuidv4(), date: String(date), quantityCategoryId: category.id,
      name: category.name, unit: category.unit,
      usedAmount: validated.usedAmount,
      remarks: String(remarks || '').trim(),
      createdBy: user.id, createdByName: user.displayName || user.username, createdAt: now,
      updatedBy: '', updatedByName: '', updatedAt: ''
    };
    await appendRow(SHEET, objToRow(entry));
    res.status(201).json({
      success: true,
      data: { ...entry, availableStock: stockValue, priorAvailable: validated.projection.availableBeforeEntry }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/consumption/:id — superuser only.
router.put('/:id', requireSuperUser, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Consumption entry not found.' });
    const existing = rawRowToObj(found.row);
    const { date, availableStock, remarks, allowAnomaly } = req.body;
    const nextDate = date === undefined ? existing.date : String(date);
    // When availableStock is not supplied we keep the same usedAmount (which is what's stored).
    const supplyingStock = availableStock !== undefined;
    if (supplyingStock && !Number.isFinite(parseFloat(availableStock))) {
      return res.status(400).json({ success: false, message: 'availableStock must be a number.' });
    }
    if (!nextDate) {
      return res.status(400).json({ success: false, message: 'A valid date is required.' });
    }
    if (nextDate > getBusinessDate()) {
      return res.status(400).json({ success: false, message: 'Future dates cannot be used.' });
    }
    const categories = await loadQuantityCategories();
    const category = categories.find(cat => cat.id === existing.quantityCategoryId) || {
      id: existing.quantityCategoryId, name: existing.name, unit: existing.unit, status: 'Removed'
    };
    let usedAmount, projection, stockValue;
    if (supplyingStock) {
      let validated;
      try {
        validated = await validateAndBuildEntry(
          { date: nextDate, availableStock: parseFloat(availableStock), allowAnomaly }, category, existing.id
        );
      } catch (err) {
        if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message, data: err.data });
        throw err;
      }
      usedAmount = validated.usedAmount;
      projection = validated.projection;
      stockValue = parseFloat(availableStock);
    } else {
      projection = await projectAvailability(category.id, nextDate, existing.id);
      usedAmount = existing.usedAmount;
      stockValue = projection.availableBeforeEntry - usedAmount;
    }
    const now = new Date().toISOString();
    const user = req.session.user;
    const updated = {
      ...existing,
      date: nextDate,
      usedAmount,
      remarks: remarks === undefined ? existing.remarks : String(remarks).trim(),
      updatedBy: user.id, updatedByName: user.displayName || user.username, updatedAt: now
    };
    await updateRow(SHEET, found.index, objToRow(updated));
    res.json({
      success: true,
      data: { ...updated, availableStock: stockValue, priorAvailable: projection.availableBeforeEntry }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/consumption/:id — superuser only.
router.delete('/:id', requireSuperUser, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Consumption entry not found.' });
    await deleteRow(SHEET, found.index);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
