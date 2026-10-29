/* expenses.js */

let allExpenses = [];
let allCategories = [];
let allCategoryTypes = [];
let allQuantityCategories = [];
let allExpenseQuantities = [];
let allUnpaidQuantities = [];
let pendingUnpaidLinks = new Map();
let pendingRejectDate = null;
let pendingRejectMode = 'Daily';
let editingOccasionalExpenseId = null;
let onSpotEntriesForDate = [];
let datePickerMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let expenseEmployees = [];
let autoSaveTimer = null;
let autoSaveInFlight = false;
let autoSavePending = false;
let expenseAutoSaveEnabled = true;
let nextOnSpotQuantityKey = 0;
let quantityRenderTimer = null;
let pendingOnSpotNameInput = null;
let employeeExpenseDataLoaded = false;
const handpickedQuantityIds = new Map();
let quantityPickerRow = null;

function handpickKey(category, expenseId = '', rowKey = '') {
  return JSON.stringify([getSelectedExpenseDate(), category.id, expenseId || rowKey]);
}

function selectedQuantityFields(category, key, saved) {
  if (!category?.handpickQuantities) return null;
  if (!handpickedQuantityIds.has(key)) {
    handpickedQuantityIds.set(key, new Set(saved.filter(quantity => !quantity.sourceReceiptId && quantity.amount > 0).map(quantity => quantity.quantityCategoryId)));
  }
  return handpickedQuantityIds.get(key);
}

function quantityPickerButton(category, readOnly) {
  if (!category?.handpickQuantities) return '';
  return `<button type="button" class="btn btn-sm btn-outline-primary mb-2 choose-category-quantities"${readOnly ? ' disabled' : ''}>Choose quantities</button>`;
}

function openQuantityPicker(row) {
  if (!canAccess('expenses', 'add')) return;
  const groups = [...row.querySelectorAll('.configured-quantity-field')];
  quantityPickerRow = row;
  document.getElementById('quantityPickerCategory').textContent = row.dataset.pickerCategory || '';
  document.getElementById('quantityPickerSearch').value = '';
  document.getElementById('quantityPickerOptions').innerHTML = groups.map(group => {
    const input = group.querySelector('.expense-quantity, .occasional-tab-quantity');
    return `<label class="form-check py-2"><input type="checkbox" class="form-check-input quantity-picker-check" value="${escapeHtml(input.dataset.quantityCategoryId)}"${group.hidden ? '' : ' checked'}><span>${escapeHtml(input.dataset.name)} (${escapeHtml(input.dataset.unit)})</span></label>`;
  }).join('') || '<div class="text-muted">No quantities configured for this category.</div>';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('quantityPickerModal')).show();
}

function clearQuantityPickerSelection() {
  document.querySelectorAll('.quantity-picker-check').forEach(input => { input.checked = false; });
}

function applyQuantityPicker() {
  const row = quantityPickerRow;
  if (!row?.isConnected || !canAccess('expenses', 'add')) return;
  const selected = new Set([...document.querySelectorAll('.quantity-picker-check:checked')].map(input => input.value));
  handpickedQuantityIds.set(row.dataset.pickerKey, selected);
  row.querySelectorAll('.configured-quantity-field').forEach(group => {
    const input = group.querySelector('.expense-quantity, .occasional-tab-quantity');
    group.hidden = !selected.has(input.dataset.quantityCategoryId);
    if (group.hidden) {
      group.querySelectorAll?.('input[type="number"]').forEach(field => { field.value = ''; });
      if (group.dataset) delete group.dataset.calculatedField;
    }
  });
  refreshQuantityValues(row);
  updateQuantityRowSummary(row);
  bootstrap.Modal.getInstance(document.getElementById('quantityPickerModal')).hide();
  quantityPickerRow = null;
  if (row.dataset.occasionalExpenseId) {
    const button = row.querySelector('button[title="Save quantities"]');
    if (button) saveOccasionalQuantities(row.dataset.occasionalExpenseId, button);
  } else if (expenseAutoSaveEnabled) scheduleAutoSave();
}

function normalizeWorkflow(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'occasional' || normalized === 'occasional_excluded') return 'Occasional';
  if (normalized === 'daily non cash' || normalized === 'daily_non_cash' || normalized === 'dailycashexcluded') return 'Daily Non Cash';
  return 'Daily Cash';
}

/* ---- Category balance and unit prices ---- */

function categoryBalanceName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function balanceCategory(typeId, name, onSpot = false) {
  const matches = allCategories.filter(category => categoryBalanceName(category.name) === categoryBalanceName(name));
  return matches.find(category => (category.typeId || '') === (typeId || '')) ||
    (onSpot && matches.length === 1 ? matches[0] : null);
}

function categoryBalanceIdentity(item) {
  const configured = balanceCategory(item.typeId, item.category, !!item.onSpot);
  return {
    typeId: configured?.typeId || item.typeId || '',
    category: configured?.name || item.category || ''
  };
}

let categoryLedgerIndex = null;

function getCategoryLedgerIndex() {
  const sources = [allExpenses, allCategories, allExpenseQuantities, allUnpaidQuantities];
  if (categoryLedgerIndex && sources.every((source, index) => source === categoryLedgerIndex.sources[index])) return categoryLedgerIndex;
  const index = { sources, expensesById: new Map(), expenses: new Map(), receipts: new Map(), quantities: new Map(), applied: new Map(), balances: new Map() };
  const add = (map, identity, item) => {
    const key = JSON.stringify([identity.typeId, categoryBalanceName(identity.category)]);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  };
  allExpenses.forEach(expense => {
    index.expensesById.set(expense.id, expense);
    if (!expense.employeeId) add(index.expenses, categoryBalanceIdentity(expense), expense);
  });
  allExpenseQuantities.forEach(quantity => {
    if (quantity.sourceReceiptId) return;
    if (!index.quantities.has(quantity.expenseId)) index.quantities.set(quantity.expenseId, []);
    index.quantities.get(quantity.expenseId).push(quantity);
  });
  allUnpaidQuantities.forEach(receipt => {
    add(index.receipts, categoryBalanceIdentity(receipt), receipt);
    (receipt.payments || []).forEach(payment => index.applied.set(payment.expenseId, (index.applied.get(payment.expenseId) || 0) + (parseFloat(payment.amount) || 0)));
  });
  categoryLedgerIndex = index;
  return index;
}

// An expense is either an on-the-spot payment for goods received or a payment toward earlier goods, so its amount never sets a unit price.
// Balance = goods received at the entered unit prices (plus unpaid receipts) minus payments, kept from the category's first priced entry.
function categoryLedger(typeId, category, includeDraftLinks = true, reportFilter = null) {
  const target = balanceCategory(typeId, category, true);
  typeId = target?.typeId || typeId;
  const name = categoryBalanceName(target?.name || category);
  if (!name) return null;
  const index = getCategoryLedgerIndex();
  const identityKey = JSON.stringify([typeId || '', name]);
  const draftsKey = includeDraftLinks ? JSON.stringify([...pendingUnpaidLinks.values()].map(link => [link.receiptId, link.amount])) : '';
  const cacheKey = JSON.stringify([identityKey, reportFilter?.to || '', draftsKey, includeDraftLinks]);
  if (index.balances.has(cacheKey)) return index.balances.get(cacheKey);
  const configured = target || balanceCategory(typeId, category);
  const opening = parseFloat(configured?.openingBalance) || 0;
  // Pending is a closing balance: earlier dues and payments carry into the report period.
  const throughEnd = date => !!date && (!reportFilter?.to || date <= reportFilter.to);
  const receipts = (index.receipts.get(identityKey) || []).filter(item => throughEnd(item.receivedDate));
  const matchingExpenses = (index.expenses.get(identityKey) || []).filter(expense => throughEnd(expense.date));
  const expensesById = index.expensesById;
  const paymentThroughEnd = payment => {
    const date = expensesById.get(payment.expenseId)?.date || payment.paymentDate || String(payment.createdAt || '').slice(0, 10);
    return !reportFilter?.to || throughEnd(date);
  };
  const linkedNow = new Map();
  if (includeDraftLinks) pendingUnpaidLinks.forEach(link => linkedNow.set(link.receiptId, (linkedNow.get(link.receiptId) || 0) + (parseFloat(link.amount) || 0)));
  // Money already applied to a receipt is counted there, not again as a payment of the expense.
  const appliedToReceipts = index.applied;
  const ownQuantities = index.quantities;
  const entries = matchingExpenses.map(expense => {
    const own = ownQuantities.get(expense.id) || [];
    const value = own.reduce((sum, quantity) => sum + (quantity.totalAmount !== '' && quantity.totalAmount != null ? Number(quantity.totalAmount) : quantity.unitPrice > 0 ? quantity.amount * quantity.unitPrice : 0), 0);
    return {
      date: expense.date, value, priced: value > 0, hasQuantities: own.length > 0,
      payment: Math.max(0, (parseFloat(expense.amount) || 0) - (appliedToReceipts.get(expense.id) || 0))
    };
  });
  const starts = [...receipts.map(receipt => receipt.receivedDate), ...entries.filter(entry => entry.priced).map(entry => entry.date),
    ...(configured?.balanceUpdatedAt ? entries.map(entry => entry.date) : [])].filter(Boolean).sort();
  if (!starts.length && !configured?.balanceUpdatedAt && !opening) {
    index.balances.set(cacheKey, null);
    return null;
  }
  const start = starts[0] || getLocalDateKey();
  let received = 0;
  let paid = 0;
  receipts.forEach(receipt => {
    const total = receipt.totalAmount || 0;
    received += total;
    const receiptPaid = reportFilter?.to && (receipt.payments || []).length
      ? receipt.payments.filter(paymentThroughEnd).reduce((sum, payment) => sum + (parseFloat(payment.amount) || 0), 0)
      : (receipt.paidAmount || 0);
    paid += Math.min(total, receiptPaid + (linkedNow.get(receipt.id) || 0));
  });
  entries.filter(entry => entry.date >= start).forEach(entry => {
    if (entry.priced) received += entry.value;
    // Quantities saved without a price are taken as paid for on the spot.
    else if (entry.hasQuantities) received += entry.payment;
    paid += entry.payment;
  });
  const round = value => Math.round(value * 100) / 100;
  const result = { start, opening, received: round(received), paid: round(paid), balance: round(opening + received - paid) };
  index.balances.set(cacheKey, result);
  return result;
}

function balanceText(balance) {
  return Math.abs(balance) < 0.005 ? '' : `${formatCurrency(Math.abs(balance))} ${balance > 0 ? 'pending' : 'advance'}`;
}

function resetCategoryBalancesVisibility() {
  document.getElementById('categoryBalancesReportSection').hidden = true;
  const button = document.getElementById('btnToggleCategoryBalances');
  button.textContent = 'Show Pending Payments';
  button.setAttribute('aria-expanded', 'false');
}

let expenseReportLoading = false;
let reportExpenseRows = null;
let reportQuantityRows = null;

async function openExpenseReport() {
  if (!isSuperUser()) return;
  resetCategoryBalancesVisibility();
  reportExpenseRows = null;
  reportQuantityRows = null;
  document.getElementById('expenseReportResults').hidden = true;
  const status = document.getElementById('expenseReportLoadStatus');
  status.hidden = false;
  status.textContent = 'Select dates and Daily or Occasional, then click Show for Approval.';
  if (!isReportSectionVisible('dailyCashReportSection') && !isReportSectionVisible('occasionalReportSection')) {
    document.getElementById('dailyCashReportSection').style.display = '';
    const dailyButton = document.getElementById('btnToggleDailyCash');
    dailyButton.classList.add('btn-primary');
    dailyButton.classList.remove('btn-outline-secondary');
  }
  buildCatFilterChips();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('reportModal')).show();
}

