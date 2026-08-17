/* employees.js */

let allEmployees = [];
let editingEmpId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('employees')) { window.location.href = '/index.html'; return; }
  await loadEmployeesPage();
  setupSearch();
  setupModal();
});

async function loadEmployeesPage() {
  document.getElementById('empBody').innerHTML = loadingRow(7);
  try {
    allEmployees = await api('GET', '/employees');
    _cache.employees = allEmployees;
    renderTable(allEmployees);
  } catch (err) {
    document.getElementById('empBody').innerHTML = emptyRow(7, 'Failed to load employees.');
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

  if (!list.length) { tbody.innerHTML = emptyRow(7, 'No employees found.'); return; }

  tbody.innerHTML = list.map(e => `
    <tr>
      <td>
        <a href="/employee-detail.html?id=${e.id}" class="fw-semibold text-decoration-none">${e.name}</a>
        ${e.address ? `<div class="text-muted small">${e.address}</div>` : ''}
      </td>
      <td>${e.phone || '—'}</td>
      <td>${formatDate(e.startDate)}</td>
      <td class="fw-semibold">${formatCurrency(e.perDaySalary)}</td>
      <td class="text-warning">${formatCurrency(e.dailyPetta)}</td>
      <td>${statusBadge(e.status)}</td>
      <td>
        <div class="d-flex gap-1">
          <a href="/employee-detail.html?id=${e.id}" class="btn btn-sm btn-outline-primary btn-action" title="View"><i class="bi bi-eye"></i></a>
          <button class="btn btn-sm btn-outline-secondary btn-action" onclick="openEdit('${e.id}')" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger btn-action" onclick="remove('${e.id}')" title="Delete"><i class="bi bi-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
}

function setupModal() {
  document.getElementById('btnAddEmployee').addEventListener('click', () => {
    editingEmpId = null;
    document.getElementById('empForm').reset();
    document.getElementById('empModalTitle').textContent = 'Add Employee';
    document.getElementById('empStartDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('empStatus').value = 'Active';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('empModal')).show();
  });
  document.getElementById('btnSaveEmployee').addEventListener('click', save);
}

async function save() {
  const form = document.getElementById('empForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const body = {
    name:         document.getElementById('empName').value.trim(),
    phone:        document.getElementById('empPhone').value.trim(),
    address:      document.getElementById('empAddress').value.trim(),
    startDate:    document.getElementById('empStartDate').value,
    perDaySalary: parseFloat(document.getElementById('empPerDay').value),
    dailyPetta:   parseFloat(document.getElementById('empPetta').value) || 0,
    status:       document.getElementById('empStatus').value
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

