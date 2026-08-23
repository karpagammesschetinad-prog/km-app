const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');

const C = { ID: 0, DATE: 1, SHIFT: 2, PAYMENT_TYPE: 3, VENDOR: 4, AMOUNT: 5, ENTERED_BY: 6, CREATED_AT: 7, UPDATED_AT: 8 };
const SHIFTS = ['Morning', 'Afternoon', 'Night', 'Day'];
const EXPENSE = { DATE: 1, AMOUNT: 4, TYPE_ID: 13, SHIFT: 16, EMP_ID: 5 };
const ONLINE_VENDOR_PAYMENT_TYPE = 'OnlineVendor';
const writeLocks = new Map();
const normalizeShift = shift => {
  const value = String(shift || '').trim().toLowerCase();
  if (value === 'dinner') return 'Night'; // Backward compatibility for existing rows
  if (value === 'morning') return 'Morning';
  if (value === 'afternoon') return 'Afternoon';
  if (value === 'night') return 'Night';
  if (value === 'day') return 'Day';
  return String(shift || '').trim();
};
const normalizeText = value => String(value || '').trim();
const entryKey = ({ date, shift, paymentType, onlineVendor }) => [
  normalizeText(date),
  normalizeShift(shift).toLowerCase(),
  normalizeText(paymentType).toLowerCase(),
  normalizeText(onlineVendor).toLowerCase()
].join('||');
const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' }).format(new Date());
const parse = row => ({
  id: row[C.ID] || '',
  date: row[C.DATE] || '',
  shift: normalizeShift(row[C.SHIFT] || ''),
  paymentType: row[C.PAYMENT_TYPE] || 'Cash',
  onlineVendor: row[C.VENDOR] || '',
  amount: parseFloat(row[C.AMOUNT]) || 0,
  enteredBy: row[C.ENTERED_BY] || '',
  createdAt: row[C.CREATED_AT] || '',
  updatedAt: row[C.UPDATED_AT] || row[C.CREATED_AT] || ''
});

function expenseShiftForSales(row, categoryTypes) {
  const explicit = normalizeShift(row[EXPENSE.SHIFT]);
  if (explicit) return explicit;
  if (!row[EXPENSE.TYPE_ID]) return row[EXPENSE.EMP_ID] ? '' : 'Morning';
  const type = categoryTypes.find(item => item[0] === row[EXPENSE.TYPE_ID]);
  const name = String(type?.[1] || '').toLowerCase();
  if (name.includes('morning')) return 'Morning';
  if (name.includes('afternoon')) return 'Afternoon';
  if (name.includes('night') || name.includes('dinner') || name.includes('evening')) return 'Night';
  return '';
}

function getShiftExpenseTotals(expenses, date, categoryTypes) {
  const totals = { Morning: 0, Afternoon: 0, Night: 0 };
  expenses.filter(row => row[EXPENSE.DATE] === date).forEach(row => {
    const shift = expenseShiftForSales(row, categoryTypes);
    if (totals[shift] !== undefined) totals[shift] += parseFloat(row[EXPENSE.AMOUNT]) || 0;
  });
  return totals;
}

function isCashType(value) {
  return normalizeText(value).toLowerCase() === 'cash';
}

async function withWriteLock(lockKey, work) {
  const previousTail = writeLocks.get(lockKey) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queueTail = previousTail.then(() => gate);
  writeLocks.set(lockKey, queueTail);
  await previousTail;
  try {
    return await work();
  } finally {
    release();
    if (writeLocks.get(lockKey) === queueTail) writeLocks.delete(lockKey);
  }
}