async function loadSelectedExpenseReport() {
  if (!isSuperUser() || expenseReportLoading) return;
  const from = document.getElementById('fDateFrom').value;
  const to = document.getElementById('fDateTo').value;
  if (from && to && from > to) { showNotification('From date must be on or before To date.', 'warning'); return; }
  const daily = isReportSectionVisible('dailyCashReportSection');
  const occasional = isReportSectionVisible('occasionalReportSection');
  if (!daily && !occasional) {
    showNotification('Select Daily or Occasional to view expenses for approval.', 'warning');
    return;
  }
  const params = new URLSearchParams({ from, to, mode: daily && occasional ? 'All' : daily ? 'Daily' : occasional ? 'Occasional' : 'None' });
  getSelectedTypeIds().forEach(id => params.append('typeId', id));
  getSelectedCats().forEach(name => params.append('category', name));
  if (document.getElementById('reportIncludeQuantities').checked) params.set('quantities', '1');
  expenseReportLoading = true;
  const status = document.getElementById('expenseReportLoadStatus');
  status.hidden = false;
  status.textContent = 'Loading selected report…';
  try {
    const data = await api('GET', '/expenses/report?' + params);
    if (!Array.isArray(data?.expenses) || !Array.isArray(data?.quantities)) {
      throw new Error('Report endpoint is unavailable. Restart the server and refresh the page.');
    }
    reportExpenseRows = data.expenses;
    reportQuantityRows = data.quantities;
    document.getElementById('expenseReportResults').hidden = false;
    renderSummary();
    status.hidden = true;
  } catch (err) {
    const message = err.message === 'Expense not found.'
      ? 'The running server needs restarting for the new report endpoint. Restart the server and refresh the page.'
      : err.message;
    status.textContent = 'Unable to refresh report: ' + message;
    showNotification('Failed to refresh expenses: ' + err.message, 'danger');
  } finally {
    expenseReportLoading = false;
  }
}

async function toggleCategoryBalances() {
  const section = document.getElementById('categoryBalancesReportSection');
  if (!section.hidden) { resetCategoryBalancesVisibility(); return; }
  section.hidden = false;
  const button = document.getElementById('btnToggleCategoryBalances');
  button.textContent = 'Hide Pending Payments';
  button.setAttribute('aria-expanded', 'true');
  await openCategoryBalances();
}

async function openCategoryBalances() {
  if (!canAccess('expenses')) return;
  const body = document.getElementById('categoryBalancesBody');
  const totals = document.getElementById('categoryBalancesTotals');
  body.textContent = 'Loading category balances…';
  totals.textContent = '';
  try {
    const [expenses, quantities, receipts, categories] = await Promise.all([
      api('GET', '/expenses'), api('GET', '/expenses/quantities'), api('GET', '/expenses/unpaid?includeSettled=1'), api('GET', '/categories')
    ]);
    allExpenses = expenses;
    allExpenseQuantities = quantities;
    allUnpaidQuantities = receipts;
    allCategories = categories;
    renderCategoryBalances();
    refreshCategoryPendingBadges();
  } catch (err) {
    body.textContent = 'Unable to load category balances: ' + err.message;
  }
}

function renderCategoryBalances() {
  const from = document.getElementById('fDateFrom')?.value || '';
  const to = document.getElementById('fDateTo')?.value || '';
  const selectedCats = getSelectedCats();
  const selectedTypes = getSelectedTypeIds();
  const dailyVisible = isReportSectionVisible('dailyCashReportSection');
  const occasionalVisible = isReportSectionVisible('occasionalReportSection');
  const types = new Map(allCategoryTypes.map(type => [type.id, type]));
  const categories = new Map();
  [...allCategories.map(item => ({ ...item, category: item.name })), ...allExpenses.filter(item => !item.employeeId), ...allUnpaidQuantities].forEach(item => {
    const identity = categoryBalanceIdentity(item);
    if (!identity.category) return;
    if (selectedCats.length && !selectedCats.some(name => categoryBalanceName(name) === categoryBalanceName(identity.category))) return;
    if (selectedTypes.length && !selectedTypes.includes(identity.typeId)) return;
    const occasional = normalizeWorkflow(types.get(identity.typeId)?.workflow) === 'Occasional';
    if (occasional ? !occasionalVisible : !dailyVisible) return;
    categories.set(JSON.stringify([identity.typeId, categoryBalanceName(identity.category)]), identity);
  });
  const rows = [...categories.values()].map(item => ({ ...item, ledger: categoryLedger(item.typeId, item.category, false, { from, to }) }))
    .filter(item => item.ledger && item.ledger.balance > 0.004)
    .sort((a, b) => b.ledger.balance - a.ledger.balance || a.category.localeCompare(b.category));
  const total = rows.reduce((sum, item) => sum + item.ledger.balance, 0);
  document.getElementById('categoryBalancesTotals').innerHTML = `<strong>Total pending: ${escapeHtml(formatCurrency(total))}</strong>`;
  document.getElementById('categoryBalancesBody').innerHTML = rows.length
    ? `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Category</th><th class="text-end">Pending amount</th></tr></thead><tbody>${rows.map(item => `<tr><td>${escapeHtml(item.category)} <span class="text-muted small">(${escapeHtml(types.get(item.typeId)?.displayText || types.get(item.typeId)?.name || 'Unassigned type')})</span></td><td class="text-end fw-semibold">${escapeHtml(formatCurrency(item.ledger.balance))}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="text-muted text-center py-3">No pending payments for the selected filters.</div>';
}

async function saveCategoryOpeningBalance(form) {
  if (!canAccess('expenses', 'add') || !form.checkValidity()) { form.reportValidity(); return; }
  const button = form.querySelector('button');
  const status = form.querySelector('.opening-save-status');
  const amount = Number(form.elements.openingBalance.value);
  button.disabled = true;
  status.textContent = 'Saving…';
  try {
    const updated = await api('PUT', `/categories/${encodeURIComponent(form.dataset.categoryId)}/opening-balance`, { openingBalance: amount });
    allCategories = allCategories.map(category => category.id === updated.id ? { ...category, ...updated } : category);
    renderCategoryBalances();
    refreshCategoryPendingBadges();
    showNotification('Previous balance updated.');
  } catch (err) {
    status.textContent = 'Save failed: ' + err.message;
  } finally {
    button.disabled = false;
  }
}

function pendingBadgeHtml(typeId, category) {
  const ledger = categoryLedger(typeId, category);
  const text = ledger ? balanceText(ledger.balance) : '';
  if (!text) return '';
  const tone = ledger.balance > 0 ? 'bg-warning-subtle text-warning-emphasis border border-warning-subtle' : 'bg-info-subtle text-info border border-info-subtle';
  const title = `Opening ${formatCurrency(ledger.opening || 0)} + received ${formatCurrency(ledger.received)} less paid ${formatCurrency(ledger.paid)} since ${formatDate(ledger.start)}`;
  return `<span class="badge ${tone} ms-2 fw-normal" title="${escapeHtml(title)}">${text}</span>`;
}

// Slots are refreshed in place whenever expenses, quantities or receivables change.
function pendingSlotHtml(typeId, category) {
  return `<span class="category-pending-slot" data-pending-type="${escapeHtml(typeId || '')}" data-pending-category="${escapeHtml(category || '')}">${inlineCategoryBalanceHtml(typeId, category)}</span>`;
}

function inlineCategoryBalanceHtml(typeId, category) {
  const configured = balanceCategory(typeId, category, true);
  const ledger = categoryLedger(typeId, category, false);
  const balance = ledger?.balance || 0;
  const text = balanceText(balance) || `${formatCurrency(0)} pending`;
  const tone = balance < 0 ? 'text-info border-info-subtle bg-info-subtle' : 'text-warning-emphasis border-warning-subtle bg-warning-subtle';
  return configured && canAccess('expenses', 'add')
    ? `<button type="button" class="badge border ms-2 ${tone} category-balance-edit" title="Click to edit pending balance" aria-label="Edit pending balance for ${escapeHtml(category)}">${escapeHtml(text)}</button>`
    : `<span class="badge border ms-2 ${tone}">${escapeHtml(text)}</span>`;
}

function editInlineCategoryBalance(slot) {
  const ledger = categoryLedger(slot.dataset.pendingType, slot.dataset.pendingCategory, false);
  slot.innerHTML = `<span class="d-inline-flex gap-1 align-items-center ms-2"><input type="number" class="form-control form-control-sm category-balance-value" style="width:120px" step="0.01" required aria-label="Pending balance" value="${ledger?.balance || 0}"><button type="button" class="btn btn-sm btn-primary category-balance-save">Save</button><button type="button" class="btn btn-sm btn-light category-balance-cancel">Cancel</button></span><span class="category-balance-status small d-block" role="status">Negative amount = advance.</span>`;
  slot.querySelector('input').focus();
  slot.querySelector('input').select();
}

async function saveInlineCategoryBalance(slot) {
  if (!canAccess('expenses', 'add') || slot.dataset.saving === 'true') return;
  const input = slot.querySelector('input');
  if (!input.checkValidity()) { input.reportValidity(); return; }
  const desired = Number(input.value);
  const category = balanceCategory(slot.dataset.pendingType, slot.dataset.pendingCategory, true);
  if (!category) return;
  const status = slot.querySelector('.category-balance-status');
  slot.dataset.saving = 'true';
  slot.querySelectorAll('input, button').forEach(element => { element.disabled = true; });
  status.textContent = 'Saving…';
  try {
    // Adjust only the opening amount; recorded goods and payments remain unchanged.
    const ledger = categoryLedger(category.typeId, category.name, false);
    const openingBalance = Math.round(((ledger?.opening || 0) + desired - (ledger?.balance || 0)) * 100) / 100;
    const updated = await api('PUT', `/categories/${encodeURIComponent(category.id)}/opening-balance`, { openingBalance });
    allCategories = allCategories.map(item => item.id === updated.id ? { ...item, ...updated } : item);
    delete slot.dataset.saving;
    slot.innerHTML = inlineCategoryBalanceHtml(slot.dataset.pendingType, slot.dataset.pendingCategory);
    refreshCategoryPendingBadges();
    showNotification('Category pending balance updated.');
  } catch (err) {
    status.textContent = 'Save failed: ' + err.message;
    delete slot.dataset.saving;
    slot.querySelectorAll('input, button').forEach(element => { element.disabled = false; });
  }
}

function refreshCategoryPendingBadges() {
  document.querySelectorAll('.category-pending-slot').forEach(slot => {
    if (slot.querySelector?.('.category-balance-value')) return;
    slot.innerHTML = inlineCategoryBalanceHtml(slot.dataset.pendingType, slot.dataset.pendingCategory);
  });
}

function quantityPriceInputHtml(unitPrice, readOnly, totalAmount = '') {
  return `<span class="input-group-text">&#8377;/unit</span><input type="number" class="form-control expense-quantity-price" style="max-width:110px" min="0" step="0.01" placeholder="Optional price" aria-label="Price per unit" title="Enter any two values to calculate the blank field" value="${unitPrice > 0 ? unitPrice : ''}"${readOnly ? ' readonly disabled' : ''}><span class="input-group-text">Total ₹</span><input type="number" class="form-control expense-quantity-total" style="min-width:100px" min="0" step="0.01" placeholder="Total amount" aria-label="Total amount for quantity" value="${escapeHtml(totalAmount ?? '')}"${readOnly ? ' readonly disabled' : ''}>`;
}

function updateQuantityValue(group, changedInput = null) {
  const fields = {
    amount: group.querySelector('.expense-quantity, .occasional-tab-quantity, .occasional-onspot-quantity'),
    unitPrice: group.querySelector('.expense-quantity-price'),
    totalAmount: group.querySelector('.expense-quantity-total')
  };
  if (fields.totalAmount) {
    const changed = Object.keys(fields).find(key => fields[key] === changedInput);
    if (changed && group.dataset?.calculatedField === changed) delete group.dataset.calculatedField;
    const blank = Object.keys(fields).filter(key => fields[key]?.value === '');
    const missing = blank.length === 1 ? blank[0] : (!blank.length ? group.dataset?.calculatedField : null);
    const value = key => Number(fields[key]?.value);
    let calculated;
    if (missing === 'totalAmount') calculated = value('amount') * value('unitPrice');
    if (missing === 'unitPrice' && value('amount') > 0) calculated = value('totalAmount') / value('amount');
    if (missing === 'amount' && value('unitPrice') > 0) calculated = value('totalAmount') / value('unitPrice');
    if (Number.isFinite(calculated) && calculated >= 0) {
      fields[missing].value = String(Math.round((calculated + Number.EPSILON) * 100) / 100);
      if (group.dataset) group.dataset.calculatedField = missing;
    }
  }
  const quantity = parseFloat(group.querySelector('.expense-quantity, .occasional-tab-quantity, .occasional-onspot-quantity')?.value) || 0;
  const price = parseFloat(group.querySelector('.expense-quantity-price')?.value) || 0;
  const target = group.querySelector('.quantity-value');
  if (target) target.textContent = quantity > 0 && price > 0 ? `= ${formatCurrency(quantity * price)}` : '';
}

