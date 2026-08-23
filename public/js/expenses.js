/* expenses.js */

let allExpenses = [];
let allCategories = [];
let allCategoryTypes = [];
let pendingRejectDate = null;
let onSpotEntriesForDate = [];
let datePickerMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let expenseEmployees = [];

function getLocalDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const today = getLocalDateKey();

document.addEventListener('DOMContentLoaded', async () => {
  // Auth guard
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('expenses')) { window.location.href = '/index.html'; return; }
  document.getElementById('btnEmployeeExpense').style.display = canAccess('expenses', 'add') ? '' : 'none';
  document.getElementById('btnEmployeeExpense').addEventListener('click', openEmployeeExpenseModal);
  document.getElementById('btnSaveEmployeeExpense').addEventListener('click', saveEmployeeExpense);

  // Hide add form if no add sub-permission
  if (!canAccess('expenses', 'add')) {
    const addSection = document.getElementById('addExpenseSection');
    if (addSection) addSection.style.display = 'none';
  }

  const dateInput = document.getElementById('expDate');
  dateInput.value = today;
  dateInput.addEventListener('click', toggleExpenseDatePicker);
  document.addEventListener('click', event => {
    const picker = document.getElementById('expenseDatePicker');
    if (!picker || picker.contains(event.target) || event.target === dateInput) return;
    picker.classList.remove('show');
    dateInput.setAttribute('aria-expanded', 'false');
  });

  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString().split('T')[0];
  document.getElementById('fDateFrom').value = firstOfMonth;
  document.getElementById('fDateTo').value = today;

  document.getElementById('expDate').addEventListener('change', function () {
    if (this.value > today) {
      this.value = today;
      showNotification('Future dates cannot be selected.', 'warning');
      return;
    }
    loadDateIntoForm(this.value);
  });

  document.getElementById('btnSaveExpense').addEventListener('click', save);

  document.getElementById('btnReport').addEventListener('click', () => {
    if (!isSuperUser()) return;
    buildCatFilterChips();
    renderSummary();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('reportModal')).show();
  });

  document.getElementById('btnFilter').addEventListener('click', renderSummary);
  document.getElementById('btnClearFilter').addEventListener('click', () => {
    document.getElementById('fDateFrom').value = '';
    document.getElementById('fDateTo').value = '';
    renderSummary();
  });

  document.getElementById('btnToggleChart').addEventListener('click', () => {
    const section = document.getElementById('chartSection');
    const btn = document.getElementById('btnToggleChart');
    const visible = section.style.display !== 'none';
    section.style.display = visible ? 'none' : '';
    btn.classList.toggle('btn-outline-secondary', visible);
    btn.classList.toggle('btn-primary', !visible);
    if (!visible) renderSummary();
  });

  document.getElementById('btnConfirmReject').addEventListener('click', confirmReject);

  try {
    [allCategories, allCategoryTypes, allExpenses, expenseEmployees] = await Promise.all([
      api('GET', '/categories'),
      api('GET', '/categories/types/all'),
      api('GET', '/expenses'),
      api('GET', '/employees')
    ]);
    loadDateIntoForm(today);
    renderExpenseDatePicker();
  } catch (err) {
    showNotification('Error loading data: ' + err.message, 'danger');
  }
});

function openEmployeeExpenseModal() {
  const employeeSelect = document.getElementById('employeeExpenseEmployee');
  const typeSelect = document.getElementById('employeeExpenseType');
  employeeSelect.innerHTML = '<option value="">— Select Employee —</option>' + expenseEmployees
    .filter(employee => employee.status === 'Active')
    .map(employee => `<option value="${employee.id}">${escapeHtml(employee.name)}</option>`).join('');
  typeSelect.innerHTML = '<option value="">— Select Expense Type —</option>' + allCategoryTypes
    .filter(type => type.status === 'Active')
    .map(type => `<option value="${type.id}">${escapeHtml(type.name)}</option>`).join('');
  const form = document.getElementById('employeeExpenseForm');
  form.reset();
  document.getElementById('employeeExpenseDate').value = today;
  document.getElementById('employeeExpenseDate').max = today;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('employeeExpenseModal')).show();
}

