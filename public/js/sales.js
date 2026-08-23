let salesToday = null;
let originalSalesValues = { morning: 0, afternoon: 0, dinner: 0 };
let salesConfig = { paymentTypes: ['Cash'], onlineVendors: [] };
let salesEntries = [];
let salesExpensesByShift = {};
const SHIFT_LABELS = ['Morning', 'Afternoon', 'Night'];
const ONLINE_VENDOR_PAYMENT_TYPE = 'OnlineVendor';
const normalizeShift = shift => {
  const value = String(shift || '').trim().toLowerCase();
  if (value === 'dinner') return 'Night';
  if (value === 'morning') return 'Morning';
  if (value === 'afternoon') return 'Afternoon';
  if (value === 'night') return 'Night';
  return String(shift || '').trim();
};
const salesTodayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const formatAuditDateTime = value => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
let paymentTypeHistoryModal = null;

function calculateRemainingSales(entries) {
  return (entries || []).reduce((total, entry) => {
    const amount = Number(entry.amount) || 0;
    return total + (entry.paymentType?.toLowerCase() === 'cash'
      ? amount - (Number(salesExpensesByShift[entry.shift]) || 0)
      : amount);
  }, 0);
}

function renderPaymentTypeSummary(targetEl, entries, shiftExpenses = {}) {
  if (!targetEl) return;
  const paymentTypes = ['Cash', ...salesConfig.paymentTypes.filter(type => type.toLowerCase() !== 'cash')];
  if (salesConfig.onlineVendors.length && !paymentTypes.includes(ONLINE_VENDOR_PAYMENT_TYPE)) paymentTypes.push(ONLINE_VENDOR_PAYMENT_TYPE);
  const shifts = [...SHIFT_LABELS, ...(entries || []).some(entry => entry.shift === 'Day') ? ['Day Online'] : []];
  const getShift = entry => entry.shift === 'Day' ? 'Day Online' : entry.shift;
  const values = new Map(shifts.map(shift => [shift, new Map(paymentTypes.map(type => [type, 0]))]));
  (entries || []).forEach(entry => {
    const shift = getShift(entry);
    const paymentType = entry.paymentType || 'Cash';
    if (values.has(shift) && values.get(shift).has(paymentType)) values.get(shift).set(paymentType, values.get(shift).get(paymentType) + (Number(entry.amount) || 0));
  });
  const table = targetEl.closest('table');
  if (table) table.querySelector('thead').innerHTML = `<tr><th>Shift</th><th>Expenses</th><th>Cash Payment</th><th>Cash Remaining</th>${paymentTypes.filter(type => type !== 'Cash').map(type => `<th>${type}</th>`).join('')}<th>Total Remaining</th><th>Total Sales</th></tr>`;
  targetEl.innerHTML = shifts.map(shift => {
    const row = values.get(shift);
    const expenses = shift === 'Day Online' ? 0 : (Number(shiftExpenses[shift]) || 0);
    const cashPayment = row.get('Cash');
    const cashRemaining = shift === 'Day Online' ? 0 : cashPayment - expenses;
    const otherPayments = [...row.entries()]
      .filter(([paymentType]) => paymentType !== 'Cash')
      .reduce((sum, [, amount]) => sum + amount, 0);
    const remaining = cashRemaining + otherPayments;
    const total = cashPayment + otherPayments;
    return `<tr><td data-label="Shift" class="fw-semibold">${shift}</td><td data-label="Expenses">${formatCurrency(expenses)}</td><td data-label="Cash Payment">${formatCurrency(cashPayment)}</td><td data-label="Cash Remaining">${formatCurrency(cashRemaining)}</td>${paymentTypes.filter(type => type !== 'Cash').map(type => `<td data-label="${type}">${formatCurrency(row.get(type))}</td>`).join('')}<td data-label="Total Remaining">${formatCurrency(remaining)}</td><td data-label="Total Sales" class="text-success fw-semibold">${formatCurrency(total)}</td></tr>`;
  }).join('');
}

