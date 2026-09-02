const express = require('express');
const router = express.Router();
const { SHEETS, getAllRows } = require('../services/googleSheets');
const { requireSuperUser } = require('../middleware/authMiddleware');

const C = {
  ID: 0, DATE: 1, CATEGORY: 2, DESCRIPTION: 3, AMOUNT: 4, EMP_ID: 5, EMP_NAME: 6,
  SUBMITTED_BY: 7, APPROVAL_STATUS: 8, APPROVED_BY: 9, APPROVED_AT: 10,
  REJECTION_REASON: 11, CREATED_AT: 12, TYPE_ID: 13, ON_SPOT: 14, PAYMENT_ID: 15, SHIFT: 16, MODE: 17
};
const ENTRY_C = { ID: 0, DATE: 1, SHIFT: 2, PAYMENT_TYPE: 3, VENDOR: 4, AMOUNT: 5, ENTERED_BY: 6, CREATED_AT: 7, UPDATED_AT: 8 };
const SALES_C = { ID: 0, DATE: 1, MORNING: 2, AFTERNOON: 3, DINNER: 4, TOTAL: 5, EXPENSES: 6, REMAINING: 7, ENTERED_BY: 8, CREATED_AT: 9, MORNING_BY: 10, AFTERNOON_BY: 11, DINNER_BY: 12 };
const PAYMENT_C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, DATE: 3, AMOUNT: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };
const EMPLOYEE_C = { ID: 0, NAME: 1, ADDRESS: 2, PHONE: 3, START: 4, PER_DAY: 5, PETTA: 6, STATUS: 7, DAILY_PAY: 8, TEMPORARY: 9 };
const LEAVE_C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, START: 3, END: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };
const PETTA_C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, EFFECTIVE_DATE: 3, AMOUNT: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };
const SALARY_HISTORY_C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, EFFECTIVE_DATE: 3, AMOUNT: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };
const TYPE_C = { ID: 0, NAME: 1, ORDER: 2, STATUS: 3, ACCESS_MODE: 4, ALLOWED_USERS: 5, WORKFLOW: 7 };

const MAX_RANGE_DAYS = 400;
const OUTLIER_MULTIPLIER = 3;
const OUTLIER_MIN_SAMPLES = 4;
const RATIO_TOLERANCE = 0.5;
const RATIO_MIN_DEVIATION = 0.05;

function normalizeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'occasional' || normalized === 'occasional_excluded') return 'Occasional';
  if (normalized === 'daily non cash' || normalized === 'daily_non_cash' || normalized === 'dailycashexcluded') return 'Daily Non Cash';
  return 'Daily Cash';
}

function amountOf(row, index) {
  return parseFloat(row[index]) || 0;
}

