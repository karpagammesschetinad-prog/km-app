/* employees.js */

let allEmployees = [];
let employeeLeaves = [];
let editingEmpId = null;
let daySalaryData = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('employees')) { window.location.href = '/index.html'; return; }
  await loadEmployeesPage();
  setupSearch();
  setupModal();
  setupDaySalaryModal();
  // Hide Add button if no add sub-permission
  if (!canAccess('employees', 'add')) {
    const btn = document.getElementById('btnAddEmployee');
    if (btn) btn.style.display = 'none';
  }
});

async function loadEmployeesPage() {
  const showSalary = canAccess('salaries') || canAccess('employees', 'add');
  // Hide Per Day column header for non-salary users
  if (!showSalary) {
    document.querySelectorAll('.col-perday').forEach(el => el.style.display = 'none');
  }
  document.getElementById('empBody').innerHTML = loadingRow(showSalary ? 7 : 6);
  try {
    [allEmployees, employeeLeaves] = await Promise.all([
      api('GET', '/employees'), api('GET', '/leaves')
    ]);
    _cache.employees = allEmployees;
    renderTable(allEmployees);
  } catch (err) {
    document.getElementById('empBody').innerHTML = emptyRow(showSalary ? 7 : 6, 'Failed to load employees.');
    showNotification('Error: ' + err.message, 'danger');
  }
}

function setupSearch() {
  document.getElementById('empSearch')?.addEventListener('input', function () {
    const q = this.value.toLowerCase();
    const filtered = allEmployees.filter(e =>
      e.name.toLowerCase().includes(q) ||
      (e.phone || '').includes(q)
    );
    renderTable(filtered);
  });
}

