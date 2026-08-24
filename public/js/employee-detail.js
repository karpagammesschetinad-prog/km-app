/* employee-detail.js */

let empId = null;
let empData = null;
let empLeaves = [];
let empPayments = [];
let empPettaHistory = [];
let expenseCategoryTypes = [];
let fiscalYearConfig = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('employees')) { window.location.href = '/index.html'; return; }

  empId = new URLSearchParams(location.search).get('id');
  if (!empId) { location.href = '/employees.html'; return; }

  await loadAll();
  setupModals();
  const editButton = document.getElementById('btnEditEmployee');
  if (canAccess('employees', 'add')) {
    editButton.addEventListener('click', openEdit);
  } else {
    editButton.remove();
  }
});

async function loadAll() {
  try {
    [empData, empLeaves, empPayments, empPettaHistory, expenseCategoryTypes, fiscalYearConfig] = await Promise.all([
      api('GET', `/employees/${empId}`),
      api('GET', `/leaves?employeeId=${empId}`),
      api('GET', `/payments?employeeId=${empId}`),
      api('GET', `/petta?employeeId=${empId}`),
      api('GET', '/categories/types/all'),
      api('GET', '/config')
    ]);
    render();
  } catch (err) {
    document.getElementById('detailContent').innerHTML =
      `<div class="alert alert-danger">Failed to load employee: ${err.message}</div>`;
  }
}

/* ── Salary calculation (date-wise petta + carry-forward) ── */
function parseDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const s = String(value).slice(0, 10);
  const parts = s.split('-').map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function getDefaultCalculationDates() {
  const today = parseDateOnly(new Date());
  const configuredStart = parseDateOnly(fiscalYearConfig?.fiscalYear?.start);
  const configuredEnd = parseDateOnly(fiscalYearConfig?.fiscalYear?.end);
  return { start: configuredStart || parseDateOnly(empData.startDate), end: configuredEnd && configuredEnd < today ? configuredEnd : today };
}

function getLeaveFractionForDay(dayStart) {
  const dayEnd = addDays(dayStart, 1);
  let frac = 0;
  empLeaves.forEach(l => {
    const ls = new Date(l.startDateTime);
    const le = l.endDateTime ? new Date(l.endDateTime) : new Date();
    const s = new Date(Math.max(ls.getTime(), dayStart.getTime()));
    const e = new Date(Math.min(le.getTime(), dayEnd.getTime()));
    if (e > s) frac += (e - s) / 86400000;
  });
  return Math.max(0, Math.min(1, frac));
}

function buildPettaTimeline() {
  const base = parseFloat(empData.dailyPetta) || 0;
  const entries = (empPettaHistory || [])
    .map(p => ({
      date: parseDateOnly(p.effectiveDate),
      amount: parseFloat(p.amount) || 0
    }))
    .filter(x => x.date)
    .sort((a, b) => a.date - b.date);
  return { base, entries };
}

function getPettaForDate(day, timeline) {
  let amt = timeline.base;
  for (const p of timeline.entries) {
    if (p.date <= day) amt = p.amount;
    else break;
  }
  return amt;
}