function shiftDate(date, days) {
  const parsed = new Date(`${date}T00:00:00`);
  parsed.setDate(parsed.getDate() + days);
  const pad = value => String(value).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function listDates(from, to) {
  const dates = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

// Salary is counted from SalaryPayments only, so its mirrored expense rows must be skipped.
function isSalaryExpense(row) {
  return !!(row[C.PAYMENT_ID] || row[C.EMP_ID]);
}

function expenseMode(row, typeModes) {
  if (String(row[C.MODE] || '').trim()) return normalizeMode(row[C.MODE]);
  return typeModes.get(row[C.TYPE_ID] || '') || 'Daily Cash';
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isTrue(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

// Leave is counted by calendar date only: a half day is 0.5, any other covered date is a full day.
function leaveSpanFor(leave) {
  const startKey = String(leave.start || '').slice(0, 10);
  if (!isValidDate(startKey)) return null;
  const rawEnd = leave.end ? new Date(leave.end) : null;
  if (!rawEnd || Number.isNaN(rawEnd.getTime())) {
    const pad = value => String(value).padStart(2, '0');
    const now = new Date();
    return { startKey, endKey: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, fraction: 1 };
  }
  const spanHours = (rawEnd - new Date(leave.start)) / 3600000;
  // Ends stored at midnight mean "up to the previous day".
  const inclusiveEnd = new Date(rawEnd.getTime() - 1);
  const pad = value => String(value).padStart(2, '0');
  const endKey = `${inclusiveEnd.getFullYear()}-${pad(inclusiveEnd.getMonth() + 1)}-${pad(inclusiveEnd.getDate())}`;
  if (spanHours > 0 && spanHours <= 12 && endKey === startKey) return { startKey, endKey: startKey, fraction: 0.5 };
  return { startKey, endKey: endKey < startKey ? startKey : endKey, fraction: 1 };
}

function leaveFractionForDay(date, leaves) {
  let fraction = 0;
  leaves.forEach(leave => {
    const span = leaveSpanFor(leave);
    if (!span) return;
    if (date < span.startKey || date > span.endKey) return;
    fraction += span.fraction;
  });
  return Math.max(0, Math.min(1, fraction));
}

// Returns the amount in force on a date, given a base and dated overrides.
function amountForDate(date, baseAmount, history) {
  let amount = baseAmount;
  history.forEach(entry => { if (entry.date <= date) amount = entry.amount; });
  return amount;
}

function salaryAccrualByDate({ dates, employeeRows, leaveRows, pettaRows, salaryHistoryRows, paymentsByDateAndEmployee }) {
  const gross = new Map(dates.map(date => [date, 0]));
  const petta = new Map(dates.map(date => [date, 0]));
  const leavesByEmployee = new Map();
  leaveRows.forEach(row => {
    const key = row[LEAVE_C.EMP_ID] || '';
    if (!leavesByEmployee.has(key)) leavesByEmployee.set(key, []);
    leavesByEmployee.get(key).push({ start: row[LEAVE_C.START], end: row[LEAVE_C.END] });
  });
  const pettaByEmployee = new Map();
  pettaRows.forEach(row => {
    const key = row[PETTA_C.EMP_ID] || '';
    if (!pettaByEmployee.has(key)) pettaByEmployee.set(key, []);
    pettaByEmployee.get(key).push({ date: row[PETTA_C.EFFECTIVE_DATE] || '', amount: amountOf(row, PETTA_C.AMOUNT) });
  });
  pettaByEmployee.forEach(entries => entries.sort((a, b) => String(a.date).localeCompare(String(b.date))));

  const salaryByEmployee = new Map();
  (salaryHistoryRows || []).forEach(row => {
    const key = row[SALARY_HISTORY_C.EMP_ID] || '';
    if (!salaryByEmployee.has(key)) salaryByEmployee.set(key, []);
    salaryByEmployee.get(key).push({ date: row[SALARY_HISTORY_C.EFFECTIVE_DATE] || '', amount: amountOf(row, SALARY_HISTORY_C.AMOUNT) });
  });
  salaryByEmployee.forEach(entries => entries.sort((a, b) => String(a.date).localeCompare(String(b.date))));

  employeeRows.forEach(row => {
    const id = row[EMPLOYEE_C.ID] || '';
    const startDate = String(row[EMPLOYEE_C.START] || '').slice(0, 10);
    if (!startDate) return;
    // Temporary staff are paid per shift, so their pay is their earning for the day.
    if (isTrue(row[EMPLOYEE_C.TEMPORARY])) {
      dates.forEach(date => {
        gross.set(date, gross.get(date) + (paymentsByDateAndEmployee.get(`${date}|${id}`) || 0));
      });
      return;
    }
    if ((row[EMPLOYEE_C.STATUS] || 'Active') !== 'Active') return;
    const perDay = amountOf(row, EMPLOYEE_C.PER_DAY);
    const basePetta = amountOf(row, EMPLOYEE_C.PETTA);
    const leaves = leavesByEmployee.get(id) || [];
    const history = pettaByEmployee.get(id) || [];
    const salaryRevisions = salaryByEmployee.get(id) || [];
    dates.forEach(date => {
      if (date < startDate) return;
      const worked = Math.max(0, 1 - leaveFractionForDay(date, leaves));
      if (!worked) return;
      gross.set(date, gross.get(date) + worked * amountForDate(date, perDay, salaryRevisions));
      petta.set(date, petta.get(date) + worked * amountForDate(date, basePetta, history));
    });
  });

  return { gross, petta };
}

function buildProfitAndLoss({ from, to, expenseRows, entryRows, salesRows, paymentRows, typeRows, employeeRows, leaveRows, pettaRows, salaryHistoryRows }) {
  const typeModes = new Map((typeRows || []).map(row => [row[TYPE_C.ID] || '', normalizeMode(row[TYPE_C.WORKFLOW])]));
  const dates = listDates(from, to);
  const blank = () => ({ sales: 0, cashSales: 0, onlineSales: 0, dailyCash: 0, market: 0, occasional: 0, salaryPaid: 0, salaryInExpenses: 0 });
  const byDate = new Map(dates.map(date => [date, blank()]));

  entryRows.forEach(row => {
    const bucket = byDate.get(row[ENTRY_C.DATE]);
    if (!bucket) return;
    const amount = amountOf(row, ENTRY_C.AMOUNT);
    bucket.sales += amount;
    if (String(row[ENTRY_C.PAYMENT_TYPE] || '').trim().toLowerCase() === 'cash') bucket.cashSales += amount;
    else bucket.onlineSales += amount;
  });

  expenseRows.forEach(row => {
    const mode = expenseMode(row, typeModes);
    const amount = amountOf(row, C.AMOUNT);
    // Market spend is funded by the previous day's sales, so it lands on that day.
    const reportDate = mode === 'Daily Non Cash' ? shiftDate(row[C.DATE], -1) : row[C.DATE];
    const bucket = byDate.get(reportDate);
    if (!bucket) return;
    if (mode === 'Daily Non Cash') bucket.market += amount;
    else if (mode === 'Occasional') bucket.occasional += amount;
    else bucket.dailyCash += amount;
    // Salary rows sit inside the expense totals, so the salary line subtracts them again.
    if (isSalaryExpense(row) && mode !== 'Daily Non Cash') bucket.salaryInExpenses += amount;
  });

  const paymentsByDateAndEmployee = new Map();
  paymentRows.forEach(row => {
    const date = row[PAYMENT_C.DATE];
    const bucket = byDate.get(date);
    const amount = amountOf(row, PAYMENT_C.AMOUNT);
    if (bucket) bucket.salaryPaid += amount;
    const key = `${date}|${row[PAYMENT_C.EMP_ID] || ''}`;
    paymentsByDateAndEmployee.set(key, (paymentsByDateAndEmployee.get(key) || 0) + amount);
  });

  const { gross: grossByDate, petta: pettaByDate } = salaryAccrualByDate({
    dates, employeeRows: employeeRows || [], leaveRows: leaveRows || [], pettaRows: pettaRows || [], salaryHistoryRows: salaryHistoryRows || [], paymentsByDateAndEmployee
  });

  // Legacy Sales rows are only used for days with no SalesEntries data.
  const legacyByDate = new Map(salesRows.map(row => [row[SALES_C.DATE], row]));
  dates.forEach(date => {
    const bucket = byDate.get(date);
    if (bucket.sales > 0) return;
    const legacy = legacyByDate.get(date);
    if (!legacy) return;
    const remaining = amountOf(legacy, SALES_C.MORNING) + amountOf(legacy, SALES_C.AFTERNOON) + amountOf(legacy, SALES_C.DINNER);
    bucket.sales = remaining + bucket.dailyCash;
    bucket.cashSales = bucket.sales;
  });

  const days = dates.map(date => {
    const bucket = byDate.get(date);
    const salaryGross = grossByDate.get(date) || 0;
    const pettaTotal = pettaByDate.get(date) || 0;
    // Pending is for this day only; paying arrears must not push the day's salary line negative.
    const salaryPending = Math.max(0, salaryGross - pettaTotal - bucket.salaryPaid);
    const totalCost = bucket.dailyCash + bucket.occasional + salaryPending + bucket.market;
    return {
      date,
      sales: round(bucket.sales),
      cashSales: round(bucket.cashSales),
      onlineSales: round(bucket.onlineSales),
      dailyCashExpense: round(bucket.dailyCash),
      occasionalExpense: round(bucket.occasional),
      marketExpense: round(bucket.market),
      salaryGross: round(salaryGross),
      salaryPaid: round(bucket.salaryPaid),
      salaryInExpenses: round(bucket.salaryInExpenses),
      pettaTotal: round(pettaTotal),
      salaryPending: round(salaryPending),
      totalCost: round(totalCost),
      profit: round(bucket.sales - totalCost),
      expenseRatio: bucket.sales > 0 ? round(totalCost / bucket.sales) : null
    };
  });

  const totals = days.reduce((sum, day) => ({
    sales: sum.sales + day.sales,
    cashSales: sum.cashSales + day.cashSales,
    onlineSales: sum.onlineSales + day.onlineSales,
    dailyCashExpense: sum.dailyCashExpense + day.dailyCashExpense,
    occasionalExpense: sum.occasionalExpense + day.occasionalExpense,
    marketExpense: sum.marketExpense + day.marketExpense,
    salaryGross: sum.salaryGross + day.salaryGross,
    salaryPaid: sum.salaryPaid + day.salaryPaid,
    salaryInExpenses: sum.salaryInExpenses + day.salaryInExpenses,
    pettaTotal: sum.pettaTotal + day.pettaTotal,
    salaryPending: sum.salaryPending + day.salaryPending,
    totalCost: sum.totalCost + day.totalCost,
    profit: sum.profit + day.profit
  }), {
    sales: 0, cashSales: 0, onlineSales: 0, dailyCashExpense: 0, occasionalExpense: 0, marketExpense: 0,
    salaryGross: 0, salaryPaid: 0, salaryInExpenses: 0, pettaTotal: 0, salaryPending: 0, totalCost: 0, profit: 0
  });

  Object.keys(totals).forEach(key => { totals[key] = round(totals[key]); });
  totals.margin = totals.sales > 0 ? round((totals.profit / totals.sales) * 100) : null;

  return { days, totals };
}

function buildAnalytics({ from, to, days, expenseRows, entryRows, typeRows }) {
  const typeModes = new Map((typeRows || []).map(row => [row[TYPE_C.ID] || '', normalizeMode(row[TYPE_C.WORKFLOW])]));
  const inRange = expenseRows.filter(row => {
    if (isSalaryExpense(row)) return false;
    const mode = expenseMode(row, typeModes);
    const reportDate = mode === 'Daily Non Cash' ? shiftDate(row[C.DATE], -1) : row[C.DATE];
    return reportDate >= from && reportDate <= to;
  });
  const selfApproved = inRange
    .filter(row => row[C.APPROVAL_STATUS] === 'Approved' && row[C.APPROVED_BY] && row[C.APPROVED_BY] === row[C.SUBMITTED_BY])
    .map(row => ({
      id: row[C.ID], date: row[C.DATE], category: row[C.CATEGORY],
      amount: amountOf(row, C.AMOUNT), user: row[C.SUBMITTED_BY]
    }));

  const byCategory = new Map();
  inRange.forEach(row => {
    const key = row[C.CATEGORY] || 'Unknown';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(row);
  });
  const outliers = [];
  byCategory.forEach((rows, category) => {
    if (rows.length < OUTLIER_MIN_SAMPLES) return;
    const average = rows.reduce((sum, row) => sum + amountOf(row, C.AMOUNT), 0) / rows.length;
    if (average <= 0) return;
    rows.forEach(row => {
      const amount = amountOf(row, C.AMOUNT);
      if (amount >= average * OUTLIER_MULTIPLIER) {
        outliers.push({
          id: row[C.ID], date: row[C.DATE], category, amount,
          categoryAverage: round(average), times: round(amount / average), submittedBy: row[C.SUBMITTED_BY]
        });
      }
    });
  });
  outliers.sort((a, b) => b.times - a.times);

  const onSpotRows = inRange.filter(row => String(row[C.ON_SPOT] || '').toLowerCase() === 'true');
  const onSpotTotal = onSpotRows.reduce((sum, row) => sum + amountOf(row, C.AMOUNT), 0);
  const expenseTotal = inRange.reduce((sum, row) => sum + amountOf(row, C.AMOUNT), 0);
  const onSpotByCategory = new Map();
  onSpotRows.forEach(row => {
    const key = row[C.CATEGORY] || 'Unknown';
    onSpotByCategory.set(key, (onSpotByCategory.get(key) || 0) + amountOf(row, C.AMOUNT));
  });
  const onSpot = {
    count: onSpotRows.length,
    total: round(onSpotTotal),
    share: expenseTotal > 0 ? round((onSpotTotal / expenseTotal) * 100) : 0,
    topCategories: [...onSpotByCategory.entries()]
      .map(([category, amount]) => ({ category, amount: round(amount) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10)
  };

  const lateSalesEdits = entryRows
    .filter(row => row[ENTRY_C.DATE] >= from && row[ENTRY_C.DATE] <= to)
    .map(row => {
      const created = String(row[ENTRY_C.CREATED_AT] || '').slice(0, 10);
      const updated = String(row[ENTRY_C.UPDATED_AT] || row[ENTRY_C.CREATED_AT] || '').slice(0, 10);
      const touched = updated > created ? updated : created;
      return { row, touched, wasEdited: !!updated && updated > created };
    })
    .filter(item => item.touched && item.touched > item.row[ENTRY_C.DATE])
    .map(item => ({
      date: item.row[ENTRY_C.DATE],
      shift: item.row[ENTRY_C.SHIFT],
      paymentType: item.row[ENTRY_C.PAYMENT_TYPE],
      amount: amountOf(item.row, ENTRY_C.AMOUNT),
      enteredBy: item.row[ENTRY_C.ENTERED_BY],
      touchedOn: item.touched,
      action: item.wasEdited ? 'Edited later' : 'Entered later',
      daysLate: Math.round((new Date(`${item.touched}T00:00:00`) - new Date(`${item.row[ENTRY_C.DATE]}T00:00:00`)) / 86400000)
    }))
    .sort((a, b) => b.daysLate - a.daysLate);

  const dayIssues = [];
  days.forEach(day => {
    if (day.sales === 0 && day.totalCost > 0) {
      dayIssues.push({ date: day.date, issue: 'Expenses recorded with no sales', amount: day.totalCost });
    } else if (day.cashSales > 0 && day.cashSales - day.dailyCashExpense < 0) {
      dayIssues.push({ date: day.date, issue: 'Cash expenses exceed cash sales', amount: round(day.cashSales - day.dailyCashExpense) });
    }
    // The salary line assumes payments also appear as expenses; otherwise the day is understated.
    if (round(day.salaryPaid - day.salaryInExpenses) !== 0) {
      dayIssues.push({
        date: day.date,
        issue: 'Salary payment not recorded as an expense',
        amount: round(day.salaryPaid - day.salaryInExpenses)
      });
    }
  });

  // Costs should track sales; days far off the usual ratio are worth investigating.
  // The baseline is the median so a single extreme day cannot drag it toward itself.
  const rated = days.filter(day => day.expenseRatio !== null);
  const sortedRatios = rated.map(day => day.expenseRatio).sort((a, b) => a - b);
  const median = sortedRatios.length
    ? (sortedRatios.length % 2
      ? sortedRatios[(sortedRatios.length - 1) / 2]
      : (sortedRatios[sortedRatios.length / 2 - 1] + sortedRatios[sortedRatios.length / 2]) / 2)
    : null;
  const average = rated.length ? rated.reduce((sum, day) => sum + day.expenseRatio, 0) / rated.length : null;
  const threshold = median === null ? null : Math.max(median * RATIO_TOLERANCE, RATIO_MIN_DEVIATION);
  const ratioFlags = median === null
    ? []
    : rated
      .filter(day => Math.abs(day.expenseRatio - median) > threshold)
      .map(day => ({
        date: day.date, sales: day.sales, totalCost: day.totalCost, ratio: day.expenseRatio,
        direction: day.expenseRatio > median ? 'Cost too high for sales' : 'Cost too low for sales'
      }));

  return {
    selfApproved,
    outliers: outliers.slice(0, 25),
    onSpot,
    lateSalesEdits: lateSalesEdits.slice(0, 50),
    dayIssues,
    ratio: {
      median: median === null ? null : round(median),
      average: average === null ? null : round(average),
      tolerance: RATIO_TOLERANCE,
      flagged: ratioFlags
    }
  };
}

// Occasional expenses sit outside the daily cash flow, so they get their own date-wise report.
function buildOccasionalReport({ from, to, expenseRows, typeRows }) {
  const typeModes = new Map((typeRows || []).map(row => [row[TYPE_C.ID] || '', normalizeMode(row[TYPE_C.WORKFLOW])]));
  const typeNames = new Map((typeRows || []).map(row => [row[TYPE_C.ID] || '', row[TYPE_C.NAME] || '']));

  const entries = expenseRows
    .filter(row => expenseMode(row, typeModes) === 'Occasional' && row[C.DATE] >= from && row[C.DATE] <= to)
    .map(row => ({
      id: row[C.ID],
      date: row[C.DATE],
      category: row[C.CATEGORY] || 'Unknown',
      type: typeNames.get(row[C.TYPE_ID] || '') || 'Unknown',
      remarks: row[C.DESCRIPTION] || '',
      amount: round(amountOf(row, C.AMOUNT)),
      submittedBy: row[C.SUBMITTED_BY] || '',
      approvalStatus: row[C.APPROVAL_STATUS] || 'Pending'
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.category.localeCompare(b.category));

  const byDate = new Map();
  const byCategory = new Map();
  entries.forEach(entry => {
    const day = byDate.get(entry.date) || { date: entry.date, count: 0, amount: 0 };
    day.count += 1;
    day.amount += entry.amount;
    byDate.set(entry.date, day);
    byCategory.set(entry.category, (byCategory.get(entry.category) || 0) + entry.amount);
  });

  const days = [...byDate.values()]
    .map(day => ({ ...day, amount: round(day.amount) }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    entries,
    days,
    categories: [...byCategory.entries()]
      .map(([category, amount]) => ({ category, amount: round(amount) }))
      .sort((a, b) => b.amount - a.amount),
    totals: {
      count: entries.length,
      amount: round(entries.reduce((sum, entry) => sum + entry.amount, 0)),
      days: days.length
    }
  };
}

router.get('/profit-loss', requireSuperUser, async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (!isValidDate(from) || !isValidDate(to)) {
      return res.status(400).json({ success: false, message: 'from and to dates are required as YYYY-MM-DD.' });
    }
    if (from > to) return res.status(400).json({ success: false, message: 'from date must be on or before to date.' });
    if (listDates(from, to).length > MAX_RANGE_DAYS) {
      return res.status(400).json({ success: false, message: `Date range cannot exceed ${MAX_RANGE_DAYS} days.` });
    }

    const [expenseRows, entryRows, salesRows, paymentRows, typeRows, employeeRows, leaveRows, pettaRows, salaryHistoryRows] = await Promise.all([
      getAllRows(SHEETS.EXPENSES),
      getAllRows(SHEETS.SALES_ENTRIES),
      getAllRows(SHEETS.SALES),
      getAllRows(SHEETS.SALARY_PAYMENTS),
      getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES),
      getAllRows(SHEETS.EMPLOYEES),
      getAllRows(SHEETS.LEAVES),
      getAllRows(SHEETS.PETTA_HISTORY),
      getAllRows(SHEETS.SALARY_HISTORY)
    ]);

    const { days, totals } = buildProfitAndLoss({ from, to, expenseRows, entryRows, salesRows, paymentRows, typeRows, employeeRows, leaveRows, pettaRows, salaryHistoryRows });
    const analytics = buildAnalytics({ from, to, days, expenseRows, entryRows, typeRows });

    res.json({ success: true, data: { range: { from, to }, days, totals, analytics } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/occasional', requireSuperUser, async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (!isValidDate(from) || !isValidDate(to)) {
      return res.status(400).json({ success: false, message: 'from and to dates are required as YYYY-MM-DD.' });
    }
    if (from > to) return res.status(400).json({ success: false, message: 'from date must be on or before to date.' });
    if (listDates(from, to).length > MAX_RANGE_DAYS) {
      return res.status(400).json({ success: false, message: `Date range cannot exceed ${MAX_RANGE_DAYS} days.` });
    }

    const [expenseRows, typeRows] = await Promise.all([
      getAllRows(SHEETS.EXPENSES),
      getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES)
    ]);

    const report = buildOccasionalReport({ from, to, expenseRows, typeRows });
    res.json({ success: true, data: { range: { from, to }, ...report } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