async function saveEmployeeExpense() {
  const form = document.getElementById('employeeExpenseForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const employee = expenseEmployees.find(item => item.id === document.getElementById('employeeExpenseEmployee').value);
  const button = document.getElementById('btnSaveEmployeeExpense');
  button.disabled = true;
  try {
    await api('POST', '/payments', {
      employeeId: employee.id,
      employeeName: employee.name,
      paymentDate: document.getElementById('employeeExpenseDate').value,
      amount: parseFloat(document.getElementById('employeeExpenseAmount').value),
      remarks: document.getElementById('employeeExpenseRemarks').value.trim(),
      addAsExpense: true,
      expenseTypeId: document.getElementById('employeeExpenseType').value
    });
    bootstrap.Modal.getInstance(document.getElementById('employeeExpenseModal')).hide();
    showNotification('Employee payment added as an expense.');
    allExpenses = await api('GET', '/expenses');
    loadDateIntoForm(document.getElementById('expDate').value);
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    button.disabled = false;
  }
}

/* ---- Load a date into the entry form ---- */

function loadDateIntoForm(date) {
  if (!date || date > today) {
    document.getElementById('expDate').value = today;
    return loadDateIntoForm(today);
  }
  const existing = getExistingForDate(date);
  onSpotEntriesForDate = allExpenses.filter(e => e.date === date && e.onSpot && !e.employeeId);
  const hasData = Object.keys(existing).length > 0;
  const isToday = date === today;

  document.getElementById('formTitle').innerHTML =
    '<i class="bi bi-pencil-square me-2"></i>Expense';

  const badge = document.getElementById('formBadge');
  updateDateStatusColor(date);
  renderExpenseDatePicker();
  if (isToday) {
    badge.textContent = 'Today';
    badge.className = 'badge bg-primary-subtle text-primary border border-primary-subtle';
  } else if (hasData) {
    badge.textContent = formatDate(date);
    badge.className = 'badge bg-warning-subtle text-warning border border-warning-subtle';
  } else {
    badge.textContent = formatDate(date);
    badge.className = 'badge bg-secondary-subtle text-secondary border border-secondary-subtle';
  }

  const remarkRow = allExpenses.find(e => e.date === date && e.description);
  document.getElementById('expRemarks').value = remarkRow ? remarkRow.description : '';

  // Check if date is approved
  const approvedRow = allExpenses.find(e => e.date === date && (e.approvalStatus === 'Approved' || e.approvalStatus === 'AutoApproved'));
  const isApproved = !!approvedRow;

  // Show rejection notice if cashier sees a rejected date
  const rejectedRow = allExpenses.find(e => e.date === date && e.approvalStatus === 'Rejected');
  const noticeEl = document.getElementById('rejectionNotice');
  if (rejectedRow && !isSuperUser() && !isApproved) {
    noticeEl.innerHTML =
      '<i class="bi bi-exclamation-triangle-fill me-2"></i><strong>Rejected:</strong> ' +
      (rejectedRow.rejectionReason || 'Please correct and resubmit.') +
      ' <em class="text-muted small">— ' + rejectedRow.approvedBy + '</em>';
    noticeEl.style.display = '';
  } else if (isApproved) {
    noticeEl.innerHTML =
      '<i class="bi bi-check-circle-fill me-2 text-success"></i><strong>Approved</strong> ' +
      '<span class="text-muted small">— This date\'s expenses have been approved and cannot be edited.</span>';
    noticeEl.className = 'alert alert-success';
    noticeEl.style.display = '';
  } else {
    noticeEl.style.display = '';
    noticeEl.className = 'alert alert-danger';
    noticeEl.style.display = 'none';
  }

  buildCategoryInputs(existing, isApproved);
  updateTotal();

  // Disable save button and remarks if approved
  const btnSave = document.getElementById('btnSaveExpense');
  const remarksInput = document.getElementById('expRemarks');
  if (isApproved) {
    btnSave.disabled = true;
    btnSave.innerHTML = '<i class="bi bi-lock me-1"></i>Approved';
    remarksInput.readOnly = true;
  } else {
    btnSave.disabled = false;
    btnSave.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Expense';
    remarksInput.readOnly = false;
  }
}

function updateDateStatusColor(date) {
  const input = document.getElementById('expDate');
  if (!input) return;
  input.classList.remove('expense-date-input-approved', 'expense-date-input-rejected', 'expense-date-input-neutral');
  const statuses = allExpenses.filter(expense => expense.date === date).map(expense => expense.approvalStatus);
  const status = statuses.includes('Rejected') ? 'rejected' : statuses.some(value => value === 'Approved' || value === 'AutoApproved') ? 'approved' : 'neutral';
  input.classList.add(`expense-date-input-${status}`);
}

function toggleExpenseDatePicker() {
  const picker = document.getElementById('expenseDatePicker');
  const input = document.getElementById('expDate');
  const open = picker.classList.toggle('show');
  input.setAttribute('aria-expanded', String(open));
  if (open) renderExpenseDatePicker();
}

function renderExpenseDatePicker() {
  const picker = document.getElementById('expenseDatePicker');
  if (!picker) return;
  const year = datePickerMonth.getFullYear();
  const month = datePickerMonth.getMonth();
  const statuses = {};
  allExpenses.forEach(expense => {
    const current = statuses[expense.date];
    if (expense.approvalStatus === 'Rejected' || current === 'Rejected') statuses[expense.date] = 'Rejected';
    else if (expense.approvalStatus === 'Approved' || expense.approvalStatus === 'AutoApproved' || current === 'Approved') statuses[expense.date] = 'Approved';
    else statuses[expense.date] = expense.approvalStatus;
  });
  let days = Array(new Date(year, month, 1).getDay()).fill('<span class="expense-date-picker-empty"></span>').join('');
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const date = getLocalDateKey(new Date(year, month, day));
    const status = statuses[date];
    const state = status === 'Rejected' ? 'rejected' : (status === 'Approved' ? 'approved' : 'neutral');
    days += `<button type="button" class="expense-date-picker-day ${state}${date === document.getElementById('expDate').value ? ' selected' : ''}" data-picker-date="${date}" ${date > today ? 'disabled' : ''}>${day}</button>`;
  }
  picker.innerHTML = `<div class="expense-date-picker-header"><button type="button" data-picker-nav="prev" aria-label="Previous month"><i class="bi bi-chevron-left"></i></button><strong>${datePickerMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong><button type="button" data-picker-nav="next" aria-label="Next month"><i class="bi bi-chevron-right"></i></button></div><div class="expense-date-picker-weekdays">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => `<span>${day}</span>`).join('')}</div><div class="expense-date-picker-grid">${days}</div><div class="expense-date-picker-legend"><span><i class="approved"></i>Approved</span><span><i class="rejected"></i>Rejected</span><span><i class="neutral"></i>Not approved/rejected</span></div>`;
  picker.querySelectorAll('[data-picker-date]').forEach(button => button.addEventListener('click', () => {
    document.getElementById('expDate').value = button.dataset.pickerDate;
    picker.classList.remove('show');
    document.getElementById('expDate').setAttribute('aria-expanded', 'false');
    loadDateIntoForm(button.dataset.pickerDate);
  }));
  picker.querySelector('[data-picker-nav="prev"]')?.addEventListener('click', () => { datePickerMonth = new Date(year, month - 1, 1); renderExpenseDatePicker(); });
  picker.querySelector('[data-picker-nav="next"]')?.addEventListener('click', () => { datePickerMonth = new Date(year, month + 1, 1); renderExpenseDatePicker(); });
}

