/* employee-detail.js */

let empId = null;
let empData = null;
let empLeaves = [];
let empPayments = [];

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
    [empData, empLeaves, empPayments] = await Promise.all([
      api('GET', `/employees/${empId}`),
      api('GET', `/leaves?employeeId=${empId}`),
      api('GET', `/payments?employeeId=${empId}`)
    ]);
    render();
  } catch (err) {
    document.getElementById('detailContent').innerHTML =
      `<div class="alert alert-danger">Failed to load employee: ${err.message}</div>`;
  }
}

/* ── Salary calculation ── */
function calcSalary() {
  const start = new Date(empData.startDate);
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const totalDays = Math.max(0, (today - start) / 86400000);

  // Sum leave days that fall between startDate and today
  const leaveDays = empLeaves.reduce((sum, l) => {
    const ls = new Date(l.startDateTime);
    const le = new Date(l.endDateTime);
    const s = Math.max(ls, start);
    const e = Math.min(le, today);
    return e > s ? sum + (e - s) / 86400000 : sum;
  }, 0);

  const workedDays = Math.max(0, totalDays - leaveDays);
  const earnedSalary = workedDays * (empData.perDaySalary - empData.dailyPetta);
  const totalPaid = empPayments.reduce((s, p) => s + p.amount, 0);
  const balance = earnedSalary - totalPaid;

  return { totalDays: totalDays.toFixed(1), leaveDays: leaveDays.toFixed(1),
           workedDays: workedDays.toFixed(1), earnedSalary, totalPaid, balance };
}

function isOnLeave() {
  const now = new Date();
  return empLeaves.some(l => new Date(l.startDateTime) <= now && now <= new Date(l.endDateTime));
}

/* ── Render entire detail view ── */
function render() {
  const sal = calcSalary();
  const onLeave = isOnLeave();

  const balanceIsNeg = sal.balance < 0;
  const balanceAbs = Math.abs(sal.balance);
  const balanceLabel = balanceIsNeg ? 'Salary Advance' : 'Salary Pending';
  const balanceColor = balanceIsNeg ? 'warning' : (sal.balance > 0 ? 'danger' : 'success');
  const balanceIcon  = balanceIsNeg ? 'bi-arrow-up-circle' : (sal.balance > 0 ? 'bi-hourglass-split' : 'bi-check-circle');

  const statusBadgeHtml = onLeave
    ? '<span class="badge bg-primary">🔵 On Leave</span>'
    : (empData.status === 'Active'
        ? '<span class="badge bg-success">🟢 Active</span>'
        : '<span class="badge bg-secondary">Inactive</span>');

  document.getElementById('detailContent').innerHTML = `

    <!-- Employee Info -->
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-person-circle me-2"></i>Employee Information</h6>
        ${statusBadgeHtml}
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
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">Per Day Salary</div>
            <div class="info-value fw-semibold text-success">${formatCurrency(empData.perDaySalary)}</div>
          </div>
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">Daily Petta</div>
            <div class="info-value text-warning">${formatCurrency(empData.dailyPetta)}</div>
          </div>
          <div class="col-sm-6 col-lg-3">
            <div class="info-label">Net Per Day</div>
            <div class="info-value fw-semibold">${formatCurrency(empData.perDaySalary - empData.dailyPetta)}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Salary Summary -->
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

    <!-- Salary Payments -->
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-cash-coin me-2"></i>Salary Payments</h6>
        <button class="btn btn-sm btn-primary" id="btnAddPayment">
          <i class="bi bi-plus-lg me-1"></i>Record Payment
        </button>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead><tr><th>Date</th><th>Amount</th><th>Remarks</th><th>Recorded By</th><th></th></tr></thead>
          <tbody id="paymentsBody">${renderPaymentsRows()}</tbody>
        </table>
      </div>
    </div>

    <!-- Leave History -->
    <div class="card-panel mb-3">
      <div class="card-panel-header">
        <h6 class="card-panel-title"><i class="bi bi-calendar-x me-2"></i>Leave History</h6>
        <button class="btn btn-sm btn-outline-primary" id="btnAddLeave">
          <i class="bi bi-plus-lg me-1"></i>Add Leave
        </button>
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead><tr><th>From</th><th>To</th><th>Duration</th><th>Remarks</th><th></th></tr></thead>
          <tbody id="leavesBody">${renderLeaveRows()}</tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btnAddLeave').addEventListener('click', () =>
    bootstrap.Modal.getOrCreateInstance(document.getElementById('leaveModal')).show());
  document.getElementById('btnAddPayment').addEventListener('click', () =>
    bootstrap.Modal.getOrCreateInstance(document.getElementById('paymentModal')).show());
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

function renderPaymentsRows() {
  if (!empPayments.length) return `<tr><td colspan="5" class="text-center text-muted py-3">No payments recorded</td></tr>`;
  return empPayments.map(p => `
    <tr>
      <td>${formatDate(p.paymentDate)}</td>
      <td class="fw-semibold text-success">${formatCurrency(p.amount)}</td>
      <td>${p.remarks || '—'}</td>
      <td class="text-muted small">${p.createdBy || '—'}</td>
      <td><button class="btn btn-sm btn-outline-danger btn-action" onclick="deletePayment('${p.id}')"><i class="bi bi-trash"></i></button></td>
    </tr>
  `).join('');
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

  // Default date for payment modal
  document.getElementById('paymentModal').addEventListener('show.bs.modal', () => {
    document.getElementById('payDate').value = new Date().toISOString().split('T')[0];
  });
}

function openEdit() {
  document.getElementById('editName').value      = empData.name;
  document.getElementById('editPhone').value     = empData.phone;
  document.getElementById('editAddress').value   = empData.address;
  document.getElementById('editStartDate').value = empData.startDate;
  document.getElementById('editPerDay').value    = empData.perDaySalary;
  document.getElementById('editPetta').value     = empData.dailyPetta;
  document.getElementById('editStatus').value    = empData.status;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('editEmpModal')).show();
}

async function saveEdit() {
  const form = document.getElementById('editEmpForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const btn = document.getElementById('btnSaveEdit');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';
  try {
    await api('PUT', `/employees/${empId}`, {
      name:         document.getElementById('editName').value.trim(),
      phone:        document.getElementById('editPhone').value.trim(),
      address:      document.getElementById('editAddress').value.trim(),
      startDate:    document.getElementById('editStartDate').value,
      perDaySalary: parseFloat(document.getElementById('editPerDay').value),
      dailyPetta:   parseFloat(document.getElementById('editPetta').value) || 0,
      status:       document.getElementById('editStatus').value
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
      remarks:      document.getElementById('payRemarks').value.trim()
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
