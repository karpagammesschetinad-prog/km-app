const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, findRowById } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');

const C = { ID: 0, DATE: 1, MORNING: 2, AFTERNOON: 3, DINNER: 4, TOTAL: 5, EXPENSES: 6, REMAINING: 7, ENTERED_BY: 8, CREATED_AT: 9, MORNING_BY: 10, AFTERNOON_BY: 11, DINNER_BY: 12 };
const EXPENSE = { DATE: 1, AMOUNT: 4, TYPE_ID: 13, SHIFT: 16, EMP_ID: 5 };
const SALES_ENTRY = { DATE: 1, SHIFT: 2, PAYMENT_TYPE: 3, AMOUNT: 5 };

function normalizeSalesShift(shift) {
  const value = String(shift || '').trim().toLowerCase();
  if (value === 'morning') return 'Morning';
  if (value === 'afternoon') return 'Afternoon';
  if (value === 'night' || value === 'dinner' || value === 'evening') return 'Night';
  return '';
}

function businessDate() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function rowToObj(row) {
  return {
    id: row[C.ID] || '', date: row[C.DATE] || '', morning: parseFloat(row[C.MORNING]) || 0,
    afternoon: parseFloat(row[C.AFTERNOON]) || 0, dinner: parseFloat(row[C.DINNER]) || 0,
    totalSales: parseFloat(row[C.TOTAL]) || 0, expenseTotal: parseFloat(row[C.EXPENSES]) || 0,
    remaining: parseFloat(row[C.REMAINING]) || 0, enteredBy: row[C.ENTERED_BY] || '', createdAt: row[C.CREATED_AT] || '',
    morningEnteredBy: row[C.MORNING_BY] || row[C.ENTERED_BY] || '',
    afternoonEnteredBy: row[C.AFTERNOON_BY] || row[C.ENTERED_BY] || '',
    dinnerEnteredBy: row[C.DINNER_BY] || row[C.ENTERED_BY] || ''
  };
}

function expenseTotal(rows, date) {
  return rows.filter(row => row[EXPENSE.DATE] === date).reduce((total, row) => total + (parseFloat(row[EXPENSE.AMOUNT]) || 0), 0);
}

function salesShiftForExpense(row, categoryTypes) {
  if (row[EXPENSE.SHIFT]) return normalizeSalesShift(row[EXPENSE.SHIFT]);
  if (!row[EXPENSE.TYPE_ID]) return row[EXPENSE.EMP_ID] ? '' : 'Morning';
  const type = categoryTypes.find(item => item[0] === row[EXPENSE.TYPE_ID]);
  const name = String(type?.[1] || '').toLowerCase();
  if (name.includes('morning')) return 'Morning';
  if (name.includes('afternoon')) return 'Afternoon';
  if (name.includes('night') || name.includes('dinner') || name.includes('evening')) return 'Night';
  return '';
}

function shiftExpenseTotals(rows, date, categoryTypes) {
  const totals = { Morning: 0, Afternoon: 0, Night: 0 };
  rows.filter(row => row[EXPENSE.DATE] === date).forEach(row => {
    const shift = salesShiftForExpense(row, categoryTypes);
    if (totals[shift] !== undefined) totals[shift] += parseFloat(row[EXPENSE.AMOUNT]) || 0;
  });
  return totals;
}