function getExistingForDate(date) {
  const map = {};
  allExpenses.filter(e => e.date === date).forEach(e => {
    if (e.category && !e.onSpot) map[e.category] = (map[e.category] || 0) + (parseFloat(e.amount) || 0);
  });
  return map;
}

/* ---- Category inputs ---- */

function buildCategoryInputs(existingMap, isReadOnly) {
  existingMap = existingMap || {};
  const active = allCategories
    .filter(c => c.status === 'Active')
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const container = document.getElementById('categoryInputs');

  if (!active.length && !Object.keys(existingMap).length && !onSpotEntriesForDate.length) {
    container.innerHTML = '<div class="text-center text-muted py-3">No active categories. <a href="/categories.html">Manage</a></div>';
    return;
  }

  const readonlyAttr = isReadOnly ? ' readonly disabled style="font-size:1rem;background:#f8f9fa"' : ' style="font-size:1rem"';
  const typeById = new Map(allCategoryTypes.map(t => [t.id, t]));
  const legacyType = allCategoryTypes.find(t => t.name === 'General') || allCategoryTypes.find(t => t.sortOrder === 1) || allCategoryTypes[0] || { id: '', name: 'General', sortOrder: 0 };
  const grouped = new Map();
  active.forEach(c => {
    const type = typeById.get(c.typeId) || legacyType;
    if (!grouped.has(type.id)) grouped.set(type.id, { type, categories: [] });
    grouped.get(type.id).categories.push(c);
  });
  allExpenses.filter(e => e.date === document.getElementById('expDate').value && e.employeeId && !e.onSpot).forEach(entry => {
    const type = typeById.get(entry.typeId) || legacyType;
    if (!grouped.has(type.id)) grouped.set(type.id, { type, categories: [] });
    grouped.get(type.id).salaryEntries = grouped.get(type.id).salaryEntries || [];
    grouped.get(type.id).salaryEntries.push(entry);
  });
  onSpotEntriesForDate.forEach(entry => {
    const type = typeById.get(entry.typeId) || legacyType;
    if (!grouped.has(type.id)) grouped.set(type.id, { type, categories: [] });
    grouped.get(type.id).onSpotEntries = grouped.get(type.id).onSpotEntries || [];
    grouped.get(type.id).onSpotEntries.push(entry);
  });
  const cards = [...grouped.values()].sort((a, b) => a.type.sortOrder - b.type.sortOrder).map(({ type, categories, onSpotEntries = [], salaryEntries = [] }) => {
    const items = categories.map(c => {
      const val = existingMap[c.name] > 0 ? existingMap[c.name] : '';
      return '<div class="expense-category-row d-flex align-items-center gap-3 py-2">' +
        '<span class="fw-medium flex-grow-1">' + c.name + '</span>' +
        '<div class="input-group expense-amount-input">' +
        '<span class="input-group-text fw-semibold">&#8377;</span>' +
        '<input type="number" class="form-control cat-amount" data-category="' + c.name + '" data-type="' + type.id + '" data-onspot="false" ' +
        'min="0" step="0.01" placeholder="0" value="' + val + '" oninput="updateTotal()"' + readonlyAttr + '>' +
        '</div></div>';
    }).join('');
    const onSpotRows = onSpotEntries.map(entry => '<div class="expense-category-row onspot-row d-flex align-items-center gap-3 py-2">' +
      '<input type="text" class="form-control onspot-name flex-grow-1" data-type="' + type.id + '" value="' + escapeHtml(entry.category) + '" placeholder="On-spot category"' + (isReadOnly ? ' readonly disabled' : '') + '>' +
      '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span><input type="number" class="form-control cat-amount" data-category="' + escapeHtml(entry.category) + '" data-type="' + type.id + '" data-onspot="true" min="0" step="0.01" value="' + entry.amount + '" oninput="updateTotal()"' + readonlyAttr + '></div>' +
      (isReadOnly ? '' : '<button type="button" class="btn btn-sm btn-outline-danger onspot-delete" title="Delete on-spot expense" onclick="deleteOnSpotExpense(\'' + entry.id + '\')"><i class="bi bi-trash"></i></button>') + '</div>').join('');
    const salaryRows = salaryEntries.map(entry => '<div class="expense-category-row salary-expense-row d-flex align-items-center gap-3 py-2">' +
      '<span class="fw-medium flex-grow-1"><i class="bi bi-cash-coin me-1 text-success"></i>' + escapeHtml(entry.category) + '<small class="d-block text-muted">Salary payment</small></span>' +
      '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span><input type="number" class="form-control cat-amount" data-category="' + escapeHtml(entry.category) + '" data-type="' + type.id + '" value="' + entry.amount + '" readonly disabled></div>' +
      (isReadOnly || !entry.paymentId ? '' : '<button type="button" class="btn btn-sm btn-outline-danger salary-expense-delete" title="Delete employee payment" onclick="deleteEmployeePayment(\'' + entry.paymentId + '\')"><i class="bi bi-trash"></i></button>') + '</div>').join('');
    const onSpotAction = isReadOnly ? '' : '<button type="button" class="btn btn-sm btn-outline-secondary onspot-add" onclick="addOnSpotRow(this)"><i class="bi bi-plus-lg me-1"></i>On-spot category</button>';
    return '<section class="expense-category-type-card is-collapsed" data-type-card="' + type.id + '">' +
      '<button type="button" class="expense-category-type-header" aria-expanded="false" onclick="toggleExpenseType(this)">' +
      '<span class="expense-category-type-title"><i class="bi bi-chevron-right expense-type-chevron"></i><span>' + (type.displayText || type.name) + '</span></span>' +
      '<strong class="expense-type-total" data-type-total="' + type.id + '">' + formatCurrency(0) + '</strong></button>' +
      '<div class="expense-category-type-content">' + items + salaryRows + onSpotRows + '<div class="onspot-action-row">' + onSpotAction + '</div></div></section>';
  }).join('');

  // Show read-only entries for categories not in the active list (e.g. employee salary payments)
  const salaryNames = new Set(allExpenses.filter(e => e.date === document.getElementById('expDate').value && e.employeeId).map(e => e.category));
  const extraItems = Object.keys(existingMap)
    .filter(k => !active.some(c => c.name === k) && !salaryNames.has(k) && existingMap[k] > 0)
    .map(k => {
      return '<div class="expense-category-row d-flex align-items-center gap-3 py-2 bg-light rounded px-2">' +
        '<span class="fw-medium flex-grow-1"><i class="bi bi-lock me-1 text-muted"></i>' + k + '</span>' +
        '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span>' +
        '<input type="number" class="form-control cat-amount" data-category="' + k + '" value="' + existingMap[k] + '" readonly disabled></div></div>';
    }).join('');

  container.innerHTML = cards + (extraItems ? '<section class="expense-category-type-card expense-category-type-locked is-collapsed"><button type="button" class="expense-category-type-header" aria-expanded="false" onclick="toggleExpenseType(this)"><span class="expense-category-type-title"><i class="bi bi-chevron-right expense-type-chevron"></i><span>Other recorded entries</span></span></button><div class="expense-category-type-content">' + extraItems + '</div></section>' : '');
  updateTotal();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function addOnSpotRow(button) {
  const card = button.closest('.expense-category-type-card');
  const typeId = card.dataset.typeCard;
  const content = card.querySelector('.expense-category-type-content');
  const actions = card.querySelector('.onspot-action-row');
  const row = document.createElement('div');
  row.className = 'expense-category-row onspot-row d-flex align-items-center gap-3 py-2';
  row.innerHTML = '<input type="text" class="form-control onspot-name flex-grow-1" data-type="' + typeId + '" placeholder="On-spot category">' +
    '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span><input type="number" class="form-control cat-amount" data-category="" data-type="' + typeId + '" data-onspot="true" min="0" step="0.01" placeholder="0" oninput="updateTotal()"></div>';
  content.insertBefore(row, actions);
  row.querySelector('.onspot-name').focus();
}

async function deleteOnSpotExpense(id) {
  if (!id || !confirm('Delete this on-spot expense?')) return;
  try {
    await api('DELETE', '/expenses/' + encodeURIComponent(id));
    showNotification('On-spot expense deleted.');
    allExpenses = await api('GET', '/expenses');
    loadDateIntoForm(document.getElementById('expDate').value);
  } catch (err) {
    showNotification('Delete failed: ' + err.message, 'danger');
  }
}

async function deleteEmployeePayment(id) {
  if (!id || !confirm('Delete this employee payment and its expense?')) return;
  try {
    await api('DELETE', '/payments/' + encodeURIComponent(id));
    showNotification('Employee payment deleted.');
    allExpenses = await api('GET', '/expenses');
    loadDateIntoForm(document.getElementById('expDate').value);
  } catch (err) {
    showNotification('Delete failed: ' + err.message, 'danger');
  }
}

function toggleExpenseType(button) {
  const card = button.closest('.expense-category-type-card');
  const expanded = card.classList.toggle('is-collapsed') === false;
  button.setAttribute('aria-expanded', String(expanded));
}

function updateTotal() {
  let total = 0;
  const typeTotals = {};
  document.querySelectorAll('.cat-amount').forEach(inp => {
    const amount = parseFloat(inp.value) || 0;
    total += amount;
    if (inp.dataset.type) typeTotals[inp.dataset.type] = (typeTotals[inp.dataset.type] || 0) + amount;
  });
  document.querySelectorAll('[data-type-total]').forEach(el => { el.textContent = formatCurrency(typeTotals[el.dataset.typeTotal] || 0); });
  const overall = document.getElementById('categoryTypeTotals');
  if (overall) overall.innerHTML = '<span class="expense-overall-label">All types</span><strong>' + formatCurrency(total) + '</strong>';
  document.getElementById('expRunningTotal').textContent = formatCurrency(total);
}

/* ---- Save ---- */

async function save() {
  const date = document.getElementById('expDate').value;
  if (!date) { showNotification('Please select a date.', 'warning'); return; }
  if (date > today) { showNotification('Future dates cannot be saved.', 'warning'); return; }
  if (allExpenses.some(e => e.date === date && (e.approvalStatus === 'Approved' || e.approvalStatus === 'AutoApproved'))) {
    showNotification('Approved dates cannot be edited.', 'warning');
    loadDateIntoForm(date);
    return;
  }

  const entries = [];
  document.querySelectorAll('.cat-amount:not([readonly])').forEach(inp => {
    const amount = parseFloat(inp.value);
    const onSpot = inp.dataset.onspot === 'true';
    const name = onSpot ? inp.closest('.onspot-row')?.querySelector('.onspot-name')?.value.trim() : inp.dataset.category;
    if (amount > 0 && name) entries.push({ category: name, amount, typeId: inp.dataset.type, onSpot });
  });

  if (!entries.length) { showNotification('Enter at least one amount greater than 0.', 'warning'); return; }

  const remarks = document.getElementById('expRemarks').value.trim();
  const btn = document.getElementById('btnSaveExpense');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';

  try {
    await api('POST', '/expenses/bulk', { date, entries, remarks });
    const msg = 'Expense submitted for approval.';
    showNotification(msg);
    allExpenses = await api('GET', '/expenses');
    loadDateIntoForm(date);
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Expense';
  }
}

/* ---- Approval actions (super user only) ---- */

async function approveDate(date) {
  try {
    await api('POST', '/expenses/approve/' + date);
    showNotification('Approved successfully.');
    allExpenses = await api('GET', '/expenses');
    renderSummary();
  } catch (err) {
    showNotification('Approve failed: ' + err.message, 'danger');
  }
}

function openRejectModal(date) {
  pendingRejectDate = date;
  document.getElementById('rejectReason').value = '';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('rejectModal')).show();
}

