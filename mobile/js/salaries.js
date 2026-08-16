/* salaries.js */

let allSalaries = [];
let allEmpList = [];
let editingSalId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  initFilters();
  allEmpList = await fetchEmployees();
  await loadSalaries();
  setupListeners();
});

function initFilters() {
  const now = new Date();
  document.getElementById('fMonth').value = now.getMonth() + 1;
  document.getElementById('fYear').value = now.getFullYear();
}

async function loadSalaries() {
  document.getElementById('salBody').innerHTML = loadingRow(9);
  try {
    allSalaries = await api('GET', '/salaries');
    applyFilters();
  } catch (err) {
    document.getElementById('salBody').innerHTML = emptyRow(9, 'Failed to load salaries.');
    showNotification('Error: ' + err.message, 'danger');
  }
}

function applyFilters() {
  const m = parseInt(document.getElementById('fMonth').value) || 0;
  const y = parseInt(document.getElementById('fYear').value) || 0;
  const q = document.getElementById('salSearch').value.toLowerCase();

  const filtered = allSalaries.filter(s => {
    if (m && parseInt(s.month) !== m) return false;
    if (y && parseInt(s.year) !== y) return false;
    if (q && !s.employeeName.toLowerCase().includes(q)) return false;
    return true;
  });
  renderTable(filtered);
}