function renderShiftSummaryRows(targetEl, shiftExpenses, remainingByShift, dayOnlineTotal = 0) {
  if (!targetEl) return;
  const rows = SHIFT_LABELS.map(shift => {
    const legacyShift = shift === 'Night' ? 'Dinner' : shift;
    const expense = shiftExpenses?.[shift] ?? shiftExpenses?.[legacyShift] ?? 0;
    const remaining = remainingByShift?.[shift] ?? 0;
    return `<tr><td data-label="Shift" class="fw-semibold">${shift}</td><td data-label="Shift expenses">${formatCurrency(expense)}</td><td data-label="Remaining sales">${formatCurrency(remaining)}</td><td data-label="Total sales" class="fw-semibold text-success">${formatCurrency(expense + remaining)}</td></tr>`;
  });
  if (dayOnlineTotal > 0) {
    rows.push(`<tr><td data-label="Shift" class="fw-semibold">Day Online</td><td data-label="Shift expenses">${formatCurrency(0)}</td><td data-label="Remaining sales">${formatCurrency(dayOnlineTotal)}</td><td data-label="Total sales" class="fw-semibold text-success">${formatCurrency(dayOnlineTotal)}</td></tr>`);
  }
  targetEl.innerHTML = rows.join('');
}

function ensurePaymentTypeHistoryUI() {
  const saveBtn = document.getElementById('saveSales');
  if (!saveBtn || document.getElementById('openPaymentTypeHistory')) return;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = 'openPaymentTypeHistory';
  trigger.className = 'btn btn-sm btn-outline-secondary mt-2';
  trigger.innerHTML = '<i class="bi bi-clock-history me-1"></i>Payment Type History';
  saveBtn.insertAdjacentElement('afterend', trigger);

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<div class="modal fade" id="paymentTypeHistoryModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog modal-lg modal-dialog-scrollable"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">Payment Type History</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body"><div class="row g-2 align-items-end mb-3"><div class="col-12 col-md-6"><label class="form-label">Payment Type</label><select id="historyPaymentType" class="form-select"></select></div><div class="col-8 col-md-3"><label class="form-label">Days</label><input id="historyDays" type="number" min="1" max="90" value="30" class="form-control"></div><div class="col-4 col-md-3"><button id="loadPaymentTypeHistory" class="btn btn-primary w-100" type="button">Load</button></div></div><div class="table-responsive mb-3"><table class="table mobile-grid-table shift-summary-table"><thead><tr><th>Shift</th><th>Shift Expenses</th><th>Remaining Sales</th><th>Total Sales</th></tr></thead><tbody id="historyShiftSummaryRows"></tbody></table></div><div class="table-responsive"><table class="table mobile-grid-table"><thead><tr><th>Date</th><th>Shift</th><th>Amount</th><th>Updated By</th><th>Updated At</th></tr></thead><tbody id="historyRows"></tbody></table></div></div></div></div></div>`;
  document.body.appendChild(wrapper.firstElementChild);

  trigger.addEventListener('click', async () => {
    await populatePaymentTypeHistoryOptions();
    if (!paymentTypeHistoryModal) paymentTypeHistoryModal = new bootstrap.Modal(document.getElementById('paymentTypeHistoryModal'));
    paymentTypeHistoryModal.show();
  });
  document.getElementById('loadPaymentTypeHistory').addEventListener('click', loadPaymentTypeHistory);
}

async function populatePaymentTypeHistoryOptions() {
  const select = document.getElementById('historyPaymentType');
  if (!select) return;
  const options = [...salesConfig.paymentTypes];
  if (!options.includes(ONLINE_VENDOR_PAYMENT_TYPE)) options.push(ONLINE_VENDOR_PAYMENT_TYPE);
  const current = select.value;
  select.innerHTML = options.map(type => `<option value="${type}">${type}</option>`).join('');
  if (options.includes(current)) select.value = current;
  if (!select.value && options.length) select.value = options[0];
  await loadPaymentTypeHistory();
}

async function loadPaymentTypeHistory() {
  const rowsEl = document.getElementById('historyRows');
  const summaryEl = document.getElementById('historyShiftSummaryRows');
  const paymentType = document.getElementById('historyPaymentType')?.value || '';
  const days = parseInt(document.getElementById('historyDays')?.value, 10) || 30;
  if (!rowsEl || !summaryEl || !paymentType) return;
  renderShiftSummaryRows(summaryEl, { Morning: 0, Afternoon: 0, Night: 0 }, { Morning: 0, Afternoon: 0, Night: 0 }, 0);
  rowsEl.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">Loading...</td></tr>';
  try {
    const history = await api('GET', `/sales-entries/history?paymentType=${encodeURIComponent(paymentType)}&days=${encodeURIComponent(String(days))}`);
    const remainingByShift = SHIFT_LABELS.reduce((acc, shift) => {
      acc[shift] = history.filter(row => normalizeShift(row.shift) === shift).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
      return acc;
    }, {});
    const dayOnlineTotal = history.filter(row => normalizeShift(row.shift) === 'Day').reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    renderShiftSummaryRows(summaryEl, { Morning: 0, Afternoon: 0, Night: 0 }, remainingByShift, dayOnlineTotal);
    if (!history.length) {
      rowsEl.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">No history found.</td></tr>';
      return;
    }
    rowsEl.innerHTML = history.map(row => `<tr><td data-label="Date">${row.date || '-'}</td><td data-label="Shift">${row.shift || '-'}</td><td data-label="Amount">${formatCurrency(row.amount)}</td><td data-label="Updated by">${row.enteredBy || '-'}</td><td data-label="Updated at">${formatAuditDateTime(row.updatedAt || row.createdAt)}</td></tr>`).join('');
  } catch (error) {
    rowsEl.innerHTML = `<tr><td colspan="5" class="text-danger text-center py-3">${error.message}</td></tr>`;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user || !canAccess('sales')) { window.location.href = '/expenses.html'; return; }
  const superUser = isSuperUser();
  document.body.classList.toggle('cashier-sales-view', !superUser);
  if (superUser) {
    const row = document.querySelector('.row.g-3');
    const summaryCol = document.getElementById('superSummary');
  }
  const dateInput = document.getElementById('salesDate');
  dateInput.value = salesTodayKey; dateInput.max = salesTodayKey; dateInput.disabled = !superUser;
  if (!superUser) {
    dateInput.closest('.card-panel')?.classList.add('d-none');
    document.querySelector('.sales-remaining-box')?.classList.add('d-none');
  }
  await loadSalesConfiguration();
  if (superUser) ensurePaymentTypeHistoryUI();
  dateInput.addEventListener('change', async () => {
    await loadSales();
    if (superUser) await loadSummary();
  });
  document.getElementById('saveSales')?.addEventListener('click', saveSales);
  if (!superUser) {
    document.getElementById('superSummaryRow')?.remove();
  }
  await loadSales();
  if (superUser) await loadSummary();
});

async function loadSales() {
  const date = document.getElementById('salesDate').value;
  try {
    salesToday = await api('GET', `/sales?date=${encodeURIComponent(date)}`);
    salesEntries = (await api('GET', `/sales-entries?date=${encodeURIComponent(date)}`)).map(entry => ({ ...entry, shift: normalizeShift(entry.shift) }));
    salesExpensesByShift = salesToday.summary?.shiftExpenses || salesToday.shiftExpenses || {};
    const dateLabel = document.getElementById('salesDateLabel');
    if (dateLabel) dateLabel.textContent = date === salesTodayKey ? 'Today' : new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    renderSalesShiftCards();
  } catch (error) { showNotification('Failed to load sales: ' + error.message, 'danger'); }
}

function updateCashierTotal() {
  document.querySelectorAll('.sales-entry-value[data-cash-expense]').forEach(input => {
    const label = input.parentElement.querySelector('.sales-entry-after-expense');
    if (label) label.textContent = `After expenses: ${formatCurrency((parseFloat(input.value) || 0) - (parseFloat(input.dataset.cashExpense) || 0))}`;
  });
  refreshSalesShiftTotals();
}

async function loadSalesConfiguration() {
  const config = await api('GET', '/config');
  salesConfig.paymentTypes = config.paymentTypes?.length ? config.paymentTypes : ['Cash'];
  salesConfig.onlineVendors = config.onlineVendors || [];
}

function renderSalesShiftCards() {
  const container = document.getElementById('salesShiftCards');
  if (!container) return;
  const otherTypes = salesConfig.paymentTypes.filter(type => type.toLowerCase() !== 'cash');
  container.innerHTML = SHIFT_LABELS.map(shift => {
    const cash = salesEntries.find(entry => entry.shift === shift && entry.paymentType.toLowerCase() === 'cash') || {};
    const expense = Number(salesExpensesByShift[shift]) || 0;
    const otherFields = otherTypes.map(type => {
      const entry = salesEntries.find(item => item.shift === shift && item.paymentType === type) || {};
      return `<div class="mb-2"><label class="form-label">${type}</label><input type="number" class="form-control sales-entry-value" data-shift="${shift}" data-payment-type="${type}" min="0" step="0.01" placeholder="0" value="${entry.amount || ''}"></div>`;
    }).join('');
    return `<div class="col-12 col-md-4"><section class="card-panel sales-shift-card"><div class="card-panel-header"><h6 class="card-panel-title">${shift} Sales</h6><span class="badge bg-warning-subtle text-warning">Expense: ${formatCurrency(expense)}</span></div><div class="card-panel-body"><label class="form-label">Total Cash Payment</label><input type="number" class="form-control sales-entry-value" data-shift="${shift}" data-payment-type="Cash" data-cash-expense="${expense}" min="0" step="0.01" placeholder="0" value="${cash.amount || ''}"><div class="sales-entry-after-expense text-muted small mt-1">After expenses: ${formatCurrency((Number(cash.amount) || 0) - expense)}</div><div class="mt-3 pt-2 border-top"><div class="small fw-semibold text-muted mb-2">Other Payment Types</div>${otherFields || '<div class="small text-muted">No other payment types configured.</div>'}</div><div class="sales-shift-total mt-3 pt-2 border-top" data-shift-total="${shift}"></div></div></section></div>`;
  }).join('');
  container.querySelectorAll('.sales-entry-value').forEach(input => input.addEventListener('input', updateCashierTotal));
  refreshSalesShiftTotals();
}

function refreshSalesShiftTotals() {
  document.querySelectorAll('[data-shift-total]').forEach(totalEl => {
    const shift = totalEl.dataset.shiftTotal;
    const values = [...document.querySelectorAll(`.sales-entry-value[data-shift="${shift}"]`)].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
    totalEl.textContent = `Shift total entered: ${formatCurrency(values)}`;
  });
}

async function saveSales() {
  const entries = [...document.querySelectorAll('.sales-entry-value')].map(input => {
    const directVendor = input.dataset.onlineVendor || '';
    return {
      shift: input.dataset.shift,
      paymentType: input.dataset.paymentType,
      onlineVendor: directVendor,
      amount: input.value
    };
  }).filter(entry => Number(entry.amount) > 0);
  if (!entries.length) return showNotification('Enter at least one sales amount.', 'warning');
  try { await api('POST', '/sales-entries', { date: document.getElementById('salesDate').value, entries }); showNotification('Sales saved.'); await loadSales(); if (isSuperUser()) await loadSummary(); }
  catch (error) { showNotification('Save failed: ' + error.message, 'danger'); }
}

async function loadSummary() {
  try {
    const date = document.getElementById('salesDate').value;
    const [data, entryRows] = await Promise.all([
      api('GET', `/sales?date=${encodeURIComponent(date)}`),
      api('GET', `/sales-entries?date=${encodeURIComponent(date)}`)
    ]);
    const entryRowsForDate = entryRows.filter(row => row.date === date).map(row => ({ ...row, shift: normalizeShift(row.shift) }));
    const remainingSales = calculateRemainingSales(entryRowsForDate);
    const totalSales = data.summary.expenseTotal + remainingSales;
    document.getElementById('summarySales').textContent = formatCurrency(totalSales);
    document.getElementById('summaryExpenses').textContent = formatCurrency(data.summary.expenseTotal);
    document.getElementById('summaryRemaining').textContent = formatCurrency(remainingSales);
    const cashierRemaining = document.getElementById('cashierRemaining');
    if (cashierRemaining) cashierRemaining.textContent = formatCurrency(remainingSales);
      let shiftSummary = document.getElementById('shiftSummary');
      let salesEntryAuditRows = document.getElementById('salesEntryAuditRows');
      if (!shiftSummary) {
        const detailBody = document.getElementById('salesRows');
        const detailTable = detailBody?.closest('.table-responsive');
        if (detailTable) {
          const summaryTable = document.createElement('div');
          summaryTable.className = 'table-responsive mb-3';
          summaryTable.innerHTML = '<table class="table mobile-grid-table shift-summary-table mb-3"><thead><tr><th>Shift</th><th>Expenses</th><th>Cash Payment</th><th>Cash Remaining</th><th>Total Remaining</th><th>Total Sales</th></tr></thead><tbody id="shiftSummary"></tbody></table><table class="table mobile-grid-table sales-audit-table"><thead><tr><th>Shift</th><th>Payment Type</th><th>Online Vendor</th><th>Amount</th><th>Last Updated By</th><th>Last Updated At</th></tr></thead><tbody id="salesEntryAuditRows"></tbody></table>';
          detailTable.before(summaryTable);
          shiftSummary = summaryTable.querySelector('#shiftSummary');
          salesEntryAuditRows = summaryTable.querySelector('#salesEntryAuditRows');
          detailTable.remove();
        }
      }
      if (shiftSummary) {
        renderPaymentTypeSummary(shiftSummary, entryRowsForDate, data.summary.shiftExpenses);
      }
      if (salesEntryAuditRows) {
        if (!entryRowsForDate.length) {
          salesEntryAuditRows.innerHTML = '<tr><td colspan="6" class="text-muted text-center py-3">No sales entries for this date.</td></tr>';
        } else {
          const shiftOrder = { Morning: 0, Afternoon: 1, Night: 2, Day: 3 };
          const sortedEntries = [...entryRowsForDate].sort((a, b) => {
            const shiftDelta = (shiftOrder[a.shift] ?? 99) - (shiftOrder[b.shift] ?? 99);
            if (shiftDelta !== 0) return shiftDelta;
            const paymentDelta = String(a.paymentType || '').localeCompare(String(b.paymentType || ''));
            if (paymentDelta !== 0) return paymentDelta;
            return String(a.onlineVendor || '').localeCompare(String(b.onlineVendor || ''));
          });
          salesEntryAuditRows.innerHTML = sortedEntries.map(row => `<tr><td data-label="Shift">${row.shift || '-'}</td><td data-label="Payment type">${row.paymentType || '-'}</td><td data-label="Online vendor">${row.onlineVendor || '-'}</td><td data-label="Amount">${formatCurrency(row.amount)}</td><td data-label="Last updated by">${row.enteredBy || '-'}</td><td data-label="Last updated at">${formatAuditDateTime(row.updatedAt || row.createdAt)}</td></tr>`).join('');
        }
      }
  } catch (error) { showNotification('Failed to load sales summary: ' + error.message, 'danger'); }
}
