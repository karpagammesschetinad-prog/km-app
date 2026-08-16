/* employees.js */

let allEmployees = [];
let editingEmpId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  await loadEmployeesPage();
  setupSearch();
  setupModal();
});

async function loadEmployeesPage() {
  document.getElementById('empBody').innerHTML = loadingRow(7);
  try {
    allEmployees = await api('GET', '/employees');
    _cache.employees = allEmployees; // refresh shared cache
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
      e.email.toLowerCase().includes(q) ||
      e.department.toLowerCase().includes(q) ||
      e.position.toLowerCase().includes(q)
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
        <div class="fw-semibold">${e.name}</div>
        <div class="text-muted small">${e.email || '—'}</div>
      </td>
      <td>${e.department}</td>
      <td>${e.position}</td>
      <td class="fw-semibold">${formatCurrency(e.baseSalary)}</td>
      <td>${formatDate(e.joinDate)}</td>
      <td>${statusBadge(e.status)}</td>
      <td>
        <div class="d-flex gap-1">
          <button class="btn btn-sm btn-outline-primary btn-action" onclick="openEdit('${e.id}')" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-${e.status === 'Active' ? 'warning' : 'success'} btn-action"
            onclick="toggleStatus('${e.id}','${e.status === 'Active' ? 'Inactive' : 'Active'}')"
            title="${e.status === 'Active' ? 'Deactivate' : 'Activate'}">
            <i class="bi bi-${e.status === 'Active' ? 'pause-circle' : 'play-circle'}"></i>
          </button>
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
    document.getElementById('empJoinDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('empStatus').value = 'Active';
    bootstrap.Modal.getOrCreateInstance(document.getElementById('empModal')).show();
  });
  document.getElementById('btnSaveEmployee').addEventListener('click', save);
}

async function save() {
  const form = document.getElementById('empForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const body = {
    name: document.getElementById('empName').value.trim(),
    email: document.getElementById('empEmail').value.trim(),
    department: document.getElementById('empDept').value,
    position: document.getElementById('empPosition').value.trim(),
    baseSalary: parseFloat(document.getElementById('empSalary').value),
    joinDate: document.getElementById('empJoinDate').value,
    status: document.getElementById('empStatus').value
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
  document.getElementById('empName').value = e.name;
  document.getElementById('empEmail').value = e.email;
  document.getElementById('empDept').value = e.department;
  document.getElementById('empPosition').value = e.position;
  document.getElementById('empSalary').value = e.baseSalary;
  document.getElementById('empJoinDate').value = e.joinDate;
  document.getElementById('empStatus').value = e.status;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('empModal')).show();
}

async function toggleStatus(id, newStatus) {
  const label = newStatus === 'Active' ? 'activate' : 'deactivate';
  if (!confirm(`Are you sure you want to ${label} this employee?`)) return;
  try {
    await api('PUT', `/employees/${id}`, { status: newStatus });
    showNotification(`Employee ${newStatus === 'Active' ? 'activated' : 'deactivated'}.`);
    await loadEmployeesPage();
  } catch (err) { showNotification('Error: ' + err.message, 'danger'); }
}

async function remove(id) {
  if (!confirm('Delete this employee? This action cannot be undone.')) return;
  try {
    await api('DELETE', `/employees/${id}`);
    showNotification('Employee deleted.');
    await loadEmployeesPage();
  } catch (err) { showNotification('Error: ' + err.message, 'danger'); }
}

