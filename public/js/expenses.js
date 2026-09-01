/* expenses.js */

let allExpenses = [];
let allCategories = [];
let allCategoryTypes = [];
let pendingRejectDate = null;
let onSpotEntriesForDate = [];
let datePickerMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let expenseEmployees = [];
let autoSaveTimer = null;
let autoSaveInFlight = false;
let autoSavePending = false;
let expenseAutoSaveEnabled = true;

function normalizeWorkflow(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'occasional' || normalized === 'occasional_excluded') return 'Occasional';
  if (normalized === 'daily non cash' || normalized === 'daily_non_cash' || normalized === 'dailycashexcluded') return 'Daily Non Cash';
  return 'Daily Cash';
}

function getLocalDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const today = getLocalDateKey();

function getSelectedExpenseDate() {
  const value = document.getElementById('expDate')?.value;
  return value && value <= today ? value : today;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Auth guard
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('expenses')) { window.location.href = '/index.html'; return; }
  document.getElementById('btnEmployeeExpense').style.display = canAccess('expenses', 'add') ? '' : 'none';
  document.getElementById('btnEmployeeExpense').addEventListener('click', openEmployeeExpenseModal);
  document.getElementById('btnSaveEmployeeExpense').addEventListener('click', saveEmployeeExpense);
  document.getElementById('btnOccasionalExpense').style.display = canAccess('expenses', 'add') ? '' : 'none';
  document.getElementById('btnOccasionalExpense').addEventListener('click', openOccasionalExpenseModal);
  document.getElementById('occasionalExpenseType').addEventListener('change', populateOccasionalCategories);
  document.getElementById('btnSaveOccasionalExpense').addEventListener('click', saveOccasionalExpense);

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
  const saveButton = document.getElementById('btnSaveExpense');
  await configReady;
  expenseAutoSaveEnabled = autoSaveEnabled;
  if (saveButton) saveButton.style.display = expenseAutoSaveEnabled ? 'none' : '';
  setAutoSaveStatus(expenseAutoSaveEnabled ? 'Auto-save enabled' : 'Manual save enabled', expenseAutoSaveEnabled ? 'muted' : 'primary', expenseAutoSaveEnabled ? 'bi-cloud-check' : 'bi-save');
  document.getElementById('expRemarks').addEventListener('blur', () => {
    if (expenseAutoSaveEnabled) scheduleAutoSave();
  });
  document.getElementById('categoryInputs').addEventListener('focusout', event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches('.cat-amount:not([readonly]):not([disabled]), .onspot-name:not([readonly]):not([disabled])')) {
      if (isIncompleteOnSpotRow(target.closest('.onspot-row'))) return;
      if (expenseAutoSaveEnabled) scheduleAutoSave();
    }
  });

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

  document.getElementById('btnToggleDailyCash').addEventListener('click', () => {
    const section = document.getElementById('dailyCashReportSection');
    const btn = document.getElementById('btnToggleDailyCash');
    const visible = section.style.display !== 'none';
    section.style.display = visible ? 'none' : '';
    btn.classList.toggle('btn-outline-secondary', visible);
    btn.classList.toggle('btn-primary', !visible);
    if (!visible) renderSummary();
  });

  document.getElementById('btnToggleOccasional').addEventListener('click', () => {
    const section = document.getElementById('occasionalReportSection');
    const btn = document.getElementById('btnToggleOccasional');
    const visible = section.style.display !== 'none';
    section.style.display = visible ? 'none' : '';
    btn.classList.toggle('btn-outline-secondary', visible);
    btn.classList.toggle('btn-primary', !visible);
    buildCatFilterChips();
    renderSummary();
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
    renderOccasionalExpenses();
    if (!allCategoryTypes.some(type => type.status === 'Active' && normalizeWorkflow(type.workflow) === 'Occasional')) {
      document.getElementById('btnOccasionalExpense').style.display = 'none';
    }
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
    .filter(type => type.status === 'Active' && normalizeWorkflow(type.workflow) !== 'Occasional')
    .map(type => `<option value="${type.id}">${escapeHtml(type.name)}</option>`).join('');
  const form = document.getElementById('employeeExpenseForm');
  form.reset();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('employeeExpenseModal')).show();
}