function calcSalary(fiscalStart = null, fiscalEnd = null) {
  const employeeStart = parseDateOnly(empData.startDate);
  const fiscalDates = getDefaultCalculationDates();
  const start = fiscalStart || fiscalDates.start;
  const today = fiscalEnd || fiscalDates.end;
  if (empData.temporaryEmployee) {
    const paymentsByDate = new Map();
    (empPayments || []).forEach(payment => {
      const paymentDate = parseDateOnly(payment.paymentDate);
      if (!paymentDate || (start && paymentDate < start) || (today && paymentDate > today)) return;
      const key = dateKey(paymentDate);
      paymentsByDate.set(key, (paymentsByDate.get(key) || 0) + (parseFloat(payment.amount) || 0));
    });
    const periods = [...paymentsByDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, paid]) => ({
      start: parseDateOnly(date), end: parseDateOnly(date), petta: empData.dailySalaryEnabled ? (parseFloat(empData.dailyPetta) || 0) : 0,
      totalDays: 1, leaveDays: 0, workedDays: 1, earned: paid, paid,
      opening: 0, closing: 0
    }));
    const totalPaid = periods.reduce((sum, period) => sum + period.paid, 0);
    return { totalDays: periods.length.toFixed(1), leaveDays: '0.0', workedDays: periods.length.toFixed(1), earnedSalary: totalPaid, totalPaid, balance: 0, currentPetta: empData.dailySalaryEnabled ? (parseFloat(empData.dailyPetta) || 0) : 0, periods };
  }
  const calculationStart = employeeStart > start ? employeeStart : start;
  if (!employeeStart || !start || !today || calculationStart > today) {
    return {
      totalDays: '0.0', leaveDays: '0.0', workedDays: '0.0',
      earnedSalary: 0, totalPaid: 0, balance: 0, currentPetta: parseFloat(empData.dailyPetta) || 0, periods: []
    };
  }

  const perDaySalary = parseFloat(empData.perDaySalary) || 0;
  const timeline = buildPettaTimeline();

  const paymentMap = new Map();
  (empPayments || []).forEach(p => {
    const d = parseDateOnly(p.paymentDate);
    if (!d || d < calculationStart || d > today) return;
    const key = dateKey(d);
    paymentMap.set(key, (paymentMap.get(key) || 0) + (parseFloat(p.amount) || 0));
  });

  const pettaChangeKeys = new Set(
    timeline.entries
      .filter(p => p.date >= calculationStart && p.date <= today)
      .map(p => dateKey(p.date))
  );

  let totalDays = 0;
  let leaveDays = 0;
  let workedDays = 0;
  let earnedSalary = 0;
  let totalPaid = 0;

  let segStart = new Date(calculationStart);
  let segTotalDays = 0;
  let segLeaveDays = 0;
  let segWorkedDays = 0;
  let segEarned = 0;
  let segPaid = 0;
  let segOpening = 0;
  for (let day = new Date(employeeStart); day < calculationStart; day = addDays(day, 1)) {
    const leaveFrac = getLeaveFractionForDay(day);
    const paid = (empPayments || []).filter(p => {
      const paymentDate = parseDateOnly(p.paymentDate);
      return paymentDate && dateKey(paymentDate) === dateKey(day);
    }).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    segOpening += Math.max(0, 1 - leaveFrac) * (perDaySalary - getPettaForDate(day, timeline)) - paid;
  }
  let runningBalance = segOpening;
  const periods = [];

  for (let day = new Date(calculationStart); day <= today; day = addDays(day, 1)) {
    const leaveFrac = getLeaveFractionForDay(day);
    const workedFrac = Math.max(0, 1 - leaveFrac);
    const petta = getPettaForDate(day, timeline);
    const netPerDay = perDaySalary - petta;

    const key = dateKey(day);
    const dayPaid = paymentMap.get(key) || 0;

    segTotalDays += 1;
    segLeaveDays += leaveFrac;
    segWorkedDays += workedFrac;
    segEarned += workedFrac * netPerDay;
    segPaid += dayPaid;

    totalDays += 1;
    leaveDays += leaveFrac;
    workedDays += workedFrac;
    earnedSalary += workedFrac * netPerDay;
    totalPaid += dayPaid;

    const nextDay = addDays(day, 1);
    const isToday = day.getTime() === today.getTime();
    const pettaChangesTomorrow = nextDay <= today && pettaChangeKeys.has(dateKey(nextDay));
    const paymentSettledToday = dayPaid > 0;

    if (isToday || pettaChangesTomorrow || paymentSettledToday) {
      const closing = segOpening + segEarned - segPaid;
      periods.push({
        start: new Date(segStart),
        end: new Date(day),
        petta: getPettaForDate(segStart, timeline),
        totalDays: segTotalDays,
        leaveDays: segLeaveDays,
        workedDays: segWorkedDays,
        earned: segEarned,
        paid: segPaid,
        opening: segOpening,
        closing
      });

      runningBalance = closing;
      segOpening = closing;
      segStart = addDays(day, 1);
      segTotalDays = 0;
      segLeaveDays = 0;
      segWorkedDays = 0;
      segEarned = 0;
      segPaid = 0;
    }
  }

  const dailyPayPeriods = empData.dailySalaryEnabled
    ? periods.map(period => ({ ...period, paid: period.earned, opening: 0, closing: 0 }))
    : periods;
  const dailyPayTotal = empData.dailySalaryEnabled ? earnedSalary : totalPaid;
  return {
    totalDays: totalDays.toFixed(1),
    leaveDays: leaveDays.toFixed(1),
    workedDays: workedDays.toFixed(1),
    earnedSalary,
    totalPaid: dailyPayTotal,
    balance: empData.dailySalaryEnabled ? 0 : runningBalance,
    currentPetta: getPettaForDate(today, timeline),
    periods: dailyPayPeriods
  };
}