router.get('/history', requireSuperUser, async (req, res) => {
  try {
    const paymentType = normalizeText(req.query.paymentType);
    if (!paymentType) return res.status(400).json({ success: false, message: 'paymentType is required.' });
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - (days - 1));
    const startKey = start.toISOString().slice(0, 10);

    const rows = (await getAllRows(SHEETS.SALES_ENTRIES))
      .map(parse)
      .filter(row => normalizeText(row.paymentType).toLowerCase() === paymentType.toLowerCase())
      .filter(row => row.date >= startKey)
      .sort((a, b) => {
        const dateDelta = String(b.date).localeCompare(String(a.date));
        if (dateDelta !== 0) return dateDelta;
        return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
      })
      .slice(0, 300);

    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const date = req.query.date || localDate();
    const [salesRows, expenseRows, categoryTypes] = await Promise.all([
      getAllRows(SHEETS.SALES_ENTRIES),
      getAllRows(SHEETS.EXPENSES),
      getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES)
    ]);
    const shiftExpenses = getShiftExpenseTotals(expenseRows, date, categoryTypes);
    const rows = salesRows
      .map(parse)
      .filter(row => row.date === date)
      .map(row => {
        if (!isCashType(row.paymentType)) return row;
        return { ...row, cashTotal: row.amount + (shiftExpenses[row.shift] || 0) };
      });
    // Return full day entries so cashier users can also view superuser-saved values.
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const date = String(req.body.date || '').trim();
    const today = localDate();
    if (!date || date > today) return res.status(400).json({ success: false, message: 'A valid sales date is required.' });
    if (req.session.user.role !== 'superuser' && date !== today) return res.status(403).json({ success: false, message: 'Cashiers can enter sales only for today.' });
    await withWriteLock(`sales-entries:${date}`, async () => {
      const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
      const settingRows = await getAllRows(SHEETS.SETTINGS);
      const setting = key => settingRows.find(row => row[0] === key)?.[1] || '';
      const configuredTypes = String(setting('PAYMENT_TYPES') || 'Cash').split(',').map(value => value.trim()).filter(Boolean);
      const configuredVendors = String(setting('ONLINE_VENDORS')).split(',').map(value => value.trim()).filter(Boolean);
      const normalizedEntries = entries.map(entry => ({
        ...entry,
        shift: normalizeShift(entry.shift),
        paymentType: normalizeText(entry.paymentType),
        onlineVendor: normalizeText(entry.onlineVendor)
      }));
      const valid = normalizedEntries.filter(entry => {
        const amountValid = Number(entry.amount) >= 0;
        const shiftValid = SHIFTS.includes(entry.shift);
        const isOnlineVendorEntry = entry.paymentType === ONLINE_VENDOR_PAYMENT_TYPE;
        if (isOnlineVendorEntry) {
          return amountValid && entry.shift === 'Day' && !!entry.onlineVendor && configuredVendors.includes(entry.onlineVendor);
        }
        return amountValid && shiftValid && configuredTypes.includes(entry.paymentType) && (!entry.onlineVendor || configuredVendors.includes(entry.onlineVendor));
      });
      if (!valid.length) return res.status(400).json({ success: false, message: 'Enter at least one valid sales amount.' });
      const [rows, expenseRows, categoryTypes] = await Promise.all([
        getAllRows(SHEETS.SALES_ENTRIES),
        getAllRows(SHEETS.EXPENSES),
        getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES)
      ]);
      const shiftExpenses = getShiftExpenseTotals(expenseRows, date, categoryTypes);
      // Guard 1: if same key appears multiple times in one request, keep only last value.
      const dedupedByKey = new Map();
      valid.forEach(entry => {
        const key = entryKey({ date, shift: entry.shift, paymentType: entry.paymentType, onlineVendor: entry.onlineVendor });
        const submittedAmount = Number(entry.amount);
        const storedAmount = isCashType(entry.paymentType) ? submittedAmount - (shiftExpenses[entry.shift] || 0) : submittedAmount;
        dedupedByKey.set(key, { ...entry, amount: storedAmount });
      });
      const upsertEntries = [...dedupedByKey.values()];
      const user = req.session.user.username;
      const rowsForDate = rows
        .map((row, index) => ({ index, parsed: parse(row) }))
        .filter(item => item.parsed.date === date);
      const existingByKey = new Map();
      rowsForDate.forEach(item => {
        const key = entryKey(item.parsed);
        if (!existingByKey.has(key)) existingByKey.set(key, []);
        existingByKey.get(key).push(item);
      });

      // Keep the latest row for each key and remove older duplicates.
      const duplicateIndexes = new Set();
      existingByKey.forEach(items => {
        if (items.length <= 1) return;
        for (let i = 0; i < items.length - 1; i++) duplicateIndexes.add(items[i].index);
      });

      const saved = [];
      for (const entry of upsertEntries) {
        const key = entryKey({ date, shift: entry.shift, paymentType: entry.paymentType, onlineVendor: entry.onlineVendor });
        const candidates = (existingByKey.get(key) || []).filter(item => !duplicateIndexes.has(item.index));
        const latest = candidates[candidates.length - 1];
        if (latest) {
          const now = new Date().toISOString();
          const updated = {
            id: latest.parsed.id || uuidv4(),
            date,
            shift: entry.shift,
            paymentType: entry.paymentType,
            onlineVendor: entry.onlineVendor,
            amount: Number(entry.amount),
            enteredBy: user,
            createdAt: latest.parsed.createdAt || now,
            updatedAt: now
          };
          await updateRow(SHEETS.SALES_ENTRIES, latest.index + 2, [updated.id, updated.date, updated.shift, updated.paymentType, updated.onlineVendor, updated.amount, updated.enteredBy, updated.createdAt, updated.updatedAt]);
          saved.push(updated);
        } else {
          // Guard 2: re-check sheet right before append; if another user already created the same key, update that row.
          const freshRows = await getAllRows(SHEETS.SALES_ENTRIES);
          const concurrent = freshRows
            .map((row, index) => ({ index, parsed: parse(row) }))
            .find(item => entryKey(item.parsed) === key);
          if (concurrent) {
            const now = new Date().toISOString();
            const updated = {
              id: concurrent.parsed.id || uuidv4(),
              date,
              shift: entry.shift,
              paymentType: entry.paymentType,
              onlineVendor: entry.onlineVendor,
              amount: Number(entry.amount),
              enteredBy: user,
              createdAt: concurrent.parsed.createdAt || now,
              updatedAt: now
            };
            await updateRow(SHEETS.SALES_ENTRIES, concurrent.index + 2, [updated.id, updated.date, updated.shift, updated.paymentType, updated.onlineVendor, updated.amount, updated.enteredBy, updated.createdAt, updated.updatedAt]);
            saved.push(updated);
          } else {
            const now = new Date().toISOString();
            const created = { id: uuidv4(), date, shift: entry.shift, paymentType: entry.paymentType, onlineVendor: entry.onlineVendor, amount: Number(entry.amount), enteredBy: user, createdAt: now, updatedAt: now };
            await appendRow(SHEETS.SALES_ENTRIES, [created.id, created.date, created.shift, created.paymentType, created.onlineVendor, created.amount, created.enteredBy, created.createdAt, created.updatedAt]);
            saved.push(created);
          }
        }
      }

      if (duplicateIndexes.size) {
        const sortedIndexes = [...duplicateIndexes].sort((a, b) => b - a);
        for (const rowIndex of sortedIndexes) {
          await deleteRow(SHEETS.SALES_ENTRIES, rowIndex + 2);
        }
      }
      res.json({ success: true, data: saved });
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});
module.exports = router;