function openOccasionalExpenseModal() {
  const form = document.getElementById('occasionalExpenseForm');
  form.reset();
  const selectedDate = getSelectedExpenseDate();
  document.getElementById('occasionalExpenseDate').value = selectedDate;
  document.getElementById('occasionalExpenseDate').max = today;
  const typeSelect = document.getElementById('occasionalExpenseType');
  typeSelect.innerHTML = '<option value="">— Select Expense Type —</option>' + allCategoryTypes
    .filter(type => type.status === 'Active' && normalizeWorkflow(type.workflow) === 'Occasional')
    .map(type => `<option value="${type.id}">${escapeHtml(type.displayText || type.name)}</option>`).join('');
  populateOccasionalCategories();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('occasionalExpenseModal')).show();
}

function populateOccasionalCategories() {
  const typeId = document.getElementById('occasionalExpenseType').value;
  const categorySelect = document.getElementById('occasionalExpenseCategory');
  categorySelect.innerHTML = '<option value="">— Select Category —</option>' + allCategories
    .filter(category => category.status === 'Active' && category.typeId === typeId)
    .sort((first, second) => first.sortOrder - second.sortOrder)
    .map(category => `<option value="${escapeHtml(category.name)}">${escapeHtml(category.name)}</option>`).join('');
}

async function saveOccasionalExpense() {
  const form = document.getElementById('occasionalExpenseForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const button = document.getElementById('btnSaveOccasionalExpense');
  button.disabled = true;
  try {
    await api('POST', '/expenses/occasional', {
      date: getSelectedExpenseDate(),
      typeId: document.getElementById('occasionalExpenseType').value,
      category: document.getElementById('occasionalExpenseCategory').value,
      amount: parseFloat(document.getElementById('occasionalExpenseAmount').value),
      remarks: document.getElementById('occasionalExpenseRemarks').value.trim()
    });
    bootstrap.Modal.getInstance(document.getElementById('occasionalExpenseModal')).hide();
    showNotification('Occasional expenses saved.');
    allExpenses = await api('GET', '/expenses');
    renderOccasionalExpenses();
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'danger');
  } finally {
    button.disabled = false;
  }
}

function isIncompleteOnSpotRow(row) {
  if (!row) return false;
  const name = row.querySelector('.onspot-name')?.value.trim() || '';
  const amount = parseFloat(row.querySelector('.cat-amount')?.value);
  return !name || !(amount > 0);
}

// Rows still being typed are not persisted yet, so they must survive the form rebuild after a save.
function captureFormUiState() {
  return {
    expandedTypes: [...document.querySelectorAll('.expense-category-type-card:not(.is-collapsed)')]
      .map(card => card.dataset.typeCard).filter(Boolean),
    pendingOnSpot: [...document.querySelectorAll('.onspot-row')]
      .filter(isIncompleteOnSpotRow)
      .map(row => ({
        type: row.querySelector('.onspot-name')?.dataset.type || '',
        name: row.querySelector('.onspot-name')?.value || '',
        amount: row.querySelector('.cat-amount')?.value || ''
      }))
  };
}

function restoreFormUiState(state) {
  if (!state) return;
  state.expandedTypes.forEach(typeId => {
    const card = document.querySelector(`[data-type-card="${typeId}"]`);
    if (!card) return;
    card.classList.remove('is-collapsed');
    card.querySelector('.expense-category-type-header')?.setAttribute('aria-expanded', 'true');
  });
  state.pendingOnSpot.forEach(item => {
    const card = document.querySelector(`[data-type-card="${item.type}"]`);
    const actions = card?.querySelector('.onspot-action-row');
    if (!actions) return;
    const row = document.createElement('div');
    row.className = 'expense-category-row onspot-row d-flex align-items-center gap-3 py-2';
    row.innerHTML = '<input type="text" class="form-control onspot-name flex-grow-1" data-type="' + item.type + '" placeholder="On-spot category" value="' + escapeHtml(item.name) + '">' +
      '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span><input type="number" class="form-control cat-amount" data-category="" data-type="' + item.type + '" data-onspot="true" min="0" step="0.01" placeholder="0" value="' + escapeHtml(item.amount) + '" oninput="updateTotal()"></div>';
    actions.parentNode.insertBefore(row, actions);
  });
  updateTotal();
}