function isOnLeave() {
  const now = new Date();
  return empLeaves.some(l => new Date(l.startDateTime) <= now && now <= new Date(l.endDateTime));
}

/* ── Render entire detail view ── */
function render() {
  const onLeave = isOnLeave();
  const showSalary = canAccess('salaries') || canAccess('employees', 'add'); // superuser or admin sees salary info

  const sal = showSalary ? calcSalary() : null;
  const todayKey = dateKey(parseDateOnly(new Date()));
  const visiblePayments = isSuperUser()
    ? empPayments
    : empPayments.filter(p => dateKey(parseDateOnly(p.paymentDate)) === todayKey);
  const visiblePetta = isSuperUser() ? empPettaHistory : empPettaHistory.filter(p => p.createdBy === currentUser.displayName);

  const balanceIsNeg = sal && sal.balance < 0;
  const balanceAbs = sal ? Math.abs(sal.balance) : 0;
  const balanceLabel = balanceIsNeg ? 'Salary Advance' : 'Salary Pending';
  const balanceColor = balanceIsNeg ? 'warning' : (sal && sal.balance > 0 ? 'danger' : 'success');
  const balanceIcon  = balanceIsNeg ? 'bi-arrow-up-circle' : (sal && sal.balance > 0 ? 'bi-hourglass-split' : 'bi-check-circle');

  const statusBadgeHtml = onLeave
    ? '<span class="badge bg-primary">🔵 On Leave</span>'
    : (empData.status === 'Active'
        ? '<span class="badge bg-success">🟢 Active</span>'
        : '<span class="badge bg-secondary">Inactive</span>');
  const dailyPayBadge = empData.dailySalaryEnabled
    ? '<span class="badge bg-info-subtle text-info border border-info-subtle ms-1"><i class="bi bi-calendar-day me-1"></i>Daily Pay</span>'
    : '';
  const dailyPayLabel = empData.temporaryEmployee ? 'Dynamic Daily Pay' : 'Per Day Salary';
  const dailyPayValue = empData.temporaryEmployee ? 'Based on recorded payments' : formatCurrency(empData.perDaySalary);
  const dailyPettaLabel = empData.temporaryEmployee ? 'Total Paid' : 'Current Petta';
  const dailyPettaValue = empData.temporaryEmployee ? formatCurrency(sal.totalPaid) : formatCurrency(sal.currentPetta);
  const dailyNetLabel = empData.temporaryEmployee ? 'Salary Status' : 'Current Net Per Day';
  const dailyNetValue = empData.temporaryEmployee ? 'Paid amount is final' : formatCurrency((parseFloat(empData.perDaySalary) || 0) - sal.currentPetta);

  document.getElementById('detailContent').innerHTML = `

    <!-- Employee Info -->
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-person-circle me-2"></i>Employee Information</h6>
        <div class="d-flex gap-1">${statusBadgeHtml}${dailyPayBadge}</div>
      </div>
      <div class="card-panel-body">
        <div class="row g-3">
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">Full Name</div>
            <div class="info-value fw-semibold">${empData.name}</div>
          </div>
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">Phone</div>
            <div class="info-value">${empData.phone || '—'}</div>
          </div>
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">Start Date</div>
            <div class="info-value">${formatDate(empData.startDate)}</div>
          </div>
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">Status</div>
            <div class="info-value">${empData.status}</div>
          </div>
          <div class="col-12">
            <div class="info-label">Address</div>
            <div class="info-value">${empData.address || '—'}</div>
          </div>
          ${showSalary ? `
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">${dailyPayLabel}</div>
            <div class="info-value fw-semibold text-success">${dailyPayValue}</div>
          </div>
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">${dailyPettaLabel}</div>
            <div class="info-value text-warning">${dailyPettaValue}</div>
          </div>
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">${dailyNetLabel}</div>
            <div class="info-value fw-semibold">${dailyNetValue}</div>
          </div>` : ''}
        </div>
      </div>
    </div>

    <!-- Salary Summary -->
    ${showSalary ? `
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-calculator me-2"></i>${empData.temporaryEmployee ? 'Temporary Pay Summary' : (empData.dailySalaryEnabled ? 'Daily Pay Summary' : 'Salary Summary')}</h6>
        <span class="badge bg-${balanceColor}-subtle text-${balanceColor} border border-${balanceColor}-subtle px-3 py-2 fs-6">
          <i class="bi ${balanceIcon} me-1"></i>${balanceLabel}: ${formatCurrency(balanceAbs)}
        </span>
      </div>
      <div class="card-panel-body">
        <div class="row g-3 text-center">
          <div class="col-6 col-md-3">
            <div class="salary-stat-box">
              <div class="salary-stat-val">${sal.totalDays}</div>
              <div class="salary-stat-lbl">Total Days</div>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="salary-stat-box text-warning">
              <div class="salary-stat-val">${sal.leaveDays}</div>
              <div class="salary-stat-lbl">Leave Days</div>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="salary-stat-box text-primary">
              <div class="salary-stat-val">${sal.workedDays}</div>
              <div class="salary-stat-lbl">Days Worked</div>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="salary-stat-box text-success">
              <div class="salary-stat-val">${formatCurrency(sal.earnedSalary)}</div>
              <div class="salary-stat-lbl">Earned</div>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="salary-stat-box text-info">
              <div class="salary-stat-val">${formatCurrency(sal.totalPaid)}</div>
              <div class="salary-stat-lbl">Total Paid</div>
            </div>
          </div>
          <div class="col-6 col-md-3">
            <div class="salary-stat-box text-${balanceColor}">
              <div class="salary-stat-val">${formatCurrency(balanceAbs)}</div>
              <div class="salary-stat-lbl">${balanceLabel}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    ` : ''}

    <!-- Consolidated Period Summary -->
    ${showSalary ? `
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-collection me-2"></i>Consolidated Salary Periods</h6>
        <span class="text-muted small">${empData.temporaryEmployee ? 'Each recorded payment is the final amount for that work day.' : (empData.dailySalaryEnabled ? 'Fixed per-day salary paid daily; each payment closes the period.' : 'Opening balance of each period includes previous pending/advance')}</span>
      </div>
      <div class="table-responsive">
        <table class="table mobile-grid-table">
          <thead>
            <tr>
              <th>Period</th><th>Petta / Day</th><th>Days Worked</th><th>Earned</th><th>Paid</th><th>Opening</th><th>Closing</th>
            </tr>
          </thead>
          <tbody>${renderPeriodRows(sal.periods)}</tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- Salary Payments -->
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-cash-coin me-2"></i>Salary Payments</h6>
        ${canAccess('employees','payments') ? `<button class="btn btn-sm btn-primary" id="btnAddPayment"><i class="bi bi-plus-lg me-1"></i>Record Payment</button>` : ''}
      </div>
      <div class="table-responsive">
        <table class="table mobile-grid-table">
          <thead><tr><th>Date</th><th>Amount</th><th>Remarks</th><th>Recorded By</th><th></th></tr></thead>
          <tbody id="paymentsBody">${renderPaymentsRows(visiblePayments)}</tbody>
        </table>
      </div>
    </div>

    <!-- Petta History -->
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-calendar-week me-2"></i>Petta History</h6>
        ${canAccess('employees','payments') ? `<button class="btn btn-sm btn-outline-primary" id="btnAddPetta"><i class="bi bi-plus-lg me-1"></i>Add Petta Date</button>` : ''}
      </div>
      <div class="table-responsive">
        <table class="table mobile-grid-table">
          <thead><tr><th>Effective Date</th><th>Petta Amount</th><th>Remarks</th><th>Recorded By</th><th></th></tr></thead>
          <tbody id="pettaBody"><tr><td colspan="5" class="text-center text-muted py-3">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Leave History -->
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-calendar-x me-2"></i>Leave History</h6>
        ${canAccess('employees','leaves') ? `<button class="btn btn-sm btn-outline-primary" id="btnAddLeave"><i class="bi bi-plus-lg me-1"></i>Add Leave</button>` : ''}
      </div>
      <div class="table-responsive">
        <table class="table mobile-grid-table">
          <thead><tr><th>From</th><th>To</th><th>Duration</th><th>Remarks</th><th></th></tr></thead>
          <tbody id="leavesBody">${renderLeaveRows()}</tbody>
        </table>
      </div>
    </div>
  `;

  const btnLeave   = document.getElementById('btnAddLeave');
  const btnPayment  = document.getElementById('btnAddPayment');
  const btnPetta    = document.getElementById('btnAddPetta');
  if (btnLeave)   btnLeave.addEventListener('click',   () => bootstrap.Modal.getOrCreateInstance(document.getElementById('leaveModal')).show());
  if (btnPayment) btnPayment.addEventListener('click', () => {
    const now = new Date();
    const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const paymentDate = document.getElementById('payDate');
    paymentDate.value = currentDate;
    paymentDate.max = currentDate;
    paymentDate.disabled = !isSuperUser();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('paymentModal')).show();
  });
  if (btnPetta)   btnPetta.addEventListener('click',   () => {
    document.getElementById('pettaForm').reset();
    document.getElementById('pettaDate').value = new Date().toISOString().split('T')[0];
    bootstrap.Modal.getOrCreateInstance(document.getElementById('pettaModal')).show();
  });

  const pettaBody = document.getElementById('pettaBody');
  if (pettaBody) pettaBody.innerHTML = renderPettaRows(visiblePetta);
}

function renderLeaveRows() {
  if (!empLeaves.length) return `<tr><td colspan="5" class="text-center text-muted py-3">No leave records</td></tr>`;
  const now = new Date();
  return empLeaves.map(l => {
    const s = new Date(l.startDateTime), e = l.endDateTime ? new Date(l.endDateTime) : new Date();
    const days = ((e - s) / 86400000).toFixed(1);
    const active = s <= now && (!l.endDateTime || now <= e);
    return `<tr class="${active ? 'table-info' : ''}">
      <td data-label="From">${formatDateTime(l.startDateTime)}</td>
      <td data-label="To">${l.endDateTime ? formatDateTime(l.endDateTime) : '<span class="badge bg-warning-subtle text-warning border border-warning-subtle">Ongoing</span>'}</td>
      <td data-label="Duration"><span class="badge bg-secondary-subtle text-secondary border">${days} day(s)</span>${active ? ' <span class="badge bg-primary ms-1">On Leave</span>' : ''}</td>
      <td data-label="Remarks">${l.remarks || '—'}</td>
      <td data-label="Actions">${!l.endDateTime ? `<button class="btn btn-sm btn-outline-success btn-action" onclick="closeLeave('${l.id}')" title="Record return"><i class="bi bi-person-check me-1"></i>Return</button>` : ''}<button class="btn btn-sm btn-outline-danger btn-action" onclick="deleteLeave('${l.id}')"><i class="bi bi-trash"></i></button></td>
    </tr>`;
  }).join('');
}

function renderPaymentsRows(payments) {
  if (!payments || !payments.length) return `<tr><td colspan="5" class="text-center text-muted py-3">No payments recorded</td></tr>`;
  return payments.map(p => `
    <tr>
      <td data-label="Date">${formatDate(p.paymentDate)}</td>
      <td data-label="Amount" class="fw-semibold text-success">${formatCurrency(p.amount)}</td>
      <td data-label="Remarks">${p.remarks || '—'}</td>
      <td data-label="Recorded by" class="text-muted small">${p.createdBy || '—'}</td>
      <td data-label="Actions"><button class="btn btn-sm btn-outline-danger btn-action" onclick="deletePayment('${p.id}')"><i class="bi bi-trash"></i></button></td>
    </tr>
  `).join('');
}

function renderPettaRows(records) {
  if (!records || !records.length) return `<tr><td colspan="5" class="text-center text-muted py-3">No petta history</td></tr>`;
  return records.map(p => {
    const canDelete = isSuperUser() || p.createdBy === currentUser.displayName;
    return `
    <tr>
      <td data-label="Effective date">${formatDate(p.effectiveDate)}</td>
      <td data-label="Petta amount" class="fw-semibold text-warning">${formatCurrency(p.amount)}</td>
      <td data-label="Remarks">${p.remarks || '—'}</td>
      <td data-label="Recorded by" class="text-muted small">${p.createdBy || '—'}</td>
      <td data-label="Actions">${canDelete ? `<button class="btn btn-sm btn-outline-danger btn-action" onclick="deletePetta('${p.id}')"><i class="bi bi-trash"></i></button>` : ''}</td>
    </tr>
  `;
  }).join('');
}

function renderPeriodRows(periods) {
  if (!periods || !periods.length) {
    return `<tr><td colspan="7" class="text-center text-muted py-3">No calculated periods yet</td></tr>`;
  }

  return periods.map((p) => {
    const isAdvance = p.closing < 0;
    const closeColor = isAdvance ? 'warning' : (p.closing > 0 ? 'danger' : 'success');
    const closeLabel = isAdvance ? 'Advance' : (p.closing > 0 ? 'Pending' : 'Settled');
    return `
      <tr>
        <td data-label="Period">${formatDate(dateKey(p.start))} - ${formatDate(dateKey(p.end))}</td>
        <td data-label="Petta / day" class="text-warning fw-semibold">${formatCurrency(p.petta)}</td>
        <td data-label="Days worked">${p.workedDays.toFixed(1)} / ${p.totalDays.toFixed(1)}</td>
        <td data-label="Earned" class="text-success fw-semibold">${formatCurrency(p.earned)}</td>
        <td data-label="Paid" class="text-info fw-semibold">${formatCurrency(p.paid)}</td>
        <td data-label="Opening">${formatCurrency(p.opening)}</td>
        <td data-label="Closing"><span class="badge bg-${closeColor}-subtle text-${closeColor} border border-${closeColor}-subtle">${formatCurrency(Math.abs(p.closing))} ${closeLabel}</span></td>
      </tr>
    `;
  }).join('');
}

function formatDateTime(str) {
  if (!str) return '—';
  try {
    return new Date(str).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  } catch (_) { return str; }
}

/* ── Modals ── */
function setupModals() {
  const temporaryToggle = document.getElementById('editTemporary');
  const perDayInput = document.getElementById('editPerDay');
  const pettaInput = document.getElementById('editPetta');
  temporaryToggle.addEventListener('change', () => {
    const temporary = temporaryToggle.checked;
    perDayInput.disabled = temporary;
    pettaInput.disabled = temporary;
    if (temporary) { perDayInput.value = ''; pettaInput.value = ''; }
  });
  document.getElementById('btnSaveLeave').addEventListener('click', saveLeave);
  document.getElementById('btnSavePayment').addEventListener('click', savePayment);
  document.getElementById('btnSaveEdit').addEventListener('click', saveEdit);
  document.getElementById('btnSavePetta').addEventListener('click', savePetta);
  const expenseToggle = document.getElementById('payAddAsExpense');
  expenseToggle.addEventListener('change', togglePaymentExpenseType);
  populatePaymentExpenseTypes();
  togglePaymentExpenseType();

  // Default date for payment modal
  document.getElementById('paymentModal').addEventListener('show.bs.modal', () => {
    const now = new Date();
    const currentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    document.getElementById('payDate').value = currentDate;
    document.getElementById('payDate').max = currentDate;
    document.getElementById('payDate').disabled = !isSuperUser();
    expenseToggle.checked = !!empData.temporaryEmployee || expenseToggle.checked;
    expenseToggle.disabled = !!empData.temporaryEmployee;
    expenseToggle.closest('.form-check')?.querySelector('label span')?.replaceChildren(document.createTextNode(empData.temporaryEmployee
      ? ' — Temporary employee payments are always recorded as expenses for the selected shift'
      : ' — Record this payment as an expense entry'));
    // Pre-fill today's date automatically for daily-pay employees
    if (empData.dailySalaryEnabled) {
      document.getElementById('payDate').value = currentDate;
      const amountEl = document.getElementById('payAmount');
      if (!amountEl.value) amountEl.value = empData.perDaySalary || '';
    }
  });
}

function populatePaymentExpenseTypes() {
  const select = document.getElementById('payExpenseType');
  if (!select) return;
  select.innerHTML = '<option value="">Select category type</option>' + expenseCategoryTypes
    .filter(type => type.status === 'Active')
    .map(type => `<option value="${type.id}">${type.name}</option>`).join('');
}

function togglePaymentExpenseType() {
  const toggle = document.getElementById('payAddAsExpense');
  const wrapper = document.getElementById('payExpenseTypeWrap');
  const select = document.getElementById('payExpenseType');
  const enabled = !!toggle?.checked;
  wrapper.style.display = enabled ? '' : 'none';
  select.required = enabled;
}

function openEdit() {
  document.getElementById('editName').value        = empData.name;
  document.getElementById('editPhone').value       = empData.phone;
  document.getElementById('editAddress').value     = empData.address;
  document.getElementById('editStartDate').value   = empData.startDate;
  document.getElementById('editPerDay').value      = empData.perDaySalary;
  document.getElementById('editPetta').value       = empData.dailyPetta;
  document.getElementById('editStatus').value      = empData.status;
  document.getElementById('editDailyPay').checked  = !!empData.dailySalaryEnabled;
  document.getElementById('editTemporary').checked  = !!empData.temporaryEmployee;
  document.getElementById('editTemporary').dispatchEvent(new Event('change'));
  bootstrap.Modal.getOrCreateInstance(document.getElementById('editEmpModal')).show();
}

async function saveEdit() {
  const form = document.getElementById('editEmpForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const btn = document.getElementById('btnSaveEdit');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';
  try {
    await api('PUT', `/employees/${empId}`, {
      name:               document.getElementById('editName').value.trim(),
      phone:              document.getElementById('editPhone').value.trim(),
      address:            document.getElementById('editAddress').value.trim(),
      startDate:          document.getElementById('editStartDate').value,
      perDaySalary:       parseFloat(document.getElementById('editPerDay').value) || 0,
      dailyPetta:         parseFloat(document.getElementById('editPetta').value) || 0,
      status:             document.getElementById('editStatus').value,
      dailySalaryEnabled: document.getElementById('editDailyPay').checked,
      temporaryEmployee:  document.getElementById('editTemporary').checked
    });
    bootstrap.Modal.getInstance(document.getElementById('editEmpModal')).hide();
    showNotification('Employee updated.');
    await loadAll();
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save';
  }
}

async function saveLeave() {
  const form = document.getElementById('leaveForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const btn = document.getElementById('btnSaveLeave');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';
  try {
    await api('POST', '/leaves', {
      employeeId:    empId,
      employeeName:  empData.name,
      startDateTime: document.getElementById('leaveStart').value,
      endDateTime:   document.getElementById('leaveEnd').value,
      remarks:       document.getElementById('leaveRemarks').value.trim()
    });
    form.reset();
    bootstrap.Modal.getInstance(document.getElementById('leaveModal')).hide();
    showNotification('Leave added.');
    await loadAll();
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Leave';
  }
}

async function savePayment() {
  const form = document.getElementById('paymentForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const btn = document.getElementById('btnSavePayment');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';
  try {
    await api('POST', '/payments', {
      employeeId:   empId,
      employeeName: empData.name,
      paymentDate:  document.getElementById('payDate').value,
      amount:       parseFloat(document.getElementById('payAmount').value),
      remarks:      document.getElementById('payRemarks').value.trim(),
      addAsExpense: document.getElementById('payAddAsExpense').checked,
      expenseTypeId: document.getElementById('payExpenseType').value
    });
    form.reset();
    bootstrap.Modal.getInstance(document.getElementById('paymentModal')).hide();
    showNotification('Payment recorded.');
    await loadAll();
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Payment';
  }
}

async function savePetta() {
  const form = document.getElementById('pettaForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const btn = document.getElementById('btnSavePetta');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';
  try {
    await api('POST', '/petta', {
      employeeId: empId,
      employeeName: empData.name,
      effectiveDate: document.getElementById('pettaDate').value,
      amount: parseFloat(document.getElementById('pettaAmount').value),
      remarks: document.getElementById('pettaRemarks').value.trim()
    });
    form.reset();
    bootstrap.Modal.getInstance(document.getElementById('pettaModal')).hide();
    showNotification('Petta record added.');
    await loadAll();
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Petta';
  }
}

async function deleteLeave(id) {
  if (!confirm('Delete this leave record?')) return;
  try {
    await api('DELETE', `/leaves/${id}`);
    showNotification('Leave deleted.');
    await loadAll();
  } catch (err) {
    showNotification('Delete failed: ' + err.message, 'danger');
  }
}

async function closeLeave(id) {
  const now = new Date();
  const currentDateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const endDateTime = prompt('Enter the employee return date and time:', currentDateTime);
  if (!endDateTime) return;
  try {
    await api('PUT', `/leaves/${id}`, { endDateTime });
    showNotification('Leave closed with return date.');
    await loadAll();
  } catch (err) { showNotification('Update failed: ' + err.message, 'danger'); }
}

async function deletePayment(id) {
  if (!confirm('Delete this payment record?')) return;
  try {
    await api('DELETE', `/payments/${id}`);
    showNotification('Payment deleted.');
    await loadAll();
  } catch (err) {
    showNotification('Delete failed: ' + err.message, 'danger');
  }
}

async function deletePetta(id) {
  if (!confirm('Delete this petta record?')) return;
  try {
    await api('DELETE', `/petta/${id}`);
    showNotification('Petta record deleted.');
    await loadAll();
  } catch (err) {
    showNotification('Delete failed: ' + err.message, 'danger');
  }
}