function renderTable(list) {
  const tbody = document.getElementById('empBody');
  const countEl = document.getElementById('empCount');
  if (countEl) countEl.textContent = list.length;
  const showSalary = canAccess('salaries') || canAccess('employees', 'add');

  if (!list.length) { tbody.innerHTML = emptyRow(showSalary ? 7 : 6, 'No employees found.'); return; }

  const now = new Date();
  tbody.innerHTML = list.map(e => {
    const onLeave = employeeLeaves.some(leave => leave.employeeId === e.id &&
      new Date(leave.startDateTime) <= now && (!leave.endDateTime || now <= new Date(leave.endDateTime)));
    return `
    <tr>
      <td data-label="Employee">
        <a href="/employee-detail.html?id=${e.id}" class="fw-semibold text-decoration-none">${e.name}</a>
        ${e.dailySalaryEnabled ? '<span class="badge bg-info-subtle text-info border border-info-subtle ms-1" style="font-size:.65rem"><i class="bi bi-calendar-day me-1"></i>Daily Pay</span>' : ''}
        ${onLeave ? '<span class="badge bg-primary-subtle text-primary border border-primary-subtle ms-1"><i class="bi bi-calendar-x me-1"></i>On Leave</span>' : ''}
        ${e.address ? `<div class="text-muted small">${e.address}</div>` : ''}
      </td>
      <td data-label="Phone">${e.phone || '—'}</td>
      <td data-label="Start date">${formatDate(e.startDate)}</td>
      ${showSalary ? `<td data-label="Per day" class="fw-semibold">${formatCurrency(e.perDaySalary)}</td>` : ''}
      <td data-label="Petta" class="text-warning">${formatCurrency(e.dailyPetta)}</td>
      <td data-label="Status">${statusBadge(e.status)}</td>
      <td data-label="Actions">
        <div class="d-flex gap-1">
                  <a href="/employee-detail.html?id=${e.id}" class="btn btn-sm btn-outline-primary btn-action" title="View"><i class="bi bi-eye"></i></a>
          ${canAccess('employees','add') ? `<button class="btn btn-sm btn-outline-secondary btn-action" onclick="openEdit('${e.id}')" title="Edit"><i class="bi bi-pencil"></i></button>` : ''}
          ${(isSuperUser()) ? `<button class="btn btn-sm btn-outline-danger btn-action" onclick="remove('${e.id}')" title="Delete"><i class="bi bi-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>
  `;
  }).join('');
}

/* ---- Consolidated salary summary ---- */

function dayKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateRange(startDate, endDate) {
  const dates = [];
  for (let date = new Date(`${startDate}T00:00:00`); dayKeyOf(date) <= endDate; date.setDate(date.getDate() + 1)) {
    dates.push(dayKeyOf(date));
  }
  return dates;
}

// Leave is counted by calendar date only: a half day is 0.5, any other covered date is a full day.
function leaveSpanKeys(leave) {
  const startKey = String(leave.startDateTime || '').slice(0, 10);
  if (!startKey) return null;
  const rawEnd = leave.endDateTime ? new Date(leave.endDateTime) : null;
  if (!rawEnd || Number.isNaN(rawEnd.getTime())) return { startKey, endKey: dayKeyOf(new Date()), fraction: 1 };
  const spanHours = (rawEnd - new Date(leave.startDateTime)) / 3600000;
  const endKey = dayKeyOf(new Date(rawEnd.getTime() - 1));
  if (spanHours > 0 && spanHours <= 12 && endKey === startKey) return { startKey, endKey: startKey, fraction: 0.5 };
  return { startKey, endKey: endKey < startKey ? startKey : endKey, fraction: 1 };
}

// History endpoints return newest-first, so pick the latest entry in force rather than trusting order.
function amountOnDate(dateKey, base, history) {
  let bestDate = '';
  let amount = base;
  (history || []).forEach(entry => {
    const effective = String(entry.effectiveDate || '');
    if (!effective || effective > dateKey || effective < bestDate) return;
    bestDate = effective;
    amount = parseFloat(entry.amount) || 0;
  });
  return amount;
}

function setupDaySalaryModal() {
  const button = document.getElementById('btnDaySalary');
  if (!button) return;
  if (!(canAccess('salaries') || canAccess('employees', 'add'))) { button.style.display = 'none'; return; }
  const startDateInput = document.getElementById('daySalaryStartDate');
  const endDateInput = document.getElementById('daySalaryEndDate');
  const employeeOptions = document.getElementById('daySalaryEmployeeOptions');
  const employeeSearch = document.getElementById('daySalaryEmployeeSearch');
  button.addEventListener('click', async () => {
    const today = dayKeyOf(new Date());
    if (!startDateInput.value) startDateInput.value = today;
    if (!endDateInput.value) endDateInput.value = today;
    startDateInput.max = today;
    endDateInput.max = today;
    populateDaySalaryEmployees(employeeOptions);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('daySalaryModal')).show();
    await renderDaySalary();
  });
  startDateInput.addEventListener('change', renderDaySalary);
  endDateInput.addEventListener('change', renderDaySalary);
  employeeOptions.addEventListener('change', () => {
    updateDaySalaryEmployeeButton();
    renderDaySalary();
  });
  employeeSearch.addEventListener('input', filterDaySalaryEmployees);
  document.getElementById('daySalarySelectAll').addEventListener('click', () => setDaySalaryEmployeeSelection(true));
  document.getElementById('daySalaryClearAll').addEventListener('click', () => setDaySalaryEmployeeSelection(false));
}

function populateDaySalaryEmployees(options) {
  const selectedIds = new Set(Array.from(options.querySelectorAll('input:checked'), input => input.value));
  options.innerHTML = allEmployees
    .filter(employee => employee.status === 'Active')
    .sort((first, second) => first.name.localeCompare(second.name))
    .map(employee => `<label class="dropdown-item-text d-flex align-items-center gap-2 py-1"><input class="form-check-input day-salary-employee-check m-0" type="checkbox" value="${employee.id}"${selectedIds.has(employee.id) ? ' checked' : ''}><span>${escapeHtml(employee.name)}</span></label>`)
    .join('');
  updateDaySalaryEmployeeButton();
}

function selectedDaySalaryEmployeeIds() {
  return new Set(Array.from(document.querySelectorAll('.day-salary-employee-check:checked'), input => input.value));
}

function updateDaySalaryEmployeeButton() {
  const selectedIds = selectedDaySalaryEmployeeIds();
  const button = document.getElementById('daySalaryEmployeeButton');
  const selectedEmployees = allEmployees.filter(employee => selectedIds.has(employee.id));
  button.textContent = !selectedEmployees.length ? 'All employees' :
    (selectedEmployees.length === 1 ? selectedEmployees[0].name : `${selectedEmployees.length} employees selected`);
}

function filterDaySalaryEmployees() {
  const query = document.getElementById('daySalaryEmployeeSearch').value.trim().toLowerCase();
  document.querySelectorAll('#daySalaryEmployeeOptions label').forEach(label => {
    label.hidden = !label.textContent.toLowerCase().includes(query);
  });
}

function setDaySalaryEmployeeSelection(selected) {
  document.querySelectorAll('.day-salary-employee-check').forEach(input => { input.checked = selected; });
  updateDaySalaryEmployeeButton();
  renderDaySalary();
}

async function renderDaySalary() {
  const body = document.getElementById('daySalaryBody');
  const foot = document.getElementById('daySalaryFoot');
  const startDate = document.getElementById('daySalaryStartDate').value;
  const endDate = document.getElementById('daySalaryEndDate').value;
  const selectedEmployeeIds = selectedDaySalaryEmployeeIds();
  if (!body || !startDate || !endDate) return;
  body.innerHTML = loadingRow(6);
  foot.innerHTML = '';

  if (startDate > endDate) {
    body.innerHTML = emptyRow(6, 'Start date must be on or before end date.');
    document.getElementById('daySalaryTotals').textContent = '';
    return;
  }

  try {
    if (!daySalaryData) {
      const [payments, petta, salaryHistory] = await Promise.all([
        api('GET', '/payments'),
        api('GET', '/petta'),
        api('GET', '/salary-history')
      ]);
      daySalaryData = { payments, petta, salaryHistory };
    }
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="text-danger text-center py-3">Failed to load salary data: ${err.message}</td></tr>`;
    return;
  }

  const dates = dateRange(startDate, endDate);
  const rows = allEmployees
    .filter(employee => employee.status === 'Active' && String(employee.startDate || '') <= endDate &&
      (!selectedEmployeeIds.size || selectedEmployeeIds.has(employee.id)))
    .map(employee => salaryRangeRow(employee, dates))
    .filter(row => row.working)
    .sort((first, second) => first.name.localeCompare(second.name));

  if (!rows.length) {
    body.innerHTML = emptyRow(6, 'No employees working in this date range.');
    document.getElementById('daySalaryTotals').textContent = '';
    return;
  }

  const totals = rows.reduce((sum, row) => ({
    earned: sum.earned + row.earned,
    petta: sum.petta + (row.temporary ? 0 : row.petta),
    received: sum.received + row.received,
    pending: sum.pending + Math.max(0, row.pending)
  }), { earned: 0, petta: 0, received: 0, pending: 0 });

  document.getElementById('daySalaryTotals').textContent = `${rows.length} employees working from ${formatDate(startDate)} to ${formatDate(endDate)}`;

  body.innerHTML = rows.map(row => {
    const advance = row.pending < 0;
    const tone = advance ? 'warning' : (row.pending > 0 ? 'danger' : 'success');
    const label = advance ? 'Advance' : (row.pending > 0 ? 'Pending' : 'Settled');
    return `<tr>
      <td data-label="Employee"><a href="/employee-detail.html?id=${row.id}" class="fw-semibold text-decoration-none">${row.name}</a>${row.workingDays ? ` <span class="text-muted small">${row.workingDays} day${row.workingDays === 1 ? '' : 's'}</span>` : ''}</td>
      <td data-label="Type" class="text-muted small">${row.type}</td>
      <td data-label="Salary earned" class="text-end">${formatCurrency(row.earned)}</td>
      <td data-label="Petta" class="text-end text-warning">${row.temporary ? '—' : formatCurrency(row.petta)}</td>
      <td data-label="Salary received" class="text-end text-info fw-semibold">${formatCurrency(row.received)}</td>
      <td data-label="Pending salary" class="text-end"><span class="badge bg-${tone}-subtle text-${tone} border border-${tone}-subtle">${formatCurrency(Math.abs(row.pending))} ${label}</span></td>
    </tr>`;
  }).join('');

  foot.innerHTML = `<tr class="fw-bold" style="background:#f0f9ff">
    <td colspan="2">Total</td>
    <td class="text-end">${formatCurrency(totals.earned)}</td>
    <td class="text-end text-warning">${formatCurrency(totals.petta)}</td>
    <td class="text-end text-info">${formatCurrency(totals.received)}</td>
    <td class="text-end">${formatCurrency(totals.pending)}</td>
  </tr>`;
}

function salaryRangeRow(employee, dates) {
  const dailyRows = dates.map(date => daySalaryRow(employee, date));
  const workingRows = dailyRows.filter(row => row.working);
  const workingDays = workingRows.reduce((sum, row) => sum + row.worked, 0);
  const temporary = !!employee.temporaryEmployee;

  return {
    id: employee.id,
    name: employee.name,
    type: temporary ? 'Temporary' : (employee.dailySalaryEnabled ? 'Daily salary' : 'Regular'),
    temporary,
    working: temporary ? dailyRows.some(row => row.working) : workingDays > 0,
    workingDays,
    earned: temporary ? dailyRows.reduce((sum, row) => sum + row.received, 0) : dailyRows.reduce((sum, row) => sum + (row.perDay * row.worked), 0),
    petta: temporary ? 0 : dailyRows.reduce((sum, row) => sum + (row.petta * row.worked), 0),
    received: dailyRows.reduce((sum, row) => sum + row.received, 0),
    pending: dailyRows.reduce((sum, row) => sum + row.pending, 0)
  };
}

// Each date is settled independently: what was due that day minus what was paid that day.
function daySalaryRow(employee, dateKey) {
  const payments = daySalaryData.payments.filter(payment => payment.employeeId === employee.id);
  const received = payments
    .filter(payment => String(payment.paymentDate || '').slice(0, 10) === dateKey)
    .reduce((sum, payment) => sum + (parseFloat(payment.amount) || 0), 0);

  if (employee.temporaryEmployee) {
    return {
      id: employee.id, name: employee.name, type: 'Temporary', temporary: true,
      working: received > 0, worked: received > 0 ? 1 : 0, perDay: 0, petta: 0, received, pending: 0
    };
  }

  const leaveFraction = Math.min(1, employeeLeaves
    .filter(leave => leave.employeeId === employee.id)
    .map(leaveSpanKeys)
    .filter(span => span && dateKey >= span.startKey && dateKey <= span.endKey)
    .reduce((sum, span) => sum + span.fraction, 0));
  const worked = Math.max(0, 1 - leaveFraction);

  const perDay = amountOnDate(dateKey, parseFloat(employee.perDaySalary) || 0,
    daySalaryData.salaryHistory.filter(entry => entry.employeeId === employee.id));
  const petta = amountOnDate(dateKey, parseFloat(employee.dailyPetta) || 0,
    daySalaryData.petta.filter(entry => entry.employeeId === employee.id));
  const earned = worked * (perDay - petta);
  // Daily-pay staff are settled the same evening, so the day's earning is treated as received.
  const dailyPay = !!employee.dailySalaryEnabled;

  return {
    id: employee.id,
    name: employee.name,
    type: dailyPay ? 'Daily salary' : 'Regular',
    temporary: false,
    working: worked > 0,
    worked,
    perDay,
    petta,
    received: dailyPay ? (received || earned) : received,
    pending: dailyPay ? 0 : earned - received
  };
}

function setupModal() {
  const temporaryToggle = document.getElementById('empTemporary');
  const perDayInput = document.getElementById('empPerDay');
  const pettaInput = document.getElementById('empPetta');
  temporaryToggle.addEventListener('change', () => {
    const temporary = temporaryToggle.checked;
    perDayInput.required = !temporary;
    perDayInput.disabled = temporary;
    pettaInput.disabled = temporary;
    if (temporary) { perDayInput.value = ''; pettaInput.value = ''; }
  });
  document.getElementById('btnAddEmployee').addEventListener('click', () => {
    editingEmpId = null;
    document.getElementById('empForm').reset();
    document.getElementById('empModalTitle').textContent = 'Add Employee';
    document.getElementById('empStartDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('empStatus').value = 'Active';
    document.getElementById('empDailyPay').checked = false;
    document.getElementById('empTemporary').checked = false;
    temporaryToggle.dispatchEvent(new Event('change'));
    bootstrap.Modal.getOrCreateInstance(document.getElementById('empModal')).show();
  });
  document.getElementById('btnSaveEmployee').addEventListener('click', save);
}

async function save() {
  const form = document.getElementById('empForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const body = {
    name:               document.getElementById('empName').value.trim(),
    phone:              document.getElementById('empPhone').value.trim(),
    address:            document.getElementById('empAddress').value.trim(),
    startDate:          document.getElementById('empStartDate').value,
    perDaySalary:       parseFloat(document.getElementById('empPerDay').value) || 0,
    dailyPetta:         parseFloat(document.getElementById('empPetta').value) || 0,
    status:             document.getElementById('empStatus').value,
    dailySalaryEnabled: document.getElementById('empDailyPay').checked,
    temporaryEmployee:  document.getElementById('empTemporary').checked,
    openingBalance:     parseFloat(document.getElementById('empOpeningBalance').value) || 0
  };

  const btn = document.getElementById('btnSaveEmployee');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';

  try {
    if (editingEmpId) {
      await api('PUT', `/employees/${editingEmpId}`, body);
      showNotification('Employee updated.');
    } else {
      await api('POST', '/employees', body);
      showNotification('Employee added.');
    }
    bootstrap.Modal.getInstance(document.getElementById('empModal')).hide();
    await loadEmployeesPage();
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Employee';
  }
}

async function openEdit(id) {
  const e = allEmployees.find(x => x.id === id);
  if (!e) return;
  editingEmpId = id;
  document.getElementById('empModalTitle').textContent = 'Edit Employee';
  document.getElementById('empName').value      = e.name;
  document.getElementById('empPhone').value     = e.phone;
  document.getElementById('empAddress').value   = e.address;
  document.getElementById('empStartDate').value = e.startDate;
  document.getElementById('empPerDay').value    = e.perDaySalary;
  document.getElementById('empPetta').value     = e.dailyPetta;
  document.getElementById('empStatus').value    = e.status;
  document.getElementById('empOpeningBalance').value = e.openingBalance || 0;
  document.getElementById('empDailyPay').checked = !!e.dailySalaryEnabled;
  document.getElementById('empTemporary').checked = !!e.temporaryEmployee;
  temporaryToggle.dispatchEvent(new Event('change'));
  if (!e.temporaryEmployee) {
    document.getElementById('empPerDay').value = e.perDaySalary;
    document.getElementById('empPetta').value = e.dailyPetta;
  }
  bootstrap.Modal.getOrCreateInstance(document.getElementById('empModal')).show();
}

async function remove(id) {
  if (!confirm('Delete this employee? This action cannot be undone.')) return;
  try {
    await api('DELETE', `/employees/${id}`);
    showNotification('Employee deleted.');
    await loadEmployeesPage();
  } catch (err) { showNotification('Error: ' + err.message, 'danger'); }
}