function scheduleAutoSave() {
  if (!expenseAutoSaveEnabled) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(runAutoSave, 180);
}

function setAutoSaveStatus(text, tone = 'muted', icon = 'bi-cloud-check') {
  const status = document.getElementById('autoSaveStatus');
  if (!status) return;
  status.classList.remove('text-muted', 'text-primary', 'text-danger', 'text-success');
  status.classList.add(`text-${tone}`);
  status.innerHTML = `<i class="bi ${icon} me-1"></i>${text}`;
}

async function runAutoSave() {
  if (autoSaveInFlight) {
    autoSavePending = true;
    return;
  }
  autoSaveInFlight = true;
  setAutoSaveStatus('Saving changes…', 'primary', 'bi-cloud-upload');
  try {
    await save({ silent: true, auto: true });
    setAutoSaveStatus('All changes saved', 'success', 'bi-cloud-check');
  } finally {
    autoSaveInFlight = false;
    if (autoSavePending) {
      autoSavePending = false;
      scheduleAutoSave();
    }
  }
}

function renderOccasionalExpenses() {
  const body = document.getElementById('occasionalExpenseBody');
  if (!body) return;
  const selectedDate = getSelectedExpenseDate();
  const dateLabel = document.getElementById('occasionalExpensesDateLabel');
  if (dateLabel) dateLabel.textContent = `— ${formatDate(selectedDate)}`;
  const typeNames = new Map(allCategoryTypes.map(type => [type.id, type.displayText || type.name]));
  const entries = allExpenses.filter(expense => expense.mode === 'Occasional' && expense.date === selectedDate);
  const occasionalTotal = entries.reduce((sum, expense) => sum + (parseFloat(expense.amount) || 0), 0);
  const occasionalTotalEl = document.getElementById('occasionalExpensesTotal');
  if (occasionalTotalEl) occasionalTotalEl.textContent = formatCurrency(occasionalTotal);
  const canDelete = canAccess('expenses', 'add');
  body.innerHTML = entries.length ? entries.map(expense => `<tr>
    <td data-label="Date">${formatDate(expense.date)}</td><td data-label="Category" class="fw-semibold">${escapeHtml(expense.category)}</td><td data-label="Type">${escapeHtml(typeNames.get(expense.typeId) || 'Unknown')}</td><td data-label="Remarks" class="text-muted">${escapeHtml(expense.description || '—')}</td><td data-label="Amount" class="text-end fw-semibold">${formatCurrency(expense.amount)}</td><td data-label="Status">${approvalStatusBadge(expense.approvalStatus)}</td><td data-label="Actions" class="text-center">${canDelete && expense.approvalStatus !== 'Approved' && expense.approvalStatus !== 'AutoApproved' ? `<button type="button" class="btn btn-sm btn-outline-danger btn-action" title="Delete occasional expense" onclick="deleteOccasionalExpense('${expense.id}')"><i class="bi bi-trash"></i></button>` : ''}</td>
  </tr>`).join('') : emptyRow(7, 'No occasional expenses recorded for this date.');
}

async function deleteOccasionalExpense(id) {
  if (!id || !confirm('Delete this occasional expense?')) return;
  try {
    await api('DELETE', '/expenses/' + encodeURIComponent(id));
    showNotification('Occasional expense deleted.');
    allExpenses = await api('GET', '/expenses');
    renderOccasionalExpenses();
    loadDateIntoForm(document.getElementById('expDate').value);
  } catch (err) {
    showNotification('Delete failed: ' + err.message, 'danger');
  }
}

function captureExpenseDraft() {
  return {
    remarks: document.getElementById('expRemarks')?.value || '',
    rows: [...document.querySelectorAll('.cat-amount:not([disabled])')].map(input => {
      const row = input.closest('.expense-category-row');
      const onSpot = input.dataset.onspot === 'true';
      return {
        onSpot,
        type: input.dataset.type || row?.querySelector('.onspot-name')?.dataset.type || '',
        category: onSpot ? (row?.querySelector('.onspot-name')?.value.trim() || '') : (input.dataset.category || ''),
        amount: input.value || ''
      };
    }).filter(item => item.category || item.amount)
  };
}