function updateQuantityRowSummary(row) {
  const target = row.querySelector('.quantity-row-summary');
  if (!target) return;
  const value = [...row.querySelectorAll('.quantity-price-group')].reduce((sum, group) => {
    if (group.hidden) return sum;
    const quantity = parseFloat(group.querySelector('.expense-quantity, .occasional-tab-quantity, .occasional-onspot-quantity')?.value) || 0;
    const total = group.querySelector('.expense-quantity-total')?.value;
    return sum + (total !== undefined && total !== '' ? Number(total) : quantity * (parseFloat(group.querySelector('.expense-quantity-price')?.value) || 0));
  }, 0);
  target.textContent = value > 0 ? `Received value ${formatCurrency(value)} · This expense ${formatCurrency(parseFloat(row.dataset.expenseAmount) || 0)}` : '';
}

function refreshQuantityValues(root = document) {
  root.querySelectorAll('.quantity-price-group').forEach(updateQuantityValue);
  root.querySelectorAll('tr[data-expense-amount]').forEach(updateQuantityRowSummary);
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
  document.addEventListener('click', event => {
    const button = event.target.closest('.choose-category-quantities');
    if (button && !button.disabled) openQuantityPicker(button.closest('tr'));
  });
  document.getElementById('btnApplyQuantityPicker')?.addEventListener('click', applyQuantityPicker);
  document.getElementById('btnClearQuantityPicker')?.addEventListener('click', clearQuantityPickerSelection);
  document.getElementById('quantityPickerSearch')?.addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('#quantityPickerOptions label').forEach(label => {
      label.hidden = !label.textContent.toLowerCase().includes(query);
    });
  });
  document.getElementById('btnToggleCategoryBalances')?.addEventListener('click', toggleCategoryBalances);
  document.addEventListener('click', event => {
    const slot = event.target.closest('.category-pending-slot');
    if (!slot) return;
    if (event.target.closest('.category-balance-edit')) editInlineCategoryBalance(slot);
    if (event.target.closest('.category-balance-save')) saveInlineCategoryBalance(slot);
    if (event.target.closest('.category-balance-cancel')) slot.innerHTML = inlineCategoryBalanceHtml(slot.dataset.pendingType, slot.dataset.pendingCategory);
  });
  document.addEventListener('keydown', event => {
    if (!event.target.matches('.category-balance-value')) return;
    const slot = event.target.closest('.category-pending-slot');
    if (event.key === 'Enter') { event.preventDefault(); saveInlineCategoryBalance(slot); }
    if (event.key === 'Escape' && slot.dataset.saving !== 'true') slot.innerHTML = inlineCategoryBalanceHtml(slot.dataset.pendingType, slot.dataset.pendingCategory);
  });
  document.getElementById('categoryBalancesBody')?.addEventListener('submit', event => {
    if (!event.target.matches('.category-opening-form')) return;
    event.preventDefault();
    saveCategoryOpeningBalance(event.target);
  });
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
  document.getElementById('categoryInputs').addEventListener('input', event => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.matches('.onspot-name')) scheduleQuantityInputsRender(event.target);
  });
  document.getElementById('expenseQuantitiesTab')?.addEventListener('shown.bs.tab', flushQuantityInputsRender);
  document.getElementById('expenseQuantitiesPane').addEventListener('focusout', () => {
    if (expenseAutoSaveEnabled) scheduleAutoSave();
  });
  ['quantityInputsBody', 'occasionalQuantityBody'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', event => {
      const group = event.target.closest?.('.quantity-price-group');
      if (group) updateQuantityValue(group, event.target);
      const row = event.target.closest?.('tr[data-expense-amount]');
      if (row) updateQuantityRowSummary(row);
    });
  });

  document.getElementById('btnReport').addEventListener('click', openExpenseReport);

  document.getElementById('btnFilter').addEventListener('click', loadSelectedExpenseReport);
  document.getElementById('btnClearFilter').addEventListener('click', () => {
    document.getElementById('fDateFrom').value = '';
    document.getElementById('fDateTo').value = '';
    document.getElementById('expenseReportResults').hidden = true;
    resetCategoryBalancesVisibility();
  });

  document.getElementById('btnToggleChart').addEventListener('click', () => {
    const section = document.getElementById('chartSection');
    const btn = document.getElementById('btnToggleChart');
    const visible = section.style.display !== 'none';
    section.style.display = visible ? 'none' : '';
    btn.classList.toggle('btn-outline-secondary', visible);
    btn.classList.toggle('btn-primary', !visible);
    if (!visible && reportExpenseRows) renderReportChart(reportExpenseRows);
  });

  document.getElementById('btnToggleDailyCash').addEventListener('click', () => {
    const section = document.getElementById('dailyCashReportSection');
    const btn = document.getElementById('btnToggleDailyCash');
    const visible = section.style.display !== 'none';
    section.style.display = visible ? 'none' : '';
    btn.classList.toggle('btn-outline-secondary', visible);
    btn.classList.toggle('btn-primary', !visible);
    buildCatFilterChips();
    loadSelectedExpenseReport();
  });

  document.getElementById('btnToggleOccasional').addEventListener('click', () => {
    const section = document.getElementById('occasionalReportSection');
    const btn = document.getElementById('btnToggleOccasional');
    const visible = section.style.display !== 'none';
    section.style.display = visible ? 'none' : '';
    btn.classList.toggle('btn-outline-secondary', visible);
    btn.classList.toggle('btn-primary', !visible);
    buildCatFilterChips();
    loadSelectedExpenseReport();
  });

  document.getElementById('btnConfirmReject').addEventListener('click', confirmReject);

  try {
    [allCategories, allCategoryTypes, allExpenses, allQuantityCategories, allExpenseQuantities, allUnpaidQuantities] = await Promise.all([
      api('GET', '/categories'),
      api('GET', '/categories/types/all'),
      api('GET', '/expenses'),
      api('GET', '/categories/quantities/all'),
      api('GET', '/expenses/quantities'),
      api('GET', '/expenses/unpaid?includeSettled=1')
    ]);
    loadDateIntoForm(today);
    renderUnpaidQuantities();
    if (!allCategoryTypes.some(type => type.status === 'Active' && normalizeWorkflow(type.workflow) === 'Occasional')) {
      document.getElementById('btnOccasionalExpense').style.display = 'none';
    }
  } catch (err) {
    showNotification('Error loading data: ' + err.message, 'danger');
  }
});

async function openEmployeeExpenseModal() {
  if (!employeeExpenseDataLoaded) {
    try {
      expenseEmployees = await api('GET', '/employees');
      employeeExpenseDataLoaded = true;
    } catch (err) {
      showNotification('Unable to load employees: ' + err.message, 'danger');
      return;
    }
  }
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
  editingOccasionalExpenseId = null;
  document.getElementById('occasionalExpenseModalTitle').textContent = 'Add Occasional Expense';
  document.getElementById('btnSaveOccasionalExpense').innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Expense';
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
    const payload = {
      date: getSelectedExpenseDate(),
      typeId: document.getElementById('occasionalExpenseType').value,
      category: document.getElementById('occasionalExpenseCategory').value,
      amount: parseFloat(document.getElementById('occasionalExpenseAmount').value),
      remarks: document.getElementById('occasionalExpenseRemarks').value.trim()
    };
    await api(editingOccasionalExpenseId ? 'PUT' : 'POST', editingOccasionalExpenseId ? `/expenses/occasional/${editingOccasionalExpenseId}` : '/expenses/occasional', payload);
    bootstrap.Modal.getInstance(document.getElementById('occasionalExpenseModal')).hide();
    showNotification(editingOccasionalExpenseId ? 'Occasional expense updated.' : 'Occasional expense saved.');
    allExpenses = await api('GET', '/expenses');
    allExpenseQuantities = await api('GET', '/expenses/quantities');
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
  const canEdit = canAccess('expenses', 'add');
  body.innerHTML = entries.length ? entries.map(expense => `<tr>
    <td data-label="Date">${formatDate(expense.date)}</td><td data-label="Category" class="fw-semibold">${escapeHtml(expense.category)}${pendingSlotHtml(expense.typeId, expense.category)}</td><td data-label="Type">${escapeHtml(typeNames.get(expense.typeId) || 'Unknown')}</td><td data-label="Remarks" class="text-muted">${escapeHtml(expense.description || '—')}</td><td data-label="Amount" class="text-end fw-semibold">${formatCurrency(expense.amount)}</td><td data-label="Status">${approvalStatusBadge(expense.approvalStatus)}${expense.approvedBy ? `<div class="text-muted" style="font-size:.75rem">approved by ${escapeHtml(expense.approvedBy)}${expense.approvedAt ? ` · ${formatDate(expense.approvedAt)}` : ''}</div>` : ''}</td><td data-label="Actions" class="text-center">${canEdit && expense.approvalStatus !== 'Approved' && expense.approvalStatus !== 'AutoApproved' ? `<button type="button" class="btn btn-sm btn-outline-secondary btn-action me-1" title="Edit occasional expense" onclick="editOccasionalExpense('${expense.id}')"><i class="bi bi-pencil"></i></button><button type="button" class="btn btn-sm btn-outline-danger btn-action" title="Delete occasional expense" onclick="deleteOccasionalExpense('${expense.id}')"><i class="bi bi-trash"></i></button>` : ''}</td>
  </tr>`).join('') : emptyRow(7, 'No occasional expenses recorded for this date.');
  renderOccasionalQuantityInputs(entries, typeNames, canEdit);
  renderReceiptsOnDate(document.getElementById('receiptsOnDateOccasional'), selectedDate, true);
  refreshCategoryPendingBadges();
}