async function confirmReject() {
  const reason = document.getElementById('rejectReason').value.trim();
  if (!reason) { showNotification('Please enter a rejection reason.', 'warning'); return; }
  try {
    await api('POST', '/expenses/reject/' + pendingRejectDate, { reason });
    bootstrap.Modal.getInstance(document.getElementById('rejectModal')).hide();
    showNotification('Expense rejected. Cashier will be notified on their next login.');
    allExpenses = await api('GET', '/expenses');
    renderSummary();
  } catch (err) {
    showNotification('Reject failed: ' + err.message, 'danger');
  }
}

/* ---- Chart ---- */
let expChart = null;
const CHART_COLORS = [
  '#3b82f6','#f59e0b','#10b981','#ef4444','#8b5cf6',
  '#06b6d4','#f97316','#84cc16','#ec4899','#14b8a6',
  '#a855f7','#fb923c','#22c55e','#e11d48','#0ea5e9'
];

function buildCatFilterChips() {
  const container = document.getElementById('catFilterChips');
  const active = allCategories.filter(c => c.status === 'Active').sort((a,b) => a.sortOrder - b.sortOrder);
  container.innerHTML = active.map(c =>
    `<button type="button" class="btn btn-sm btn-outline-secondary cat-chip"
      data-cat="${c.name}" onclick="toggleChip(this)">${c.name}</button>`
  ).join('');
}