function restoreExpenseDraft(draft) {
  if (!draft) return;
  const remarks = document.getElementById('expRemarks');
  if (remarks) remarks.value = draft.remarks || '';
  (draft.rows || []).forEach(item => {
    if (item.onSpot) {
      let row = [...document.querySelectorAll('.onspot-row')].find(candidate =>
        candidate.querySelector('.onspot-name')?.dataset.type === item.type &&
        candidate.querySelector('.onspot-name')?.value.trim() === item.category
      );
      if (!row) {
        const card = document.querySelector(`[data-type-card="${item.type}"]`);
        const content = card?.querySelector('.expense-category-type-content');
        const actions = card?.querySelector('.onspot-action-row');
        if (content && actions) {
          row = document.createElement('div');
          row.className = 'expense-category-row onspot-row d-flex align-items-center gap-3 py-2';
          row.innerHTML = '<input type="text" class="form-control onspot-name flex-grow-1" data-type="' + item.type + '" placeholder="On-spot category">' +
            '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span><input type="number" class="form-control cat-amount" data-category="" data-type="' + item.type + '" data-onspot="true" min="0" step="0.01" placeholder="0" oninput="updateTotal()"></div>';
          content.insertBefore(row, actions);
        }
      }
      if (row) {
        const nameInput = row.querySelector('.onspot-name');
        const amountInput = row.querySelector('.cat-amount');
        if (nameInput) nameInput.value = item.category;
        if (amountInput) amountInput.value = item.amount;
      }
      return;
    }
    const input = [...document.querySelectorAll('.cat-amount[data-onspot="false"]')]
      .find(candidate => candidate.dataset.type === item.type && candidate.dataset.category === item.category);
    if (input) input.value = item.amount;
  });
  updateTotal();
}