function renderOccasionalQuantityInputs(entries, typeNames, canEdit) {
  const body = document.getElementById('occasionalQuantityBody');
  if (!body) return;
  body.innerHTML = entries.length ? entries.map(expense => {
    const category = allCategories.find(item => item.id && item.typeId === expense.typeId && item.name === expense.category);
    const definitions = category ? allQuantityCategories.filter(item => item.categoryId === category.id) : [];
    const saved = allExpenseQuantities.filter(item => item.expenseId === expense.id);
    const pickerKey = category ? handpickKey(category, expense.id) : '';
    const selected = selectedQuantityFields(category, pickerKey, saved);
    const readOnly = !canEdit || expense.approvalStatus === 'Approved' || expense.approvalStatus === 'AutoApproved';
    const fields = definitions.length ? definitions.map(quantity => {
      const amount = saved.find(item => item.quantityCategoryId === quantity.id)?.amount ?? (quantity.defaultQuantity ?? '');
      const unitPrice = saved.find(item => item.quantityCategoryId === quantity.id)?.unitPrice || 0;
      const totalAmount = saved.find(item => item.quantityCategoryId === quantity.id)?.totalAmount ?? '';
      return `<div class="input-group input-group-sm mb-2 quantity-price-group configured-quantity-field"${selected && !selected.has(quantity.id) ? ' hidden' : ''} style="max-width:760px"><span class="input-group-text" style="min-width:110px">${escapeHtml(quantity.name)}</span><input type="number" class="form-control occasional-tab-quantity" data-quantity-category-id="${quantity.id}" data-name="${escapeHtml(quantity.name)}" data-unit="${quantity.unit}" min="0" step="0.01" value="${amount}"${readOnly ? ' readonly disabled' : ''}><span class="input-group-text">${escapeHtml(quantity.unit)}</span>${quantityPriceInputHtml(unitPrice, readOnly, totalAmount)}</div>`;
    }).join('') : '';
    const custom = saved.filter(quantity => !definitions.some(item => item.id === quantity.quantityCategoryId) && !quantity.sourceReceiptId);
    const linked = saved.filter(quantity => quantity.sourceReceiptId);
    const customFields = `<div class="occasional-onspot-quantity-fields">${custom.map(quantity => onSpotQuantityInput(quantity, 'occasional-onspot-quantity')).join('')}</div>`;
    const linkedByReceipt = new Map();
    linked.forEach(quantity => {
      if (!linkedByReceipt.has(quantity.sourceReceiptId)) linkedByReceipt.set(quantity.sourceReceiptId, []);
      linkedByReceipt.get(quantity.sourceReceiptId).push(quantity);
    });
    const linkedFields = [...linkedByReceipt.entries()].map(([receiptId, group]) => {
      const unlinkBtn = !readOnly ? `<button type="button" class="btn btn-sm btn-outline-danger ms-2" title="Unlink from receivable" onclick="unlinkExpenseFromReceipt('${escapeHtml(expense.id)}', '${escapeHtml(receiptId)}')"><i class="bi bi-x-circle me-1"></i>Unlink</button>` : '';
      const items = group.map(quantity => `<div class="input-group input-group-sm mb-2" style="max-width:280px"><span class="input-group-text" style="min-width:110px">${escapeHtml(quantity.name)}</span><input type="number" class="form-control" value="${quantity.amount}" readonly disabled><span class="input-group-text">${escapeHtml(quantity.unit)}</span></div>`).join('');
      return `<div class="d-flex align-items-center mt-2 mb-1 text-muted small"><i class="bi bi-link-45deg me-1"></i>Linked from receivable${unlinkBtn}</div>${items}`;
    }).join('');
    const addButton = readOnly ? '' : '<button type="button" class="btn btn-sm btn-outline-primary" onclick="addOccasionalOnSpotQuantity(this)"><i class="bi bi-plus-lg me-1"></i>Add Quantity</button>';
    const action = !readOnly ? `<button type="button" class="btn btn-sm btn-primary" title="Save quantities" onclick="saveOccasionalQuantities('${expense.id}', this)"><i class="bi bi-check-lg"></i></button>` : '';
    return `<tr data-occasional-expense-id="${expense.id}" data-picker-key="${escapeHtml(pickerKey)}" data-picker-category="${escapeHtml(expense.category)}" data-expense-amount="${parseFloat(expense.amount) || 0}"><td data-label="Category type">${escapeHtml(typeNames.get(expense.typeId) || 'Unknown')}</td><td data-label="Category" class="fw-semibold">${escapeHtml(expense.category)}${pendingSlotHtml(expense.typeId, expense.category)}<div class="text-muted small">${formatCurrency(expense.amount)}</div></td><td data-label="Quantities">${quantityPickerButton(category, readOnly)}${fields}${customFields}${addButton}${linkedFields}<div class="quantity-row-summary small text-muted mt-1"></div></td><td data-label="Actions" class="text-center">${action}</td></tr>`;
  }).join('') : emptyRow(4, 'No occasional expenses recorded for this date.');
  refreshQuantityValues(body);
}

async function saveOccasionalQuantities(id, button) {
  const expense = allExpenses.find(item => item.id === id && item.mode === 'Occasional');
  const row = button.closest('tr');
  if (!expense || !row) return;
  button.disabled = true;
  try {
    const quantities = [...row.querySelectorAll('.occasional-tab-quantity, .occasional-onspot-quantity')].filter(input => !input.closest('.configured-quantity-field')?.hidden).map(input => {
      const custom = input.closest('.onspot-quantity');
      return {
        quantityCategoryId: input.dataset.quantityCategoryId || `onspot:${expense.typeId}:${custom?.querySelector('.expense-quantity-name').value.trim() || ''}`,
        name: custom ? custom.querySelector('.expense-quantity-name').value.trim() : input.dataset.name,
        unit: custom ? custom.querySelector('.expense-quantity-unit').value : input.dataset.unit,
        amount: input.value,
        unitPrice: input.closest('.quantity-price-group')?.querySelector('.expense-quantity-price')?.value || '',
        totalAmount: input.closest('.quantity-price-group')?.querySelector('.expense-quantity-total')?.value || ''
      };
    });
    await api('PUT', `/expenses/occasional/${encodeURIComponent(id)}`, {
      date: expense.date, typeId: expense.typeId, category: expense.category, amount: expense.amount,
      remarks: expense.description || '', quantities
    });
    allExpenses = await api('GET', '/expenses');
    allExpenseQuantities = await api('GET', '/expenses/quantities');
    renderOccasionalExpenses();
    showNotification('Occasional quantities updated.');
  } catch (err) {
    showNotification('Quantity update failed: ' + err.message, 'danger');
    button.disabled = false;
  }
}

function editOccasionalExpense(id) {
  const expense = allExpenses.find(entry => entry.id === id && entry.mode === 'Occasional');
  if (!expense) return;
  editingOccasionalExpenseId = id;
  document.getElementById('occasionalExpenseModalTitle').textContent = 'Edit Occasional Expense';
  document.getElementById('occasionalExpenseDate').value = expense.date;
  const typeSelect = document.getElementById('occasionalExpenseType');
  typeSelect.innerHTML = '<option value="">— Select Expense Type —</option>' + allCategoryTypes
    .filter(type => type.status === 'Active' && normalizeWorkflow(type.workflow) === 'Occasional')
    .map(type => `<option value="${type.id}">${escapeHtml(type.displayText || type.name)}</option>`).join('');
  typeSelect.value = expense.typeId;
  populateOccasionalCategories();
  document.getElementById('occasionalExpenseCategory').value = expense.category;
  document.getElementById('occasionalExpenseAmount').value = expense.amount;
  document.getElementById('occasionalExpenseRemarks').value = expense.description || '';
  document.getElementById('btnSaveOccasionalExpense').innerHTML = '<i class="bi bi-check-lg me-1"></i>Update Expense';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('occasionalExpenseModal')).show();
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

  const dailyRows = allExpenses.filter(e => e.mode !== 'Occasional' && e.date === date && !e.employeeId);
  const editableRows = dailyRows.filter(e => e.approvalStatus === 'Rejected' || e.approvalStatus === 'Pending');
  const editableCategories = new Set(editableRows.map(e => e.category));
  const editableTypeIds = new Set([...new Set(dailyRows.map(e => e.typeId))].filter(typeId =>
    dailyRows.filter(e => e.typeId === typeId).every(e => e.approvalStatus === 'Rejected' || e.approvalStatus === 'Pending')));
  // When a whole type is editable (e.g., rejected as missing), unlock every configured category under it.
  allCategories.forEach(category => {
    if (editableTypeIds.has(category.typeId)) editableCategories.add(category.name);
  });
  const isCorrection = editableRows.length > 0 && dailyRows.some(e => e.approvalStatus === 'Approved' || e.approvalStatus === 'AutoApproved');
  const isApproved = dailyRows.length > 0 && !isCorrection && dailyRows.every(e => e.approvalStatus === 'Approved' || e.approvalStatus === 'AutoApproved');
  const approvedRows = dailyRows.filter(e => e.approvalStatus === 'Approved' || e.approvalStatus === 'AutoApproved');
  const approvers = [...new Set(approvedRows.map(e => e.approvedBy).filter(Boolean))];
  const latestApproval = approvedRows.map(e => e.approvedAt).filter(Boolean).sort().at(-1);
  const approvalDetail = approvers.length ? ` <em class="text-muted small">— approved by ${approvers.map(escapeHtml).join(', ')}${latestApproval ? ` on ${formatDate(latestApproval)}` : ''}</em>` : '';

  // Show rejection notice if cashier sees a rejected date
  const rejectedRow = allExpenses.find(e => e.mode !== 'Occasional' && e.date === date && e.approvalStatus === 'Rejected');
  const noticeEl = document.getElementById('rejectionNotice');
  if (rejectedRow && !isSuperUser()) {
    noticeEl.innerHTML =
      '<i class="bi bi-exclamation-triangle-fill me-2"></i><strong>Rejected:</strong> ' +
      (rejectedRow.rejectionReason || 'Please correct and resubmit.') +
      ' <em class="text-muted small">— ' + rejectedRow.approvedBy + '</em>' + approvalDetail;
    noticeEl.style.display = '';
  } else if (isApproved) {
    noticeEl.innerHTML =
      '<i class="bi bi-check-circle-fill me-2 text-success"></i><strong>Approved</strong> ' +
      '<span class="text-muted small">— This date\'s expenses have been approved and cannot be edited.</span>' + approvalDetail;
    noticeEl.className = 'alert alert-success';
    noticeEl.style.display = '';
  } else if (approvalDetail) {
    noticeEl.innerHTML = '<i class="bi bi-check-circle-fill me-2 text-success"></i><strong>Some expenses approved</strong>' + approvalDetail;
    noticeEl.className = 'alert alert-info';
    noticeEl.style.display = '';
  } else {
    noticeEl.style.display = '';
    noticeEl.className = 'alert alert-danger';
    noticeEl.style.display = 'none';
  }

  buildCategoryInputs(existing, isApproved, isCorrection ? editableCategories : null, editableTypeIds);
  renderReceiptsOnDate(document.getElementById('receiptsOnDateDaily'), date, false);

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
  const status = statuses.includes('Rejected') ? 'rejected' : statuses.includes('Pending') ? 'pending' :
    statuses.some(value => value === 'Approved' || value === 'AutoApproved') ? 'approved' : 'neutral';
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
    else if (expense.approvalStatus === 'Pending' || current === 'Pending') statuses[expense.date] = 'Pending';
    else if (expense.approvalStatus === 'Approved' || expense.approvalStatus === 'AutoApproved') statuses[expense.date] = 'Approved';
  });
  let days = Array(new Date(year, month, 1).getDay()).fill('<span class="expense-date-picker-empty"></span>').join('');
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const date = getLocalDateKey(new Date(year, month, day));
    const status = statuses[date];
    const state = status === 'Rejected' ? 'rejected' : (status === 'Pending' ? 'pending' : (status === 'Approved' ? 'approved' : 'neutral'));
    days += `<button type="button" class="expense-date-picker-day ${state}${date === document.getElementById('expDate').value ? ' selected' : ''}" data-picker-date="${date}" ${date > today ? 'disabled' : ''}>${day}</button>`;
  }
  picker.innerHTML = `<div class="expense-date-picker-header"><button type="button" data-picker-nav="prev" aria-label="Previous month"><i class="bi bi-chevron-left"></i></button><strong>${datePickerMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong><button type="button" data-picker-nav="next" aria-label="Next month"><i class="bi bi-chevron-right"></i></button></div><div class="expense-date-picker-weekdays">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => `<span>${day}</span>`).join('')}</div><div class="expense-date-picker-grid">${days}</div><div class="expense-date-picker-legend"><span><i class="approved"></i>Approved</span><span><i class="pending"></i>Pending</span><span><i class="rejected"></i>Rejected</span><span><i class="neutral"></i>Not approved/rejected</span></div>`;
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