function toggleChip(el) {
  el.classList.toggle('active-chip');
  el.classList.toggle('btn-primary');
  el.classList.toggle('btn-outline-secondary');
}

function getSelectedCats() {
  return [...document.querySelectorAll('.cat-chip.active-chip')].map(c => c.dataset.cat);
}

/* ---- Summary table ---- */

function renderSummary() {
  const from = document.getElementById('fDateFrom').value;
  const to   = document.getElementById('fDateTo').value;
  const selectedCats = getSelectedCats();

  const filtered = allExpenses.filter(e => {
    if (from && e.date < from) return false;
    if (to   && e.date > to)   return false;
    if (selectedCats.length > 0 && !selectedCats.includes(e.category)) return false;
    return true;
  });

  const byDate = {};
  filtered.forEach(e => {
    if (!byDate[e.date]) byDate[e.date] = { cats: {}, status: e.approvalStatus, submittedBy: e.submittedBy };
    const k = e.category || 'Other';
    byDate[e.date].cats[k] = (byDate[e.date].cats[k] || 0) + (parseFloat(e.amount) || 0);
    // Pending takes priority in status display
    if (e.approvalStatus === 'Pending') byDate[e.date].status = 'Pending';
    if (e.approvalStatus === 'Rejected') byDate[e.date].status = 'Rejected';
  });

  const tbody = document.getElementById('expBody');
  const tfoot = document.getElementById('expFoot');
  const dates = Object.keys(byDate).sort();

  if (!dates.length) {
    tbody.innerHTML = emptyRow(5, 'No expenses found.');
    tfoot.innerHTML = '';
    destroyChart();
    return;
  }

  const allCats = [...new Set(filtered.map(e => e.category || 'Other'))].sort();

  if (document.getElementById('chartSection').style.display !== 'none') {
    renderChart(dates, byDate, allCats);
  } else {
    destroyChart();
  }

  let grandTotal = 0;
  tbody.innerHTML = [...dates].reverse().map(date => {
    const entry = byDate[date];
    const dayTotal = Object.values(entry.cats).reduce((s, v) => s + v, 0);
    grandTotal += dayTotal;
    const catBadges = Object.entries(entry.cats)
      .map(([k, v]) => `<span class="badge bg-light text-dark border me-1 mb-1">${k}: ${formatCurrency(v)}</span>`)
      .join('');
    const statusBadgeHtml = approvalStatusBadge(entry.status);
    const dateStatusClass = entry.status === 'Rejected' ? 'expense-date-rejected' :
      (entry.status === 'Pending' ? 'expense-date-pending' : 'expense-date-approved');

    let actionBtns = `<button class="btn btn-sm btn-outline-secondary btn-action me-1"
      onclick="editFromReport('${date}')" title="Edit"><i class="bi bi-pencil"></i></button>`;
    if (isSuperUser() || canAccess('expenses','approve')) {
      actionBtns +=
        `<button class="btn btn-sm btn-success btn-action me-1" onclick="approveDate('${date}')" title="Approve">
          <i class="bi bi-check-lg"></i></button>` +
        `<button class="btn btn-sm btn-danger btn-action" onclick="openRejectModal('${date}')" title="Reject">
          <i class="bi bi-x-lg"></i></button>`;
    }

    return `<tr>
      <td data-label="Date" class="fw-semibold text-nowrap small ${dateStatusClass}"><span>${formatDate(date)}</span></td>
      <td data-label="Categories"><div class="d-flex flex-wrap">${catBadges}</div>
        ${entry.submittedBy ? '<div class="text-muted" style="font-size:.75rem">by ' + entry.submittedBy + '</div>' : ''}
      </td>
      <td data-label="Total" class="text-end fw-semibold text-nowrap">${formatCurrency(dayTotal)}</td>
      <td data-label="Status">${statusBadgeHtml}</td>
      <td data-label="Actions" class="text-center text-nowrap">${actionBtns}</td>
    </tr>`;
  }).join('');

  tfoot.innerHTML =
    `<tr style="background:#f0f9ff;border-top:2px solid #bae6fd;">
      <td colspan="3" class="fw-bold text-end text-primary">Grand Total</td>
      <td colspan="2" class="fw-bold text-end text-primary">${formatCurrency(grandTotal)}</td>
    </tr>`;
}