async function saveEmployeeExpense() {
  const form = document.getElementById('employeeExpenseForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const employee = expenseEmployees.find(item => item.id === document.getElementById('employeeExpenseEmployee').value);
  const button = document.getElementById('btnSaveEmployeeExpense');
  button.disabled = true;
  const draft = captureExpenseDraft();
  try {
    await api('POST', '/payments', {
      employeeId: employee.id,
      employeeName: employee.name,
      paymentDate: document.getElementById('expDate').value,
      amount: parseFloat(document.getElementById('employeeExpenseAmount').value),
      remarks: document.getElementById('employeeExpenseRemarks').value.trim(),
      addAsExpense: true,
      expenseTypeId: document.getElementById('employeeExpenseType').value
    });
    bootstrap.Modal.getInstance(document.getElementById('employeeExpenseModal')).hide();
    showNotification('Employee payment added as an expense.');
    allExpenses = await api('GET', '/expenses');
    loadDateIntoForm(document.getElementById('expDate').value);
    restoreExpenseDraft(draft);
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
  onSpotEntriesForDate = allExpenses.filter(e => e.mode !== 'Occasional' && e.date === date && e.onSpot && !e.employeeId);
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

  renderOccasionalExpenses();

  const remarkRow = allExpenses.find(e => e.mode !== 'Occasional' && e.date === date && e.description);
  document.getElementById('expRemarks').value = remarkRow ? remarkRow.description : '';

  // Check if date is approved
  const approvedRow = allExpenses.find(e => e.mode !== 'Occasional' && e.date === date && (e.approvalStatus === 'Approved' || e.approvalStatus === 'AutoApproved'));
  const isApproved = !!approvedRow;

  // Show rejection notice if cashier sees a rejected date
  const rejectedRow = allExpenses.find(e => e.mode !== 'Occasional' && e.date === date && e.approvalStatus === 'Rejected');
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
  const statuses = allExpenses.filter(expense => expense.mode !== 'Occasional' && expense.date === date).map(expense => expense.approvalStatus);
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
  allExpenses.filter(e => e.mode !== 'Occasional' && e.date === date).forEach(e => {
    if (e.category && !e.onSpot) map[e.category] = (map[e.category] || 0) + (parseFloat(e.amount) || 0);
  });
  return map;
}

/* ---- Category inputs ---- */

function buildCategoryInputs(existingMap, isReadOnly) {
  existingMap = existingMap || {};
  const typeById = new Map(allCategoryTypes.map(t => [t.id, t]));
  const active = allCategories
    .filter(c => c.status === 'Active' && normalizeWorkflow(typeById.get(c.typeId)?.workflow || 'Daily Cash') !== 'Occasional')
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const container = document.getElementById('categoryInputs');

  if (!active.length && !Object.keys(existingMap).length && !onSpotEntriesForDate.length) {
    container.innerHTML = '<div class="text-center text-muted py-3">No active categories. <a href="/categories.html">Manage</a></div>';
    return;
  }

  const readonlyAttr = isReadOnly ? ' readonly disabled style="font-size:1rem;background:#f8f9fa"' : ' style="font-size:1rem"';
  const legacyType = allCategoryTypes.find(t => t.name === 'General') || allCategoryTypes.find(t => t.sortOrder === 1) || allCategoryTypes[0] || { id: '', name: 'General', sortOrder: 0 };
  const grouped = new Map();
  active.forEach(c => {
    const type = typeById.get(c.typeId) || legacyType;
    if (!grouped.has(type.id)) grouped.set(type.id, { type, categories: [] });
    grouped.get(type.id).categories.push(c);
  });
  allExpenses.filter(e => e.mode !== 'Occasional' && e.date === document.getElementById('expDate').value && e.employeeId && !e.onSpot).forEach(entry => {
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
  const renderCards = groups => groups.map(({ type, categories, onSpotEntries = [], salaryEntries = [] }) => {
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

  const orderedGroups = [...grouped.values()].sort((a, b) => a.type.sortOrder - b.type.sortOrder);
  const cashGroups = orderedGroups.filter(group => normalizeWorkflow(group.type.workflow || 'Daily Cash') === 'Daily Cash');
  const nonCashGroups = orderedGroups.filter(group => normalizeWorkflow(group.type.workflow || 'Daily Cash') === 'Daily Non Cash');
  const cashCards = renderCards(cashGroups);
  const nonCashCards = renderCards(nonCashGroups);
  const sectionMarkup =
    (cashCards ? '<section class="mb-3"><div class="d-flex align-items-center justify-content-between mb-2"><div class="small fw-semibold text-muted">Against Daily Cash Sale</div><div class="small fw-semibold text-primary" id="dailyCashSectionTotal">₹0</div></div>' + cashCards + '</section>' : '') +
    (nonCashCards ? '<section class="mb-2"><div class="small fw-semibold text-muted mb-2">Not Against Daily Cash Sale</div>' + nonCashCards + '</section>' : '');

  // Show read-only entries for categories not in the active list (e.g. employee salary payments)
  const salaryNames = new Set(allExpenses.filter(e => e.mode !== 'Occasional' && e.date === document.getElementById('expDate').value && e.employeeId).map(e => e.category));
  const extraItems = Object.keys(existingMap)
    .filter(k => !active.some(c => c.name === k) && !salaryNames.has(k) && existingMap[k] > 0)
    .map(k => {
      return '<div class="expense-category-row d-flex align-items-center gap-3 py-2 bg-light rounded px-2">' +
        '<span class="fw-medium flex-grow-1"><i class="bi bi-lock me-1 text-muted"></i>' + k + '</span>' +
        '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span>' +
        '<input type="number" class="form-control cat-amount" data-category="' + k + '" value="' + existingMap[k] + '" readonly disabled></div></div>';
    }).join('');

  container.innerHTML = sectionMarkup + (extraItems ? '<section class="expense-category-type-card expense-category-type-locked is-collapsed"><button type="button" class="expense-category-type-header" aria-expanded="false" onclick="toggleExpenseType(this)"><span class="expense-category-type-title"><i class="bi bi-chevron-right expense-type-chevron"></i><span>Other recorded entries</span></span></button><div class="expense-category-type-content">' + extraItems + '</div></section>' : '');
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
    renderOccasionalExpenses();
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
    renderOccasionalExpenses();
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
  const typeTotals = {};
  document.querySelectorAll('.cat-amount').forEach(inp => {
    const amount = parseFloat(inp.value) || 0;
    if (inp.dataset.type) typeTotals[inp.dataset.type] = (typeTotals[inp.dataset.type] || 0) + amount;
  });
  document.querySelectorAll('[data-type-total]').forEach(el => { el.textContent = formatCurrency(typeTotals[el.dataset.typeTotal] || 0); });
  const workflowByTypeId = new Map(allCategoryTypes.map(type => [type.id, normalizeWorkflow(type.workflow || 'Daily Cash')]));
  const dailyCashTotal = Object.entries(typeTotals).reduce((sum, [typeId, amount]) =>
    sum + (workflowByTypeId.get(typeId) === 'Daily Cash' ? amount : 0), 0);
  const dailyCashTotalEl = document.getElementById('dailyCashSectionTotal');
  if (dailyCashTotalEl) dailyCashTotalEl.textContent = formatCurrency(dailyCashTotal);
}

/* ---- Save ---- */

async function save(options = {}) {
  const silent = !!options.silent;
  const date = document.getElementById('expDate').value;
  if (!date) { if (!silent) showNotification('Please select a date.', 'warning'); return; }
  if (date > today) { if (!silent) showNotification('Future dates cannot be saved.', 'warning'); return; }
  if (allExpenses.some(e => e.mode !== 'Occasional' && e.date === date && (e.approvalStatus === 'Approved' || e.approvalStatus === 'AutoApproved'))) {
    if (!silent) showNotification('Approved dates cannot be edited.', 'warning');
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

  if (!entries.length) { if (!silent) showNotification('Enter at least one amount greater than 0.', 'warning'); return; }

  const remarks = document.getElementById('expRemarks').value.trim();
  const uiState = captureFormUiState();
  const btn = document.getElementById('btnSaveExpense');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';

  try {
    const saved = await api('POST', '/expenses/bulk', { date, entries, remarks });
    if (!silent) {
      const msg = 'Expense submitted for approval.';
      showNotification(msg);
    }
    const savedEntries = Array.isArray(saved) ? saved : (saved?.data || []);
    allExpenses = allExpenses
      .filter(expense => expense.date !== date || expense.employeeId || expense.mode === 'Occasional')
      .concat(savedEntries);
    // Rebuilding the form mid-typing would discard values entered while the save was in flight.
    if (options.auto) {
      if (document.getElementById('expDate').value === date) {
        updateDateStatusColor(date);
        renderExpenseDatePicker();
        updateTotal();
      }
    } else {
      loadDateIntoForm(date);
      restoreFormUiState(uiState);
    }
  } catch (err) {
    if (silent) setAutoSaveStatus('Auto-save failed. Retry by editing again.', 'danger', 'bi-cloud-slash');
    if (!silent) showNotification('Save failed: ' + err.message, 'danger');
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
  const selected = getSelectedCats();
  const showOccasional = isReportSectionVisible('occasionalReportSection');
  const types = allCategoryTypes
    .filter(type => type.status === 'Active' && (showOccasional || normalizeWorkflow(type.workflow) !== 'Occasional'))
    .sort((first, second) => (first.sortOrder || 0) - (second.sortOrder || 0));

  const groups = types.map(type => {
    const categories = allCategories
      .filter(category => category.status === 'Active' && category.typeId === type.id)
      .sort((first, second) => first.sortOrder - second.sortOrder);
    if (!categories.length) return '';
    return `<div class="d-flex align-items-center gap-1 flex-wrap w-100">
      <span class="text-muted small fw-semibold me-1">${escapeHtml(type.displayText || type.name)}:</span>
      ${categories.map(category => `<button type="button" class="btn btn-sm btn-outline-secondary cat-chip"
        data-cat="${escapeHtml(category.name)}" onclick="toggleChip(this)">${escapeHtml(category.name)}</button>`).join('')}
    </div>`;
  }).join('');

  container.innerHTML = groups || '<span class="text-muted small">No categories</span>';
  container.querySelectorAll('.cat-chip').forEach(chip => {
    if (selected.includes(chip.dataset.cat)) toggleChip(chip);
  });
}

function isReportSectionVisible(id) {
  const section = document.getElementById(id);
  return !!section && section.style.display !== 'none';
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
  const dailyVisible = isReportSectionVisible('dailyCashReportSection');
  const occasionalVisible = isReportSectionVisible('occasionalReportSection');

  const matchesFilters = expense => {
    if (from && expense.date < from) return false;
    if (to && expense.date > to) return false;
    if (selectedCats.length > 0 && !selectedCats.includes(expense.category)) return false;
    return true;
  };

  const occasionalEntries = allExpenses.filter(e => e.mode === 'Occasional' && matchesFilters(e));
  if (occasionalVisible) renderOccasionalSummary(occasionalEntries);

  const filtered = allExpenses.filter(e => e.mode !== 'Occasional' && matchesFilters(e));

  renderReportChart([
    ...(dailyVisible ? filtered : []),
    ...(occasionalVisible ? occasionalEntries : [])
  ]);

  if (!dailyVisible) return;

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
    return;
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

function renderReportChart(entries) {
  if (document.getElementById('chartSection').style.display === 'none' || !entries.length) {
    destroyChart();
    return;
  }
  const byDate = {};
  entries.forEach(expense => {
    if (!byDate[expense.date]) byDate[expense.date] = { cats: {} };
    const key = expense.category || 'Other';
    byDate[expense.date].cats[key] = (byDate[expense.date].cats[key] || 0) + (parseFloat(expense.amount) || 0);
  });
  const dates = Object.keys(byDate).sort();
  const allCats = [...new Set(entries.map(expense => expense.category || 'Other'))].sort();
  renderChart(dates, byDate, allCats);
}

function renderOccasionalSummary(entries) {
  const tbody = document.getElementById('occasionalReportBody');
  const tfoot = document.getElementById('occasionalReportFoot');
  if (!tbody) return;

  const typeNames = new Map(allCategoryTypes.map(type => [type.id, type.displayText || type.name]));
  const sorted = [...entries].sort((first, second) =>
    second.date.localeCompare(first.date) || String(first.category).localeCompare(String(second.category)));

  const totalByDate = new Map();
  sorted.forEach(expense => {
    totalByDate.set(expense.date, (totalByDate.get(expense.date) || 0) + (parseFloat(expense.amount) || 0));
  });
  const total = sorted.reduce((sum, expense) => sum + (parseFloat(expense.amount) || 0), 0);

  document.getElementById('occasionalReportSummary').textContent =
    `${formatCurrency(total)} · ${sorted.length} entr${sorted.length === 1 ? 'y' : 'ies'} · ${totalByDate.size} day${totalByDate.size === 1 ? '' : 's'}`;

  let lastDate = null;
  tbody.innerHTML = sorted.length ? sorted.map(expense => {
    const header = expense.date === lastDate ? '' : `<tr class="table-light fw-semibold">
      <td colspan="5">${formatDate(expense.date)}</td>
      <td class="text-end">${formatCurrency(totalByDate.get(expense.date))}</td></tr>`;
    lastDate = expense.date;
    return header + `<tr>
      <td data-label="Date" class="text-nowrap small">${formatDate(expense.date)}</td>
      <td data-label="Category" class="fw-semibold">${escapeHtml(expense.category)}</td>
      <td data-label="Type">${escapeHtml(typeNames.get(expense.typeId) || 'Unknown')}</td>
      <td data-label="Remarks" class="text-muted">${escapeHtml(expense.description || '—')}</td>
      <td data-label="Status">${approvalStatusBadge(expense.approvalStatus)}</td>
      <td data-label="Amount" class="text-end fw-semibold text-nowrap">${formatCurrency(expense.amount)}</td>
    </tr>`;
  }).join('') : emptyRow(6, 'No occasional expenses in this range.');

  tfoot.innerHTML = sorted.length
    ? `<tr style="background:#f0f9ff;border-top:2px solid #bae6fd;">
        <td colspan="5" class="fw-bold text-end text-primary">Occasional Total</td>
        <td class="fw-bold text-end text-primary">${formatCurrency(total)}</td>
      </tr>`
    : '';
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