function buildCategoryInputs(existingMap, isReadOnly, editableCategories = null, editableTypeIds = new Set()) {
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

  const readonlyAttrFor = category => isReadOnly || (editableCategories && !editableCategories.has(category))
    ? ' readonly disabled style="font-size:1rem;background:#f8f9fa"' : ' style="font-size:1rem"';
  const legacyType = allCategoryTypes.find(t => t.name === 'General') || allCategoryTypes.find(t => t.sortOrder === 1) || allCategoryTypes[0] || { id: '', name: 'General', sortOrder: 0 };
  const grouped = new Map();
  const currentDailyRows = allExpenses.filter(entry => entry.mode !== 'Occasional' &&
    entry.date === document.getElementById('expDate').value && !entry.employeeId);
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
      const existingId = currentDailyRows.find(entry => !entry.onSpot && entry.category === c.name && entry.typeId === type.id)?.id || '';
      return '<div class="expense-category-row d-flex align-items-center gap-3 py-2">' +
        '<span class="fw-medium flex-grow-1">' + c.name + pendingSlotHtml(type.id, c.name) + '</span>' +
        '<div class="input-group expense-amount-input">' +
        '<span class="input-group-text fw-semibold">&#8377;</span>' +
        '<input type="number" class="form-control cat-amount" data-id="' + existingId + '" data-category="' + c.name + '" data-type="' + type.id + '" data-onspot="false" ' +
        'min="0" step="0.01" placeholder="0" value="' + val + '" oninput="updateTotal()"' + readonlyAttrFor(c.name) + '>' +
        '</div></div>';
    }).join('');
    const onSpotRows = onSpotEntries.map(entry => '<div class="expense-category-row onspot-row d-flex align-items-center gap-3 py-2">' +
      '<input type="text" class="form-control onspot-name flex-grow-1" data-type="' + type.id + '" value="' + escapeHtml(entry.category) + '" placeholder="On-spot category"' + (readonlyAttrFor(entry.category).includes('readonly') ? ' readonly disabled' : '') + '>' + pendingSlotHtml(type.id, entry.category) +
      '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span><input type="number" class="form-control cat-amount" data-id="' + entry.id + '" data-category="' + escapeHtml(entry.category) + '" data-type="' + type.id + '" data-onspot="true" min="0" step="0.01" value="' + entry.amount + '" oninput="updateTotal()"' + readonlyAttrFor(entry.category) + '></div>' +
      (readonlyAttrFor(entry.category).includes('readonly') ? '' : '<button type="button" class="btn btn-sm btn-outline-danger onspot-delete" title="Delete on-spot expense" onclick="deleteOnSpotExpense(\'' + entry.id + '\')"><i class="bi bi-trash"></i></button>') + '</div>').join('');
    const salaryRows = salaryEntries.map(entry => '<div class="expense-category-row salary-expense-row d-flex align-items-center gap-3 py-2">' +
      '<span class="fw-medium flex-grow-1"><i class="bi bi-cash-coin me-1 text-success"></i>' + escapeHtml(entry.category) + '<small class="d-block text-muted">Salary payment</small></span>' +
      '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span><input type="number" class="form-control cat-amount" data-category="' + escapeHtml(entry.category) + '" data-type="' + type.id + '" value="' + entry.amount + '" readonly disabled></div>' +
      (isReadOnly || !entry.paymentId ? '' : '<button type="button" class="btn btn-sm btn-outline-danger salary-expense-delete" title="Delete employee payment" onclick="deleteEmployeePayment(\'' + entry.paymentId + '\')"><i class="bi bi-trash"></i></button>') + '</div>').join('');
    const onSpotAction = isReadOnly || (editableCategories && !editableTypeIds.has(type.id)) ? '' :
      '<button type="button" class="btn btn-sm btn-outline-secondary onspot-add" onclick="addOnSpotRow(this)"><i class="bi bi-plus-lg me-1"></i>On-spot category</button>';
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
    '<div class="input-group expense-amount-input"><span class="input-group-text fw-semibold">&#8377;</span><input type="number" class="form-control cat-amount" data-category="" data-type="' + typeId + '" data-onspot="true" data-quantity-key="new-' + (++nextOnSpotQuantityKey) + '" min="0" step="0.01" placeholder="0" oninput="updateTotal()"></div>';
  content.insertBefore(row, actions);
  row.querySelector('.onspot-name').focus();
}

function onSpotQuantityInput(quantity = {}, inputClass = 'expense-quantity') {
  const unit = quantity.unit || 'Count';
  const name = escapeHtml(quantity.name || unit);
  const amount = quantity.amount || '';
  const quantityCategoryId = escapeHtml(quantity.quantityCategoryId || '');
  return `<div class="input-group input-group-sm mb-2 onspot-quantity quantity-price-group" style="max-width:760px"><input type="text" class="form-control expense-quantity-name" style="max-width:180px" value="${name}" placeholder="Quantity"><input type="number" class="form-control ${inputClass}" data-quantity-category-id="${quantityCategoryId}" data-name="${name}" data-unit="${unit}" min="0" step="0.01" value="${amount}"><select class="form-select expense-quantity-unit" style="max-width:80px" data-prev-unit="${unit}" onchange="syncOnSpotQuantityName(this)">${['KG', 'Grams', 'Litre', 'Count'].map(option => `<option${unit === option ? ' selected' : ''}>${option}</option>`).join('')}
    </select>${quantityPriceInputHtml(parseFloat(quantity.unitPrice) || 0, false, quantity.totalAmount ?? '')}<button type="button" class="btn btn-outline-danger" title="Delete quantity" aria-label="Delete quantity" onclick="deleteOnSpotQuantity(this)"><i class="bi bi-trash"></i></button></div>`;
}

// Keeps the name in sync with the selected unit until the user overrides it with a custom label.
function syncOnSpotQuantityName(select) {
  const group = select.closest('.onspot-quantity');
  const nameInput = group?.querySelector('.expense-quantity-name');
  if (!nameInput) return;
  const previous = select.dataset.prevUnit || '';
  const current = select.value;
  if (!nameInput.value.trim() || nameInput.value.trim() === previous) nameInput.value = current;
  select.dataset.prevUnit = current;
}

function addOnSpotQuantity(button) {
  button.closest('.expense-quantity-cell').querySelector('.onspot-quantity-fields').insertAdjacentHTML('beforeend', onSpotQuantityInput());
}

function deleteOnSpotQuantity(button) {
  button.closest('.onspot-quantity').remove();
}

