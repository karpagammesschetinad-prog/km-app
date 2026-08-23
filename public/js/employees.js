/* employees.js */

let allEmployees = [];
let employeeLeaves = [];
let editingEmpId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('employees')) { window.location.href = '/index.html'; return; }
  await loadEmployeesPage();
  setupSearch();
  setupModal();
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

function setupModal() {
  document.getElementById('btnAddEmployee').addEventListener('click', () => {
    editingEmpId = null;
    document.getElementById('empForm').reset();
    document.getElementById('empModalTitle').textContent = 'Add Employee';
    document.getElementById('empStartDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('empStatus').value = 'Active';
    document.getElementById('empDailyPay').checked = false;
    document.getElementById('empTemporary').checked = false;
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
    perDaySalary:       parseFloat(document.getElementById('empPerDay').value),
    dailyPetta:         parseFloat(document.getElementById('empPetta').value) || 0,
    status:             document.getElementById('empStatus').value,
    dailySalaryEnabled: document.getElementById('empDailyPay').checked,
    temporaryEmployee:  document.getElementById('empTemporary').checked
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
  document.getElementById('empDailyPay').checked = !!e.dailySalaryEnabled;
  document.getElementById('empTemporary').checked = !!e.temporaryEmployee;
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