function salesEntryTotals(rows, date) {
  const remainingByShift = { Morning: 0, Afternoon: 0, Night: 0 };
  let daySales = 0;
  rows.filter(row => row[SALES_ENTRY.DATE] === date).forEach(row => {
    const shift = normalizeSalesShift(row[SALES_ENTRY.SHIFT]);
    const amount = parseFloat(row[SALES_ENTRY.AMOUNT]) || 0;
    if (shift === 'Morning' || shift === 'Afternoon' || shift === 'Night') {
      remainingByShift[shift] += amount;
    } else if (shift === 'Day') {
      daySales += amount;
    }
  });
  return { remainingByShift, daySales };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const date = req.query.date || businessDate();
    const [salesRows, salesEntryRows, expenseRows, categoryTypes] = await Promise.all([getAllRows(SHEETS.SALES), getAllRows(SHEETS.SALES_ENTRIES), getAllRows(SHEETS.EXPENSES), getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES)]);
    const shiftExpenses = shiftExpenseTotals(expenseRows, date, categoryTypes);
    const dailyExpenseTotal = expenseTotal(expenseRows, date);
    const rows = salesRows.map(rowToObj).filter(row => req.session.user.role === 'superuser' || row.date === businessDate());
    if (req.session.user.role !== 'superuser') {
      const own = rows.find(row => row.date === date) || { date, morning: 0, afternoon: 0, dinner: 0, totalSales: 0, remaining: 0, enteredBy: '' };
      return res.json({ success: true, data: { date, morning: own.morning, afternoon: own.afternoon, dinner: own.dinner, remaining: own.remaining } });
    }
    const summaryRows = salesRows.map(rowToObj).filter(row => row.date === date);
    const hasEntryData = salesEntryRows.some(row => row[SALES_ENTRY.DATE] === date);
    const entryTotals = salesEntryTotals(salesEntryRows, date);
    const remainingByShift = hasEntryData ? entryTotals.remainingByShift : {
      Morning: summaryRows.reduce((total, row) => total + row.morning, 0),
      Afternoon: summaryRows.reduce((total, row) => total + row.afternoon, 0),
      Night: summaryRows.reduce((total, row) => total + row.dinner, 0)
    };
    const shiftSales = {
      Morning: remainingByShift.Morning + shiftExpenses.Morning,
      Afternoon: remainingByShift.Afternoon + shiftExpenses.Afternoon,
      Night: remainingByShift.Night + shiftExpenses.Night
    };
    const remainingSales = hasEntryData
      ? Object.values(entryTotals.remainingByShift).reduce((total, value) => total + value, 0) + entryTotals.daySales
      : Object.values(remainingByShift).reduce((total, value) => total + value, 0);
    const totalSales = hasEntryData ? dailyExpenseTotal + remainingSales : Object.values(shiftSales).reduce((total, value) => total + value, 0);
    // Keep Dinner aliases for older clients still reading Dinner keys.
    const shiftExpensesWithAliases = { ...shiftExpenses, Dinner: shiftExpenses.Night };
    const remainingByShiftWithAliases = { ...remainingByShift, Dinner: remainingByShift.Night };
    const shiftSalesWithAliases = { ...shiftSales, Dinner: shiftSales.Night };
    res.json({ success: true, data: { date, rows: salesRows.map(rowToObj), summary: { totalSales, expenseTotal: dailyExpenseTotal, remaining: hasEntryData ? remainingSales : totalSales - dailyExpenseTotal, remainingByShift: remainingByShiftWithAliases, shiftExpenses: shiftExpensesWithAliases, shiftSales: shiftSalesWithAliases } } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/history', requireSuperUser, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 20));
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const startKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    const endKey = businessDate();
    const [legacyRows, entryRows, expenseRows, categoryTypes] = await Promise.all([
      getAllRows(SHEETS.SALES),
      getAllRows(SHEETS.SALES_ENTRIES),
      getAllRows(SHEETS.EXPENSES),
      getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES)
    ]);
    const legacySales = new Map(legacyRows.map(rowToObj)
      .filter(row => row.date >= startKey && row.date <= endKey)
      .map(row => [row.date, row.totalSales]));
    const entrySales = new Map();
    const entryDates = new Set(entryRows.map(row => row[SALES_ENTRY.DATE]).filter(date => date >= startKey && date <= endKey));
    entryDates.forEach(date => {
      const shiftExpenses = shiftExpenseTotals(expenseRows, date, categoryTypes);
      const totals = salesEntryTotals(entryRows, date);
      const remaining = Object.values(totals.remainingByShift).reduce((sum, value) => sum + value, 0) + totals.daySales;
      entrySales.set(date, expenseTotal(expenseRows, date) + remaining);
    });
    const dates = new Set([...legacySales.keys(), ...entrySales.keys()]);
    const rows = [...dates].sort().map(date => ({ date, totalSales: entrySales.has(date) ? entrySales.get(date) : legacySales.get(date) }));
    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const date = String(req.body.date || '').trim();
    const today = businessDate();
    if (!date || date > today) return res.status(400).json({ success: false, message: 'A valid sales date is required.' });
    if (req.session.user.role !== 'superuser' && date !== today) return res.status(403).json({ success: false, message: 'Cashiers can enter sales only for today.' });
    const values = ['morning', 'afternoon', 'dinner'].map(key => Math.max(0, parseFloat(req.body[key]) || 0));
    const expenses = await getAllRows(SHEETS.EXPENSES);
    const categoryTypes = await getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES);
    const shiftExpenses = shiftExpenseTotals(expenses, date, categoryTypes);
    const expenseTotalValue = expenseTotal(expenses, date);
    const userKey = req.session.user.role === 'superuser' ? (req.body.enteredBy || req.session.user.username) : req.session.user.username;
    const existingRows = await getAllRows(SHEETS.SALES);
    const existingIndex = existingRows.findIndex(row => row[C.DATE] === date);
    const previous = existingIndex >= 0 ? rowToObj(existingRows[existingIndex]) : null;
    const changedShifts = Array.isArray(req.body.changedShifts) ? req.body.changedShifts : ['morning', 'afternoon', 'dinner'];
    const obj = { id: previous?.id || uuidv4(), date, morning: previous?.morning || 0, afternoon: previous?.afternoon || 0, dinner: previous?.dinner || 0, totalSales: 0, expenseTotal: expenseTotalValue, remaining: 0, enteredBy: previous?.enteredBy || userKey, createdAt: previous?.createdAt || new Date().toISOString(), morningEnteredBy: previous?.morningEnteredBy || '', afternoonEnteredBy: previous?.afternoonEnteredBy || '', dinnerEnteredBy: previous?.dinnerEnteredBy || '' };
    changedShifts.forEach(key => { if (['morning', 'afternoon', 'dinner'].includes(key)) { obj[key] = values[['morning', 'afternoon', 'dinner'].indexOf(key)]; obj[`${key}EnteredBy`] = userKey; } });
    obj.totalSales = obj.morning + obj.afternoon + obj.dinner + expenseTotalValue;
    obj.remaining = obj.morning + obj.afternoon + obj.dinner;
    const row = [obj.id, obj.date, obj.morning, obj.afternoon, obj.dinner, obj.totalSales, obj.expenseTotal, obj.remaining, obj.enteredBy, obj.createdAt, obj.morningEnteredBy, obj.afternoonEnteredBy, obj.dinnerEnteredBy];
    if (existingIndex >= 0) await updateRow(SHEETS.SALES, existingIndex + 2, row); else await appendRow(SHEETS.SALES, row);
    res.json({ success: true, data: obj });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