function addOccasionalOnSpotQuantity(button) {
  button.closest('td').querySelector('.occasional-onspot-quantity-fields').insertAdjacentHTML('beforeend', onSpotQuantityInput({}, 'occasional-onspot-quantity'));
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

/* ---- Unpaid received quantities ---- */

function renderUnpaidQuantities() {
  refreshCategoryPendingBadges();
  const body = document.getElementById('unpaidQuantityBody');
  const tabItem = document.getElementById('pendingPaymentTabItem');
  const badge = document.getElementById('pendingPaymentBadge');
  if (!body) return;
  const typeNames = new Map(allCategoryTypes.map(type => [type.id, type.displayText || type.name]));
  const typeWorkflows = new Map(allCategoryTypes.map(type => [type.id, normalizeWorkflow(type.workflow)]));
  const canEdit = canAccess('expenses', 'add');
  const rows = allUnpaidQuantities.filter(receipt => (receipt.totalAmount - receipt.paidAmount) > 0.001)
    .slice().sort((first, second) => (second.receivedDate || '').localeCompare(first.receivedDate || ''));
  if (badge) badge.textContent = rows.length;
  if (tabItem) tabItem.classList.toggle('d-none', rows.length === 0);
  // If the tab is currently active but should be hidden, fall back to the Expenses tab.
  if (!rows.length && tabItem?.classList.contains('d-none')) {
    const paneEl = document.getElementById('pendingPaymentPane');
    if (paneEl?.classList.contains('active')) bootstrap.Tab.getOrCreateInstance(document.getElementById('expenseAmountsTab')).show();
  }
  if (!rows.length) {
    body.innerHTML = emptyRow(8, 'No unpaid received quantities.');
    return;
  }
  body.innerHTML = rows.map(receipt => {
    const workflow = typeWorkflows.get(receipt.typeId) || 'Daily Cash';
    const modeLabel = workflow === 'Occasional' ? 'Occasional' : 'Daily';
    const pendingForReceipt = [...pendingUnpaidLinks.values()].filter(link => link.receiptId === receipt.id);
    const pendingSum = pendingForReceipt.reduce((sum, link) => sum + (parseFloat(link.amount) || 0), 0);
    const linkedNote = pendingForReceipt.length
      ? '<div class="mt-1 small">' + pendingForReceipt.map(link =>
          `<div class="text-success"><i class="bi bi-link-45deg me-1"></i>Linking ${formatCurrency(link.amount)} → ${escapeHtml(link.label)}
            <button type="button" class="btn btn-sm btn-link p-0 ms-1 align-baseline" title="Cancel this link" onclick="cancelPendingLink('${escapeHtml(receipt.id)}','${escapeHtml(link.rowKey)}')"><i class="bi bi-x"></i></button></div>`
        ).join('') + '</div>'
      : '';
    const items = (receipt.items || []).map(item => `<div><span class="fw-medium">${escapeHtml(item.name)}</span>: ${item.amount} ${escapeHtml(item.unit)}</div>`).join('') || '<span class="text-muted small">No items</span>';
    const total = receipt.totalAmount || 0;
    const paid = receipt.paidAmount || 0;
    const balance = +(total - paid - pendingSum).toFixed(2);
    const balanceCell = (paid > 0 || pendingForReceipt.length)
      ? `<div class="fw-semibold">${formatCurrency(balance)} <span class="text-muted small fw-normal">balance</span></div><div class="text-muted small">${formatCurrency(paid)} paid of ${formatCurrency(total)}${pendingForReceipt.length ? ` (+${formatCurrency(pendingSum)} pending)` : ''}</div>`
      : `<div class="fw-semibold">${formatCurrency(total)}</div>`;
    const history = (receipt.payments || []).length
      ? `<details class="small mt-1"><summary class="text-muted" style="cursor:pointer">History (${receipt.payments.length})</summary>${receipt.payments.map(payment => {
          const expense = allExpenses.find(item => item.id === payment.expenseId);
          const label = expense ? `${expense.category} · ${formatDate(expense.date)}` : payment.expenseId;
          return `<div class="d-flex justify-content-between border-top pt-1 mt-1"><span>${escapeHtml(label)}</span><strong>${formatCurrency(payment.amount)}</strong></div>`;
        }).join('')}</details>`
      : '';
    const actions = canEdit ? `<div class="btn-group btn-group-sm">
      <button type="button" class="btn btn-outline-primary" title="Link to an expense" onclick="promptLinkUnpaid('${escapeHtml(receipt.id)}')" ${balance <= 0.001 ? 'disabled' : ''}><i class="bi bi-link-45deg"></i></button>
      <button type="button" class="btn btn-outline-danger" title="Delete" onclick="deleteUnpaidQuantity('${escapeHtml(receipt.id)}')"><i class="bi bi-trash"></i></button>
    </div>` : '';
    return `<tr>
      <td data-label="Received">${formatDate(receipt.receivedDate)}</td>
      <td data-label="Mode"><span class="badge ${modeLabel === 'Occasional' ? 'bg-info-subtle text-info border border-info-subtle' : 'bg-primary-subtle text-primary border border-primary-subtle'}">${modeLabel}</span></td>
      <td data-label="Category type">${escapeHtml(typeNames.get(receipt.typeId) || 'Unknown')}</td>
      <td data-label="Category">${escapeHtml(receipt.category)}</td>
      <td data-label="Items" class="small">${items}</td>
      <td data-label="Payable" class="text-end">${balanceCell}${history}</td>
      <td data-label="Remarks" class="text-muted">${escapeHtml(receipt.remarks || '—')}${linkedNote}</td>
      <td data-label="Actions" class="text-center">${actions}</td>
    </tr>`;
  }).join('');
}

// Shows every receipt (open or settled) captured on `date` with its full payment history, so goods received on that day stay traceable.
function renderReceiptsOnDate(container, date, occasional = false) {
  if (!container) return;
  const typeNames = new Map(allCategoryTypes.map(type => [type.id, type.displayText || type.name]));
  const typeWorkflows = new Map(allCategoryTypes.map(type => [type.id, normalizeWorkflow(type.workflow)]));
  const receipts = allUnpaidQuantities.filter(receipt =>
    receipt.receivedDate === date &&
    ((typeWorkflows.get(receipt.typeId) === 'Occasional') === !!occasional));
  if (!receipts.length) { container.innerHTML = ''; return; }
  container.innerHTML = `<div class="border rounded p-2">
    <div class="small text-muted mb-2"><i class="bi bi-box-seam me-1"></i>Received on ${formatDate(date)}${occasional ? ' (occasional)' : ''}</div>
    ${receipts.map(receipt => {
      const total = receipt.totalAmount || 0;
      const paid = receipt.paidAmount || 0;
      const balance = +(total - paid).toFixed(2);
      const settled = balance <= 0.001;
      const items = (receipt.items || []).map(item => `<div><span class="fw-medium">${escapeHtml(item.name)}</span>: ${item.amount} ${escapeHtml(item.unit)}</div>`).join('') || '<span class="text-muted small">No items</span>';
      const historyRows = (receipt.payments || []).map(payment => {
        const expense = allExpenses.find(item => item.id === payment.expenseId);
        const label = expense ? `${expense.category} · ${formatDate(expense.date)}` : payment.expenseId;
        return `<div class="d-flex justify-content-between small border-top pt-1 mt-1"><span>${escapeHtml(label)}</span><span>${formatCurrency(payment.amount)}</span></div>`;
      }).join('');
      const history = historyRows ? `<div class="mt-2">${historyRows}</div>` : '<div class="text-muted small mt-2">No payments yet.</div>';
      return `<div class="mb-2 pb-2 border-bottom">
        <div class="d-flex justify-content-between align-items-start">
          <div>
            <strong>${escapeHtml(receipt.category)}</strong>
            <span class="text-muted small ms-1">· ${escapeHtml(typeNames.get(receipt.typeId) || 'Unknown')}</span>
            <span class="badge ${settled ? 'bg-success-subtle text-success border border-success-subtle' : 'bg-warning text-dark'} ms-2">${settled ? 'Fully paid' : `${formatCurrency(balance)} pending`}</span>
          </div>
          <div class="text-end small">${formatCurrency(paid)} paid of ${formatCurrency(total)}</div>
        </div>
        <div class="mt-1">${items}</div>
        ${receipt.remarks ? `<div class="text-muted small mt-1"><i class="bi bi-chat-left-text me-1"></i>${escapeHtml(receipt.remarks)}</div>` : ''}
        ${history}
      </div>`;
    }).join('')}
  </div>`;
}

async function deleteUnpaidQuantity(id) {
  if (!id || !confirm('Delete this receipt?')) return;
  try {
    await api('DELETE', '/expenses/unpaid/' + encodeURIComponent(id));
    showNotification('Receipt deleted.');
    [...pendingUnpaidLinks.keys()].filter(key => key.startsWith(`${id}::`)).forEach(key => pendingUnpaidLinks.delete(key));
    allUnpaidQuantities = await api('GET', '/expenses/unpaid?includeSettled=1');
    renderUnpaidQuantities();
  } catch (err) {
    showNotification('Delete failed: ' + err.message, 'danger');
  }
}

// Lists cat-amount inputs currently in the form that have a positive amount, so the user can pick a target expense.
function collectLinkableExpenses() {
  const typeNames = new Map(allCategoryTypes.map(type => [type.id, type.displayText || type.name]));
  return [...document.querySelectorAll('.cat-amount:not([readonly])')].map(input => {
    const amount = parseFloat(input.value);
    if (!(amount > 0)) return null;
    const onSpot = input.dataset.onspot === 'true';
    const name = onSpot ? input.closest('.onspot-row')?.querySelector('.onspot-name')?.value.trim() : input.dataset.category;
    if (!name) return null;
    const typeId = input.dataset.type;
    const rowKey = input.dataset.quantityRowKey || quantityRowKey(input, name);
    return { rowKey, typeId, category: name, onSpot, amount, label: `${typeNames.get(typeId) || 'Type'} · ${name} (${formatCurrency(amount)})` };
  }).filter(Boolean);
}

function promptLinkUnpaid(unpaidId) {
  const receipt = allUnpaidQuantities.find(item => item.id === unpaidId);
  if (!receipt) return;
  const options = collectLinkableExpenses().filter(target => target.typeId === receipt.typeId);
  if (!options.length) {
    showNotification('Enter an expense amount for a category under the same type first.', 'warning');
    return;
  }
  const pendingSum = [...pendingUnpaidLinks.values()].filter(link => link.receiptId === unpaidId).reduce((sum, link) => sum + (parseFloat(link.amount) || 0), 0);
  const balance = +((receipt.totalAmount || 0) - (receipt.paidAmount || 0) - pendingSum).toFixed(2);
  if (balance <= 0.001) {
    showNotification('This receivable is fully covered by existing links.', 'warning');
    return;
  }
  const itemsSummary = (receipt.items || []).map(item => `${item.name} (${item.amount} ${item.unit})`).join(', ') || 'items';
  const choice = prompt(`Link ${itemsSummary} — balance ${formatCurrency(balance)} — to which expense?\n\n${options.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}\n\nEnter the number:`);
  if (!choice) return;
  const target = options[parseInt(choice, 10) - 1];
  if (!target) { showNotification('Invalid selection.', 'warning'); return; }
  const compositeKey = `${unpaidId}::${target.rowKey}`;
  if (pendingUnpaidLinks.has(compositeKey)) {
    showNotification('That expense is already linked to this receivable — cancel it first if you want a different amount.', 'warning');
    return;
  }
  const defaultPay = Math.min(target.amount, balance);
  const amountInput = prompt(`Amount to pay from this receivable (max ${formatCurrency(balance)}):`, String(defaultPay));
  if (amountInput === null) return;
  const amount = parseFloat(amountInput);
  if (!(amount > 0) || amount > balance + 0.001) { showNotification('Invalid amount.', 'warning'); return; }
  pendingUnpaidLinks.set(compositeKey, {
    receiptId: unpaidId, rowKey: target.rowKey, typeId: target.typeId,
    category: target.category, onSpot: target.onSpot, amount, label: target.label
  });
  renderUnpaidQuantities();
  showNotification('Linked. Save the expense to apply.', 'info');
}

function cancelPendingLink(receiptId, rowKey) {
  pendingUnpaidLinks.delete(`${receiptId}::${rowKey}`);
  renderUnpaidQuantities();
}

function unlinkUnpaidQuantity(unpaidId) {
  [...pendingUnpaidLinks.keys()].filter(key => key.startsWith(`${unpaidId}::`)).forEach(key => pendingUnpaidLinks.delete(key));
  renderUnpaidQuantities();
}

async function unlinkExpenseFromReceipt(expenseId, receiptId) {
  if (!expenseId || !receiptId) return;
  if (!confirm('Remove this link? The receivable balance will be restored.')) return;
  try {
    await api('DELETE', `/expenses/${encodeURIComponent(expenseId)}/unpaid-link/${encodeURIComponent(receiptId)}`);
    showNotification('Link removed.');
    [allExpenses, allExpenseQuantities, allUnpaidQuantities] = await Promise.all([
      api('GET', '/expenses'),
      api('GET', '/expenses/quantities'),
      api('GET', '/expenses/unpaid?includeSettled=1')
    ]);
    renderUnpaidQuantities();
    loadDateIntoForm(document.getElementById('expDate').value);
    renderOccasionalExpenses();
  } catch (err) {
    showNotification('Unlink failed: ' + err.message, 'danger');
  }
}

// Extract linkedUnpaid array for a single entry from pendingUnpaidLinks by matching rowKey.
function collectLinkedUnpaidFor(input) {
  const rowKey = input.dataset.quantityRowKey || quantityRowKey(input, input.dataset.category);
  const links = [];
  for (const link of pendingUnpaidLinks.values()) {
    if (link.rowKey === rowKey) links.push({ unpaidId: link.receiptId, amount: link.amount });
  }
  return links;
}

function toggleExpenseType(button) {
  const card = button.closest('.expense-category-type-card');
  const expanded = card.classList.toggle('is-collapsed') === false;
  button.setAttribute('aria-expanded', String(expanded));
}

function scheduleQuantityInputsRender(nameInput = null) {
  if (nameInput) pendingOnSpotNameInput = nameInput;
  clearTimeout(quantityRenderTimer);
  quantityRenderTimer = setTimeout(flushQuantityInputsRender, 100);
}

function flushQuantityInputsRender() {
  clearTimeout(quantityRenderTimer);
  quantityRenderTimer = null;
  const input = pendingOnSpotNameInput;
  pendingOnSpotNameInput = null;
  if (input?.isConnected) {
    const row = input.closest('.onspot-row');
    row.querySelector('.category-pending-slot')?.remove();
    input.insertAdjacentHTML('afterend', pendingSlotHtml(input.dataset.type, input.value));
  }
  renderQuantityInputs();
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
  if (document.activeElement?.matches?.('.cat-amount, .onspot-name')) scheduleQuantityInputsRender();
  else renderQuantityInputs();
}

function quantityRowKey(input, category) {
  const uniqueKey = input.dataset.id || input.dataset.quantityKey || input.dataset.type + '|' + input.dataset.category;
  return `${uniqueKey}|${String(category).trim().toLowerCase()}|${input.dataset.onspot === 'true'}`;
}

// On-spot names are free text, so they match a configured category by name alone when the type has none.
function findConfiguredCategory(name, typeId) {
  const normalized = String(name).trim().toLowerCase();
  return allCategories.find(item => item.name.trim().toLowerCase() === normalized && item.typeId === typeId)
    || allCategories.find(item => item.name.trim().toLowerCase() === normalized);
}

// Quantities are captured for on-spot rows with amount + name, and for any configured category
// whose quantity fields are available — so cashiers can see and enter default quantities before typing the amount.
function renderQuantityInputs() {
  const body = document.getElementById('quantityInputsBody');
  const countBadge = document.getElementById('quantityTabCount');
  if (!body) return;
  // Rebuilding the pane while the user is typing in it would drop the in-progress .onspot-quantity node they added.
  if (body.contains(document.activeElement)) return;

  const typeNames = new Map(allCategoryTypes.map(type => [type.id, type.displayText || type.name]));
  const entered = [...document.querySelectorAll('.cat-amount')].filter(input => {
    if ((parseFloat(input.value) || 0) > 0) return true;
    if (input.dataset.onspot === 'true') return false;
    const category = findConfiguredCategory(input.dataset.category, input.dataset.type);
    return !!category && allQuantityCategories.some(quantity => quantity.categoryId === category.id);
  });
  const drafts = new Map([...body.querySelectorAll('.expense-quantity')].map(input => {
    const row = input.closest('tr');
    const custom = input.closest('.onspot-quantity');
    return [`${row.dataset.rowKey}|${custom ? custom.querySelector('.expense-quantity-name').value.trim() : input.dataset.quantityCategoryId}`,
      { amount: input.value, unit: custom ? custom.querySelector('.expense-quantity-unit').value : input.dataset.unit,
        unitPrice: input.closest('.quantity-price-group')?.querySelector('.expense-quantity-price')?.value || '',
        totalAmount: input.closest('.quantity-price-group')?.querySelector('.expense-quantity-total')?.value || '' }];
  }));

  // Custom on-spot quantities exist only in the DOM until save, so carry them over as-is.
  const renderedRowKeys = new Set([...body.querySelectorAll('tr[data-row-key]')].map(row => row.dataset.rowKey));
  const customDrafts = new Map();
  body.querySelectorAll('.onspot-quantity').forEach(group => {
    const rowKey = group.closest('tr').dataset.rowKey;
    const input = group.querySelector('.expense-quantity');
    if (!customDrafts.has(rowKey)) customDrafts.set(rowKey, []);
    customDrafts.get(rowKey).push({
      quantityCategoryId: input.dataset.quantityCategoryId,
      name: group.querySelector('.expense-quantity-name').value,
      unit: group.querySelector('.expense-quantity-unit').value,
      amount: input.value,
      unitPrice: group.querySelector('.expense-quantity-price')?.value || '',
      totalAmount: group.querySelector('.expense-quantity-total')?.value || ''
    });
  });

  const rows = entered.map(input => {
    const onSpot = input.dataset.onspot === 'true';
    const name = onSpot ? input.closest('.onspot-row')?.querySelector('.onspot-name')?.value.trim() : input.dataset.category;
    if (!name) return '';
    const typeId = input.dataset.type;
    const rowKey = quantityRowKey(input, name);
    input.dataset.quantityRowKey = rowKey;
    const readOnly = input.readOnly ? ' readonly disabled' : '';
    const category = findConfiguredCategory(name, typeId);
    const defined = category ? allQuantityCategories.filter(quantity => quantity.categoryId === category.id) : [];
    const saved = allExpenseQuantities.filter(quantity => quantity.expenseId === input.dataset.id);
    const pickerKey = category ? handpickKey(category, '', `${typeId}|${categoryBalanceName(name)}|${onSpot}`) : '';
    const selected = selectedQuantityFields(category, pickerKey, saved);

    const customSaved = saved.filter(quantity => !defined.some(item => item.id === quantity.quantityCategoryId));
    if (!defined.length && !onSpot && !customSaved.length) return '';

    const fields = defined.map(quantity => {
      const draft = drafts.get(`${rowKey}|${quantity.id}`);
      const value = draft ? draft.amount : (saved.find(item => item.quantityCategoryId === quantity.id)?.amount ?? (quantity.defaultQuantity ?? ''));
      const unitPrice = draft ? parseFloat(draft.unitPrice) || 0 : (saved.find(item => item.quantityCategoryId === quantity.id)?.unitPrice || 0);
      const totalAmount = draft ? draft.totalAmount : (saved.find(item => item.quantityCategoryId === quantity.id)?.totalAmount ?? '');
      return `<div class="input-group input-group-sm mb-2 quantity-price-group configured-quantity-field"${selected && !selected.has(quantity.id) ? ' hidden' : ''} style="max-width:560px">
        <span class="input-group-text" style="min-width:110px">${escapeHtml(quantity.name)}</span>
        <input type="number" class="form-control expense-quantity" data-quantity-category-id="${quantity.id}" data-name="${escapeHtml(quantity.name)}" data-unit="${quantity.unit}" min="0" step="0.01" value="${value}"${readOnly}>
        <span class="input-group-text">${escapeHtml(quantity.unit)}</span>${quantityPriceInputHtml(unitPrice, !!readOnly, totalAmount)}</div>`;
    }).join('');

    const matchNote = onSpot && defined.length
      ? `<div class="text-muted small mb-2">Matched configured category <strong>${escapeHtml(category.name)}</strong></div>` : '';

    const customList = renderedRowKeys.has(rowKey) ? (customDrafts.get(rowKey) || []) : customSaved;
    let customFields;
    if (onSpot) {
      customFields = `<div class="onspot-quantity-fields">${customList.map(quantity => onSpotQuantityInput(quantity)).join('')}</div>${readOnly ? '' : '<button type="button" class="btn btn-sm btn-outline-primary" onclick="addOnSpotQuantity(this)"><i class="bi bi-plus-lg me-1"></i>Add Quantity</button>'}`;
    } else if (customSaved.length) {
      // Linked receivable quantities shown read-only next to configured fields so partial payments are visible on this day.
      const byReceipt = new Map();
      customSaved.forEach(quantity => {
        const key = quantity.sourceReceiptId || '';
        if (!byReceipt.has(key)) byReceipt.set(key, []);
        byReceipt.get(key).push(quantity);
      });
      customFields = [...byReceipt.entries()].map(([receiptId, group]) => {
        const label = receiptId ? `Linked from receivable` : `Additional quantities`;
        const unlinkBtn = receiptId && !readOnly && input.dataset.id
          ? `<button type="button" class="btn btn-sm btn-outline-danger ms-2" title="Unlink from receivable" onclick="unlinkExpenseFromReceipt('${escapeHtml(input.dataset.id)}', '${escapeHtml(receiptId)}')"><i class="bi bi-x-circle me-1"></i>Unlink</button>` : '';
        const items = group.map(quantity => `<div class="input-group input-group-sm mb-2" style="max-width:280px"><span class="input-group-text" style="min-width:110px">${escapeHtml(quantity.name)}</span><input type="number" class="form-control" value="${quantity.amount}" readonly disabled><span class="input-group-text">${escapeHtml(quantity.unit)}</span></div>`).join('');
        return `<div class="d-flex align-items-center mt-2 mb-1 text-muted small"><i class="bi bi-link-45deg me-1"></i>${label}${unlinkBtn}</div>${items}`;
      }).join('');
    } else {
      customFields = '';
    }

    if (!fields && !onSpot && !customFields) return '';
    return `<tr data-row-key="${rowKey}" data-picker-key="${escapeHtml(pickerKey)}" data-picker-category="${escapeHtml(name)}" data-expense-amount="${parseFloat(input.value) || 0}">
      <td data-label="Category type">${escapeHtml(typeNames.get(typeId) || 'Unassigned type')}</td>
      <td data-label="Category" class="fw-semibold">${escapeHtml(name)}${pendingSlotHtml(typeId, name)}<div class="text-muted small">${formatCurrency(parseFloat(input.value) || 0)}</div></td>
      <td data-label="Quantities" class="expense-quantity-cell">${matchNote}${quantityPickerButton(category, !!readOnly)}${fields}${customFields}<div class="quantity-row-summary small text-muted mt-1"></div></td>
    </tr>`;
  }).filter(Boolean);

  body.innerHTML = rows.join('') || emptyRow(3, 'Enter an expense amount for a category that has quantity fields configured.');
  refreshQuantityValues(body);
  if (countBadge) countBadge.textContent = rows.length;
}

function collectQuantitiesFor(input) {
  const typeId = input.dataset.type;
  const row = document.querySelector(`#quantityInputsBody tr[data-row-key="${CSS.escape(input.dataset.quantityRowKey || quantityRowKey(input, input.dataset.category))}"]`);
  if (!row) return [];
  return [...row.querySelectorAll('.expense-quantity')].filter(input => !input.closest('.configured-quantity-field')?.hidden).map(quantityInput => {
    const custom = quantityInput.closest('.onspot-quantity');
    const name = custom ? custom.querySelector('.expense-quantity-name').value.trim() : quantityInput.dataset.name;
    const unit = custom ? custom.querySelector('.expense-quantity-unit').value : quantityInput.dataset.unit;
    return { quantityCategoryId: quantityInput.dataset.quantityCategoryId || `onspot:${typeId}:${name}`, name, unit, amount: quantityInput.value,
      unitPrice: quantityInput.closest('.quantity-price-group')?.querySelector('.expense-quantity-price')?.value || '',
      totalAmount: quantityInput.closest('.quantity-price-group')?.querySelector('.expense-quantity-total')?.value || '' };
  }).filter(quantity => quantity.name && parseFloat(quantity.amount) > 0);
}

/* ---- Save ---- */

async function save(options = {}) {
  if (quantityRenderTimer !== null) flushQuantityInputsRender();
  const silent = !!options.silent;
  const date = document.getElementById('expDate').value;
  if (!date) { if (!silent) showNotification('Please select a date.', 'warning'); return; }
  if (date > today) { if (!silent) showNotification('Future dates cannot be saved.', 'warning'); return; }
  const dailyRows = allExpenses.filter(e => e.mode !== 'Occasional' && e.date === date && !e.employeeId);
  if (dailyRows.length && dailyRows.every(e => e.approvalStatus === 'Approved' || e.approvalStatus === 'AutoApproved')) {
    if (!silent) showNotification('Approved dates cannot be edited.', 'warning');
    loadDateIntoForm(date);
    return;
  }

  const entries = [];
  document.querySelectorAll('.cat-amount:not([readonly])').forEach(inp => {
    const amount = parseFloat(inp.value) || 0;
    const onSpot = inp.dataset.onspot === 'true';
    const name = onSpot ? inp.closest('.onspot-row')?.querySelector('.onspot-name')?.value.trim() : inp.dataset.category;
    if (!name) return;
    const quantities = collectQuantitiesFor(inp);
    const linkedUnpaid = collectLinkedUnpaidFor(inp);
    // Persist rows with an amount OR any quantities OR linked receipts so quantity-only entries survive save.
    const hasQuantities = quantities.some(quantity => parseFloat(quantity.amount) > 0);
    const hasLinks = Array.isArray(linkedUnpaid) && linkedUnpaid.length > 0;
    if (amount > 0 || hasQuantities || hasLinks || inp.dataset.id) {
      entries.push({
        id: inp.dataset.id || '', category: name, amount, typeId: inp.dataset.type, onSpot,
        quantities, linkedUnpaid
      });
    }
  });

  if (!entries.length) { if (!silent) showNotification('Enter at least one amount or quantity.', 'warning'); return; }

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
    // Consumed unpaid entries are cleared server-side; drop the client-side pending links.
    if (pendingUnpaidLinks.size) pendingUnpaidLinks.clear();
    [allExpenses, allExpenseQuantities, allUnpaidQuantities] = await Promise.all([
      api('GET', '/expenses'),
      api('GET', '/expenses/quantities'),
      api('GET', '/expenses/unpaid?includeSettled=1')
    ]);
    renderUnpaidQuantities();
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

async function approveDate(date, mode = 'Daily') {
  try {
    const result = await api('POST', '/expenses/approve/' + date, { mode });
    const updated = result?.updated ?? result?.data?.updated ?? 0;
    showNotification(updated ? 'Approved successfully.' : 'No pending expenses were approved. A different superuser must approve their own submission.', updated ? 'success' : 'warning');
    allExpenses = await api('GET', '/expenses');
    await loadSelectedExpenseReport();
  } catch (err) {
    showNotification('Approve failed: ' + err.message, 'danger');
  }
}

function openRejectModal(date, mode = 'Daily') {
  pendingRejectDate = date;
  pendingRejectMode = mode;
  document.getElementById('rejectReason').value = '';
  const typeNames = new Map(allCategoryTypes.map(type => [type.id, type.displayText || type.name]));
  const rows = allExpenses.filter(expense => expense.date === date && !expense.employeeId &&
    (mode === 'Occasional' ? expense.mode === 'Occasional' : expense.mode !== 'Occasional') && expense.approvalStatus !== 'Rejected');
  const groups = new Map();
  rows.forEach(expense => {
    if (!expense.category) return;
    const typeName = typeNames.get(expense.typeId) || 'Unassigned type';
    if (!groups.has(typeName)) groups.set(typeName, []);
    groups.get(typeName).push(expense);
  });
  // A type is "missing" when no expense (of any status) was recorded for it on this date.
  const dateTypeIds = new Set(allExpenses
    .filter(expense => expense.date === date && !expense.employeeId && expense.typeId &&
      (mode === 'Occasional' ? expense.mode === 'Occasional' : expense.mode !== 'Occasional'))
    .map(expense => expense.typeId));
  const missingTypes = allCategoryTypes
    .filter(type => type.status === 'Active' && !dateTypeIds.has(type.id) &&
      (mode === 'Occasional' ? normalizeWorkflow(type.workflow) === 'Occasional' : normalizeWorkflow(type.workflow) !== 'Occasional'))
    .sort((first, second) => (first.sortOrder || 0) - (second.sortOrder || 0));
  const groupsHtml = [...groups.entries()].map(([typeName, entries]) => `
    <div class="border rounded p-2 mb-2">
      <label class="form-check fw-semibold"><input class="form-check-input reject-type-check" type="checkbox"> ${escapeHtml(typeName)}</label>
      ${entries.map(entry => `<label class="form-check ms-3 small"><input class="form-check-input reject-expense-check" type="checkbox" value="${entry.id}"> ${escapeHtml(entry.category)} (${formatCurrency(entry.amount)})</label>`).join('')}
    </div>`).join('');
  const missingHtml = missingTypes.map(type => `
    <div class="border rounded p-2 mb-2 border-warning-subtle bg-warning-subtle">
      <label class="form-check fw-semibold"><input class="form-check-input reject-missing-type-check" type="checkbox" value="${escapeHtml(type.id)}"> ${escapeHtml(type.displayText || type.name)} <span class="badge bg-warning text-dark ms-1">no entry recorded</span></label>
    </div>`).join('');
  document.getElementById('rejectTargets').innerHTML = groupsHtml + missingHtml ||
    '<div class="text-muted small">No editable daily expense categories on this date.</div>';
  document.querySelectorAll('.reject-type-check').forEach(typeCheck => typeCheck.addEventListener('change', () => {
    typeCheck.closest('.border').querySelectorAll('.reject-expense-check').forEach(check => { check.checked = typeCheck.checked; });
  }));
  document.querySelectorAll('.reject-expense-check').forEach(check => check.addEventListener('change', () => {
    const typeCheck = check.closest('.border').querySelector('.reject-type-check');
    const checks = [...check.closest('.border').querySelectorAll('.reject-expense-check')];
    typeCheck.checked = checks.every(item => item.checked);
    typeCheck.indeterminate = !typeCheck.checked && checks.some(item => item.checked);
  }));
  bootstrap.Modal.getOrCreateInstance(document.getElementById('rejectModal')).show();
}

async function confirmReject() {
  const reason = document.getElementById('rejectReason').value.trim();
  if (!reason) { showNotification('Please enter a rejection reason.', 'warning'); return; }
  const expenseIds = [...document.querySelectorAll('.reject-expense-check:checked')].map(check => check.value);
  const missingTypeIds = [...document.querySelectorAll('.reject-missing-type-check:checked')].map(check => check.value);
  if (!expenseIds.length && !missingTypeIds.length) { showNotification('Select at least one category or category type.', 'warning'); return; }
  try {
    await api('POST', '/expenses/reject/' + pendingRejectDate, { reason, expenseIds, missingTypeIds, mode: pendingRejectMode });
    bootstrap.Modal.getInstance(document.getElementById('rejectModal')).hide();
    showNotification('Expense rejected. Cashier will be notified on their next login.');
    allExpenses = await api('GET', '/expenses');
    await loadSelectedExpenseReport();
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
  const typeContainer = document.getElementById('typeFilterChips');
  const selected = getSelectedCats();
  const selectedTypeIds = getSelectedTypeIds();
  const showDaily = isReportSectionVisible('dailyCashReportSection');
  const showOccasional = isReportSectionVisible('occasionalReportSection');
  const types = allCategoryTypes
    .filter(type => type.status === 'Active' &&
      ((showDaily && normalizeWorkflow(type.workflow) !== 'Occasional') ||
        (showOccasional && normalizeWorkflow(type.workflow) === 'Occasional')))
    .sort((first, second) => (first.sortOrder || 0) - (second.sortOrder || 0));

  typeContainer.innerHTML = types.map(type => `<button type="button" class="btn btn-sm btn-outline-secondary type-chip"
    data-type-id="${escapeHtml(type.id)}" onclick="toggleTypeChip(this)">${escapeHtml(type.displayText || type.name)}</button>`).join('') ||
    '<span class="text-muted small">No category types</span>';
  typeContainer.querySelectorAll('.type-chip').forEach(chip => {
    if (selectedTypeIds.includes(chip.dataset.typeId)) toggleChip(chip);
  });

  const groups = types.map(type => {
    const categories = allCategories
      .filter(category => category.status === 'Active' && categoryTypeId(category) === type.id &&
        (!selectedTypeIds.length || selectedTypeIds.includes(type.id)))
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

function getSelectedTypeIds() {
  return [...document.querySelectorAll('.type-chip.active-chip')].map(chip => chip.dataset.typeId);
}

function categoryTypeId(category) {
  if (category.typeId) return category.typeId;
  const generalType = allCategoryTypes.find(type => type.name === 'General') || allCategoryTypes[0];
  return generalType?.id || '';
}

function expenseTypeId(expense) {
  if (expense.typeId) return expense.typeId;
  const category = allCategories.find(item => item.name === expense.category);
  return category ? categoryTypeId(category) : categoryTypeId({});
}

function toggleTypeChip(chip) {
  toggleChip(chip);
  document.querySelectorAll('.cat-chip.active-chip').forEach(toggleChip);
  buildCatFilterChips();
}

/* ---- Summary table ---- */

function renderSummary() {
  if (!document.getElementById('categoryBalancesReportSection')?.hidden) renderCategoryBalances();
  const from = document.getElementById('fDateFrom').value;
  const to   = document.getElementById('fDateTo').value;
  const selectedCats = getSelectedCats();
  const selectedTypeIds = getSelectedTypeIds();
  const dailyVisible = isReportSectionVisible('dailyCashReportSection');
  const occasionalVisible = isReportSectionVisible('occasionalReportSection');

  const matchesFilters = expense => {
    if (from && expense.date < from) return false;
    if (to && expense.date > to) return false;
    if (selectedTypeIds.length > 0 && !selectedTypeIds.includes(expenseTypeId(expense))) return false;
    if (selectedCats.length > 0 && !selectedCats.includes(expense.category)) return false;
    return true;
  };

  const source = reportExpenseRows || allExpenses;
  const occasionalEntries = source.filter(e => e.mode === 'Occasional' && matchesFilters(e));
  if (occasionalVisible) renderOccasionalSummary(occasionalEntries);

  const filtered = source.filter(e => e.mode !== 'Occasional' && matchesFilters(e));
  const reportEntries = [
    ...(dailyVisible ? filtered : []),
    ...(occasionalVisible ? occasionalEntries : [])
  ];
  const includeTypes = document.getElementById('reportIncludeTypes');
  if (!includeTypes || includeTypes.checked) renderCategoryTypeSummary(reportEntries);
  else document.getElementById('categoryTypeReportSection').style.display = 'none';
  const includeQuantities = document.getElementById('reportIncludeQuantities');
  if (!includeQuantities || includeQuantities.checked) renderQuantitySummary(reportEntries);
  else document.getElementById('quantityReportSection').style.display = 'none';

  renderReportChart(reportEntries);

  if (!dailyVisible) return;

  const byDate = {};
  filtered.forEach(e => {
    if (!byDate[e.date]) byDate[e.date] = { cats: {}, catTypes: {}, status: e.approvalStatus, submittedBy: e.submittedBy, approvers: new Set() };
    if (e.category || (parseFloat(e.amount) || 0) > 0) {
      const k = e.category || 'Other';
      byDate[e.date].cats[k] = (byDate[e.date].cats[k] || 0) + (parseFloat(e.amount) || 0);
      (byDate[e.date].catTypes[k] = byDate[e.date].catTypes[k] || new Set()).add(expenseTypeId(e));
    }
    // Pending takes priority in status display
    if (e.approvalStatus === 'Pending') byDate[e.date].status = 'Pending';
    if (e.approvalStatus === 'Rejected') byDate[e.date].status = 'Rejected';
    if ((e.approvalStatus === 'Approved' || e.approvalStatus === 'AutoApproved') && e.approvedBy) byDate[e.date].approvers.add(e.approvedBy);
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
      .map(([k, v]) => {
        return `<span class="badge bg-light text-dark border me-1 mb-1">${escapeHtml(k)}: ${formatCurrency(v)}</span>`;
      })
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
        ${entry.approvers.size ? '<div class="text-muted" style="font-size:.75rem">approved by ' + [...entry.approvers].map(escapeHtml).join(', ') + '</div>' : ''}
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

function renderQuantitySummary(entries) {
  const section = document.getElementById('quantityReportSection');
  const body = document.getElementById('quantityReportBody');
  const foot = document.getElementById('quantityReportFoot');
  const summary = document.getElementById('quantityReportSummary');
  const expenseIds = new Set(entries.map(entry => entry.id));
  const totals = new Map();
  (reportQuantityRows || allExpenseQuantities).filter(quantity => expenseIds.has(quantity.expenseId)).forEach(quantity => {
    const key = `${quantity.name}|${quantity.unit}`;
    if (!totals.has(key)) totals.set(key, { name: quantity.name, unit: quantity.unit, expenses: 0, amount: 0, cost: 0, pricedAmount: 0 });
    const total = totals.get(key);
    const amount = parseFloat(quantity.amount) || 0;
    total.expenses += 1;
    total.amount += amount;
    if (quantity.unitPrice > 0) {
      total.cost += quantity.totalAmount !== '' && quantity.totalAmount != null ? Number(quantity.totalAmount) : amount * quantity.unitPrice;
      total.pricedAmount += amount;
    }
  });
  const rows = [...totals.values()].sort((first, second) => first.name.localeCompare(second.name));
  section.style.display = rows.length ? '' : 'none';
  summary.textContent = `${rows.length} quantity ${rows.length === 1 ? 'type' : 'types'}`;
  body.innerHTML = rows.length ? rows.map(row => {
    const average = row.pricedAmount > 0 ? `${formatCurrency(row.cost / row.pricedAmount)} / ${escapeHtml(row.unit)}` : '—';
    const partial = row.pricedAmount > 0 && row.pricedAmount < row.amount - 0.0001 ? `<div class="text-muted small fw-normal">Based on ${+row.pricedAmount.toFixed(2)} of ${+row.amount.toFixed(2)} ${escapeHtml(row.unit)}</div>` : '';
    return `<tr><td data-label="Quantity" class="fw-semibold">${escapeHtml(row.name)}</td>
    <td data-label="Unit">${escapeHtml(row.unit)}</td><td data-label="Expenses" class="text-end">${row.expenses}</td>
    <td data-label="Total" class="text-end fw-semibold">${row.amount}</td>
    <td data-label="Avg price / unit" class="text-end">${average}${partial}</td></tr>`;
  }).join('') : emptyRow(4, 'No expenses in this range.');
  foot.innerHTML = rows.length ? `<tr class="fw-bold"><td colspan="2">Total</td><td class="text-end">${rows.reduce((sum, row) => sum + row.expenses, 0)}</td><td></td><td></td></tr>` : '';
}

function renderCategoryTypeSummary(entries) {
  const section = document.getElementById('categoryTypeReportSection');
  const body = document.getElementById('categoryTypeReportBody');
  const foot = document.getElementById('categoryTypeReportFoot');
  const summary = document.getElementById('categoryTypeReportSummary');
  const typeNames = new Map(allCategoryTypes.map(type => [type.id, type.displayText || type.name]));
  const byType = new Map();

  entries.forEach(expense => {
    const typeName = typeNames.get(expense.typeId) || 'Unassigned type';
    if (!byType.has(typeName)) byType.set(typeName, { entries: 0, categories: new Set(), amount: 0 });
    const total = byType.get(typeName);
    total.entries += 1;
    total.categories.add(expense.category || 'Other');
    total.amount += parseFloat(expense.amount) || 0;
  });

  const rows = [...byType.entries()].sort(([, first], [, second]) => second.amount - first.amount);
  const totalAmount = rows.reduce((sum, [, total]) => sum + total.amount, 0);
  section.style.display = rows.length ? '' : 'none';
  summary.textContent = `${formatCurrency(totalAmount)} · ${rows.length} type${rows.length === 1 ? '' : 's'}`;
  body.innerHTML = rows.length ? rows.map(([typeName, total]) => `<tr>
    <td data-label="Category type" class="fw-semibold">${escapeHtml(typeName)}</td>
    <td data-label="Entries" class="text-end">${total.entries}</td>
    <td data-label="Categories" class="text-end">${total.categories.size}</td>
    <td data-label="Amount" class="text-end fw-semibold">${formatCurrency(total.amount)}</td>
  </tr>`).join('') : emptyRow(4, 'No expenses in this range.');
  foot.innerHTML = rows.length ? `<tr style="background:#f0f9ff;border-top:2px solid #bae6fd;">
    <td class="fw-bold text-primary">Total</td><td class="text-end fw-bold">${entries.length}</td>
    <td class="text-end fw-bold">${new Set(entries.map(expense => expense.category || 'Other')).size}</td>
    <td class="text-end fw-bold text-primary">${formatCurrency(totalAmount)}</td>
  </tr>` : '';
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
      <td colspan="4">${formatDate(expense.date)}</td>
      <td class="text-end">${isSuperUser() || canAccess('expenses', 'approve') ?
        `<button class="btn btn-sm btn-success btn-action me-1" onclick="approveDate('${expense.date}', 'Occasional')" title="Approve occasional"><i class="bi bi-check-lg"></i></button><button class="btn btn-sm btn-danger btn-action" onclick="openRejectModal('${expense.date}', 'Occasional')" title="Reject occasional"><i class="bi bi-x-lg"></i></button>` : ''}</td>
      <td class="text-end">${formatCurrency(totalByDate.get(expense.date))}</td></tr>`;
    lastDate = expense.date;
    return header + `<tr>
      <td data-label="Date" class="text-nowrap small">${formatDate(expense.date)}</td>
      <td data-label="Category" class="fw-semibold">${escapeHtml(expense.category)}</td>
      <td data-label="Type">${escapeHtml(typeNames.get(expense.typeId) || 'Unknown')}</td>
      <td data-label="Remarks" class="text-muted">${escapeHtml(expense.description || '—')}
        ${expense.submittedBy ? `<div style="font-size:.75rem">created by ${escapeHtml(expense.submittedBy)}</div>` : ''}
        ${expense.updatedBy ? `<div style="font-size:.75rem">last updated by ${escapeHtml(expense.updatedBy)}${expense.updatedAt ? ` · ${formatDate(expense.updatedAt)}` : ''}</div>` : ''}</td>
      <td data-label="Status">${approvalStatusBadge(expense.approvalStatus)}${expense.approvedBy ? `<div class="text-muted" style="font-size:.75rem">approved by ${escapeHtml(expense.approvedBy)}${expense.approvedAt ? ` · ${formatDate(expense.approvedAt)}` : ''}</div>` : ''}</td>
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