function renderTable(list) {
  const tbody = document.getElementById('salBody');
  const totalEl = document.getElementById('salTotal');
  const total = list.reduce((s, e) => s + (parseFloat(e.netSalary) || 0), 0);
  if (totalEl) totalEl.textContent = formatCurrency(total);

  if (!list.length) { tbody.innerHTML = emptyRow(9, 'No salary records for this period.'); return; }

  tbody.innerHTML = list.map(s => `
    <tr>
      <td class="fw-semibold">${s.employeeName}</td>
      <td>${formatMonth(s.month, s.year)}</td>
      <td>${formatCurrency(s.baseSalary)}</td>
      <td class="text-success">${formatCurrency(s.allowances)}</td>
      <td class="text-danger">${formatCurrency(s.deductions)}</td>
      <td class="fw-bold">${formatCurrency(s.netSalary)}</td>
      <td>${s.paymentDate ? formatDate(s.paymentDate) : '—'}</td>
      <td>${statusBadge(s.status)}</td>
      <td>
        <div class="d-flex gap-1 flex-wrap">
          ${s.status === 'Pending' ? `
            <button class="btn btn-sm btn-outline-success btn-action" onclick="markPaid('${s.id}')" title="Mark as Paid">
              <i class="bi bi-check2-all"></i>
            </button>
          ` : ''}
          <button class="btn btn-sm btn-outline-primary btn-action" onclick="openEdit('${s.id}')" title="Edit"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger btn-action" onclick="remove('${s.id}')" title="Delete"><i class="bi bi-trash"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
}

function setupListeners() {
  ['fMonth', 'fYear', 'salSearch'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', applyFilters)
  );

  // Process salaries modal
  document.getElementById('btnProcess').addEventListener('click', () => {
    const now = new Date();
    document.getElementById('procMonth').value = now.getMonth() + 1;
    document.getElementById('procYear').value = now.getFullYear();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('processModal')).show();
  });
  document.getElementById('btnConfirmProcess').addEventListener('click', processSalaries);

  // Add salary modal
  document.getElementById('btnAddSalary').addEventListener('click', () => {
    editingSalId = null;
    document.getElementById('salForm').reset();
    document.getElementById('salModalTitle').textContent = 'Add Salary Record';
    const now = new Date();
    document.getElementById('salMonth').value = now.getMonth() + 1;
    document.getElementById('salYear').value = now.getFullYear();
    document.getElementById('salStatus').value = 'Pending';
    document.getElementById('salAllowances').value = '0';
    document.getElementById('salDeductions').value = '0';
    populateEmployeeSelect(document.getElementById('salEmployee'), allEmpList);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('salModal')).show();
  });

  // Auto-fill salary when employee selected
  document.getElementById('salEmployee')?.addEventListener('change', function () {
    const opt = this.options[this.selectedIndex];
    if (opt.dataset.salary) {
      document.getElementById('salBase').value = opt.dataset.salary;
      calcNet();
    }
  });

  ['salBase', 'salAllowances', 'salDeductions'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', calcNet)
  );

  document.getElementById('btnSaveSalary').addEventListener('click', save);
}

function calcNet() {
  const base = parseFloat(document.getElementById('salBase').value) || 0;
  const allow = parseFloat(document.getElementById('salAllowances').value) || 0;
  const ded = parseFloat(document.getElementById('salDeductions').value) || 0;
  document.getElementById('salNet').value = (base + allow - ded).toFixed(2);
}

async function processSalaries() {
  const month = parseInt(document.getElementById('procMonth').value);
  const year = parseInt(document.getElementById('procYear').value);
  const btn = document.getElementById('btnConfirmProcess');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Processing…';

  try {
    const result = await api('POST', '/salaries/process', { month, year });
    bootstrap.Modal.getInstance(document.getElementById('processModal')).hide();
    const count = Array.isArray(result) ? result.length : 0;
    showNotification(`Processed ${count} salary record(s) for ${formatMonth(month, year)}.`);
    document.getElementById('fMonth').value = month;
    document.getElementById('fYear').value = year;
    await loadSalaries();
  } catch (err) {
    showNotification('Processing failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Process Salaries';
  }
}

async function save() {
  const form = document.getElementById('salForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const sel = document.getElementById('salEmployee');
  const opt = sel.options[sel.selectedIndex];
  const body = {
    employeeId: sel.value,
    employeeName: opt.text,
    month: parseInt(document.getElementById('salMonth').value),
    year: parseInt(document.getElementById('salYear').value),
    baseSalary: parseFloat(document.getElementById('salBase').value),
    allowances: parseFloat(document.getElementById('salAllowances').value) || 0,
    deductions: parseFloat(document.getElementById('salDeductions').value) || 0,
    netSalary: parseFloat(document.getElementById('salNet').value),
    paymentDate: document.getElementById('salPayDate').value,
    status: document.getElementById('salStatus').value
  };

  const btn = document.getElementById('btnSaveSalary');
  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving…';

  try {
    if (editingSalId) {
      await api('PUT', `/salaries/${editingSalId}`, body);
      showNotification('Salary record updated.');
    } else {
      await api('POST', '/salaries', body);
      showNotification('Salary record added.');
    }
    bootstrap.Modal.getInstance(document.getElementById('salModal')).hide();
    await loadSalaries();
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Record';
  }
}

async function openEdit(id) {
  const s = allSalaries.find(x => x.id === id);
  if (!s) return;
  editingSalId = id;
  document.getElementById('salModalTitle').textContent = 'Edit Salary Record';
  populateEmployeeSelect(document.getElementById('salEmployee'), allEmpList, s.employeeId);
  document.getElementById('salMonth').value = s.month;
  document.getElementById('salYear').value = s.year;
  document.getElementById('salBase').value = s.baseSalary;
  document.getElementById('salAllowances').value = s.allowances;
  document.getElementById('salDeductions').value = s.deductions;
  document.getElementById('salNet').value = s.netSalary;
  document.getElementById('salPayDate').value = s.paymentDate || '';
  document.getElementById('salStatus').value = s.status;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('salModal')).show();
}

async function markPaid(id) {
  const s = allSalaries.find(x => x.id === id);
  if (!confirm(`Mark ${s?.employeeName}'s salary as Paid?`)) return;
  try {
    await api('PUT', `/salaries/${id}`, { status: 'Paid', paymentDate: new Date().toISOString().split('T')[0] });
    showNotification('Salary marked as Paid.');
    await loadSalaries();
  } catch (err) { showNotification('Error: ' + err.message, 'danger'); }
}

async function remove(id) {
  if (!confirm('Delete this salary record?')) return;
  try {
    await api('DELETE', `/salaries/${id}`);
    showNotification('Salary record deleted.');
    await loadSalaries();
  } catch (err) { showNotification('Error: ' + err.message, 'danger'); }
}