function approvalStatusBadge(status) {
  const map = {
    Approved:     'bg-success-subtle text-success border border-success-subtle',
    AutoApproved: 'bg-success-subtle text-success border border-success-subtle',
    Pending:      'bg-warning-subtle text-warning border border-warning-subtle',
    Rejected:     'bg-danger-subtle text-danger border border-danger-subtle'
  };
  const cls = map[status] || 'bg-secondary-subtle text-secondary';
  return `<span class="badge ${cls}" style="font-size:.7rem">${status}</span>`;
}

function renderChart(dates, byDate, allCats) {
  const ctx = document.getElementById('expenseChart').getContext('2d');
  destroyChart();
  const datasets = allCats.map((cat, i) => ({
    label: cat,
    data: dates.map(d => byDate[d].cats[cat] || 0),
    borderColor: CHART_COLORS[i % CHART_COLORS.length],
    backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '22',
    tension: 0.35, pointRadius: 4, pointHoverRadius: 6, fill: false, borderWidth: 2
  }));
  expChart = new Chart(ctx, {
    type: 'line',
    data: { labels: dates.map(d => formatDate(d)), datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ' ' + c.dataset.label + ': ' + formatCurrency(c.parsed.y) } }
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => '₹' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v) } },
        x: { ticks: { font: { size: 11 } } }
      }
    }
  });
}

function destroyChart() {
  if (expChart) { expChart.destroy(); expChart = null; }
}

function editFromReport(date) {
  bootstrap.Modal.getInstance(document.getElementById('reportModal')).hide();
  document.getElementById('expDate').value = date;
  loadDateIntoForm(date);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
