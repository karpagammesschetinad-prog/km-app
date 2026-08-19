/* employee-detail.js */

let empId = null;
let empData = null;
let empLeaves = [];
let empPayments = [];
let empPettaHistory = [];

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('employees')) { window.location.href = '/index.html'; return; }

  empId = new URLSearchParams(location.search).get('id');
  if (!empId) { location.href = '/employees.html'; return; }

  await loadAll();
  setupModals();
  document.getElementById('btnEditEmployee').addEventListener('click', openEdit);
});

async function loadAll() {
  try {
    [empData, empLeaves, empPayments, empPettaHistory] = await Promise.all([
      api('GET', `/employees/${empId}`),
      api('GET', `/leaves?employeeId=${empId}`),
      api('GET', `/payments?employeeId=${empId}`),
      api('GET', `/petta?employeeId=${empId}`)
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

function getLeaveFractionForDay(dayStart) {
  const dayEnd = addDays(dayStart, 1);
  let frac = 0;
  empLeaves.forEach(l => {
    const ls = new Date(l.startDateTime);
    const le = new Date(l.endDateTime);
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

function calcSalary() {
  const start = parseDateOnly(empData.startDate);
  const today = parseDateOnly(new Date());
  if (!start || !today || start > today) {
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
    if (!d || d < start || d > today) return;
    const key = dateKey(d);
    paymentMap.set(key, (paymentMap.get(key) || 0) + (parseFloat(p.amount) || 0));
  });

  const pettaChangeKeys = new Set(
    timeline.entries
      .filter(p => p.date >= start && p.date <= today)
      .map(p => dateKey(p.date))
  );

  let totalDays = 0;
  let leaveDays = 0;
  let workedDays = 0;
  let earnedSalary = 0;
  let totalPaid = 0;

  let segStart = new Date(start);
  let segTotalDays = 0;
  let segLeaveDays = 0;
  let segWorkedDays = 0;
  let segEarned = 0;
  let segPaid = 0;
  let segOpening = 0;
  let runningBalance = 0;
  const periods = [];

  for (let day = new Date(start); day <= today; day = addDays(day, 1)) {
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

  return {
    totalDays: totalDays.toFixed(1),
    leaveDays: leaveDays.toFixed(1),
    workedDays: workedDays.toFixed(1),
    earnedSalary,
    totalPaid,
    balance: runningBalance,
    currentPetta: getPettaForDate(today, timeline),
    periods
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
  const visiblePayments = isSuperUser() ? empPayments : empPayments.filter(p => p.createdBy === currentUser.displayName);
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
            <div class="info-label">Per Day Salary</div>
            <div class="info-value fw-semibold text-success">${formatCurrency(empData.perDaySalary)}</div>
          </div>
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">Current Petta</div>
            <div class="info-value text-warning">${formatCurrency(sal.currentPetta)}</div>
          </div>
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">Current Net Per Day</div>
            <div class="info-value fw-semibold">${formatCurrency((parseFloat(empData.perDaySalary) || 0) - sal.currentPetta)}</div>
          </div>` : ''}
        </div>
      </div>
    </div>

    <!-- Salary Summary -->
    ${showSalary ? `
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-calculator me-2"></i>Salary Summary</h6>
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
        <span class="text-muted small">Opening balance of each period includes previous pending/advance</span>
      </div>
      <div class="table-responsive">
        <table class="table">
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
        <table class="table">
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
        <table class="table">
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
        <table class="table">
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
  if (btnPayment) btnPayment.addEventListener('click', () => bootstrap.Modal.getOrCreateInstance(document.getElementById('paymentModal')).show());
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
    const s = new Date(l.startDateTime), e = new Date(l.endDateTime);
    const days = ((e - s) / 86400000).toFixed(1);
    const active = s <= now && now <= e;
    return `<tr class="${active ? 'table-info' : ''}">
      <td>${formatDateTime(l.startDateTime)}</td>
      <td>${formatDateTime(l.endDateTime)}</td>
      <td><span class="badge bg-secondary-subtle text-secondary border">${days} day(s)</span>${active ? ' <span class="badge bg-primary ms-1">On Leave</span>' : ''}</td>
      <td>${l.remarks || '—'}</td>
      <td><button class="btn btn-sm btn-outline-danger btn-action" onclick="deleteLeave('${l.id}')"><i class="bi bi-trash"></i></button></td>
    </tr>`;
  }).join('');
}

function renderPaymentsRows(payments) {
  if (!payments || !payments.length) return `<tr><td colspan="5" class="text-center text-muted py-3">No payments recorded</td></tr>`;
  return payments.map(p => `
    <tr>
      <td>${formatDate(p.paymentDate)}</td>
      <td class="fw-semibold text-success">${formatCurrency(p.amount)}</td>
      <td>${p.remarks || '—'}</td>
      <td class="text-muted small">${p.createdBy || '—'}</td>
      <td><button class="btn btn-sm btn-outline-danger btn-action" onclick="deletePayment('${p.id}')"><i class="bi bi-trash"></i></button></td>
    </tr>
  `).join('');
}

function renderPettaRows(records) {
  if (!records || !records.length) return `<tr><td colspan="5" class="text-center text-muted py-3">No petta history</td></tr>`;
  return records.map(p => {
    const canDelete = isSuperUser() || p.createdBy === currentUser.displayName;
    return `
    <tr>
      <td>${formatDate(p.effectiveDate)}</td>
      <td class="fw-semibold text-warning">${formatCurrency(p.amount)}</td>
      <td>${p.remarks || '—'}</td>
      <td class="text-muted small">${p.createdBy || '—'}</td>
      <td>${canDelete ? `<button class="btn btn-sm btn-outline-danger btn-action" onclick="deletePetta('${p.id}')"><i class="bi bi-trash"></i></button>` : ''}</td>
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
        <td>${formatDate(dateKey(p.start))} - ${formatDate(dateKey(p.end))}</td>
        <td class="text-warning fw-semibold">${formatCurrency(p.petta)}</td>
        <td>${p.workedDays.toFixed(1)} / ${p.totalDays.toFixed(1)}</td>
        <td class="text-success fw-semibold">${formatCurrency(p.earned)}</td>
        <td class="text-info fw-semibold">${formatCurrency(p.paid)}</td>
        <td>${formatCurrency(p.opening)}</td>
        <td><span class="badge bg-${closeColor}-subtle text-${closeColor} border border-${closeColor}-subtle">${formatCurrency(Math.abs(p.closing))} ${closeLabel}</span></td>
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
  document.getElementById('btnSaveLeave').addEventListener('click', saveLeave);
  document.getElementById('btnSavePayment').addEventListener('click', savePayment);
  document.getElementById('btnSaveEdit').addEventListener('click', saveEdit);
  document.getElementById('btnSavePetta').addEventListener('click', savePetta);

  // Default date for payment modal
  document.getElementById('paymentModal').addEventListener('show.bs.modal', () => {
    document.getElementById('payDate').value = new Date().toISOString().split('T')[0];
    // Pre-fill today's date automatically for daily-pay employees
    if (empData.dailySalaryEnabled) {
      document.getElementById('payDate').value = new Date().toISOString().split('T')[0];
      const amountEl = document.getElementById('payAmount');
      if (!amountEl.value) amountEl.value = empData.perDaySalary || '';
    }
  });
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
      perDaySalary:       parseFloat(document.getElementById('editPerDay').value),
      dailyPetta:         parseFloat(document.getElementById('editPetta').value) || 0,
      status:             document.getElementById('editStatus').value,
      dailySalaryEnabled: document.getElementById('editDailyPay').checked
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
      addAsExpense: document.getElementById('payAddAsExpense').checked
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
