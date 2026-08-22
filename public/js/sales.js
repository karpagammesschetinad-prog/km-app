let salesToday = null;
let originalSalesValues = { morning: 0, afternoon: 0, dinner: 0 };
let salesConfig = { paymentTypes: ['Cash'], onlineVendors: [] };
let salesEntries = [];
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
  trigger.className = 'btn btn-outline-secondary w-100 mt-2';
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
  if (superUser) {
    const row = document.querySelector('.row.g-3');
    const summaryCol = document.getElementById('superSummary');
    const dailySalesCol = row?.querySelector('.col-12.col-lg-5');
    if (row && summaryCol && dailySalesCol) row.insertBefore(summaryCol, dailySalesCol);
  }
  const dateInput = document.getElementById('salesDate');
  dateInput.value = salesTodayKey; dateInput.max = salesTodayKey; dateInput.disabled = !superUser;
  if (!superUser) {
    dateInput.closest('.card-panel')?.classList.add('d-none');
    document.querySelector('.sales-remaining-box')?.classList.add('d-none');
  }
  await loadSalesConfiguration();
  ensurePaymentTypeHistoryUI();
  dateInput.addEventListener('change', async () => {
    await loadSales();
    if (superUser) await loadSummary();
  });
  document.getElementById('saveSales').addEventListener('click', saveSales);
  if (!superUser) document.getElementById('superSummary').remove();
  await loadSales();
  if (superUser) await loadSummary();
});

async function loadSales() {
  const date = document.getElementById('salesDate').value;
  try {
    salesToday = await api('GET', `/sales?date=${encodeURIComponent(date)}`);
    salesEntries = (await api('GET', `/sales-entries?date=${encodeURIComponent(date)}`)).map(entry => ({ ...entry, shift: normalizeShift(entry.shift) }));
    renderSalesEntryGrid();
    document.getElementById('salesDateLabel').textContent = date === salesTodayKey ? 'Today' : new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const row = isSuperUser() ? salesToday.rows?.find(item => item.date === date) : salesToday;
    ['morning', 'afternoon', 'dinner'].forEach(key => { originalSalesValues[key] = row?.[key] || 0; });
    updateCashierTotal();
  } catch (error) { showNotification('Failed to load sales: ' + error.message, 'danger'); }
}

function updateCashierTotal() {
  const totalEl = document.getElementById('cashierRemaining');
  if (!totalEl || !isSuperUser()) return;
  const total = [...document.querySelectorAll('.sales-entry-value')].reduce((sum, input) => sum + (parseFloat(input.value) || 0), 0);
  totalEl.textContent = formatCurrency(total);
}

async function loadSalesConfiguration() {
  const config = await api('GET', '/config');
  salesConfig.paymentTypes = config.paymentTypes?.length ? config.paymentTypes : ['Cash'];
  salesConfig.onlineVendors = config.onlineVendors || [];
}

function renderSalesEntryGrid() {
  const oldInputs = document.querySelectorAll('.sales-shift-input');
  const saveButton = document.getElementById('saveSales');
  const grid = document.getElementById('salesEntryGrid') || document.createElement('div');
  grid.id = 'salesEntryGrid';
  grid.className = 'sales-entry-grid';
  oldInputs.forEach(input => input.remove());
  const entries = salesEntries || [];
  const paymentCells = salesConfig.paymentTypes.map(type => SHIFT_LABELS.map(shift => {
    const matching = entries.find(entry => entry.paymentType === type && entry.shift === shift) || {};
    return `<div class="sales-entry-cell"><label class="form-label">${shift} - ${type}</label><input type="number" class="form-control sales-entry-value mt-1" data-shift="${shift}" data-payment-type="${type}" min="0" step="0.01" placeholder="0" value="${matching.amount || ''}"></div>`;
  }).join('')).join('');
  const vendorCells = salesConfig.onlineVendors.map(vendor => {
    const matching = entries.find(entry => entry.paymentType === ONLINE_VENDOR_PAYMENT_TYPE && entry.shift === 'Day' && entry.onlineVendor === vendor) || {};
    return `<div class="sales-entry-cell"><label class="form-label">Online Vendor - ${vendor}</label><input type="number" class="form-control sales-entry-value mt-1" data-shift="Day" data-payment-type="${ONLINE_VENDOR_PAYMENT_TYPE}" data-online-vendor="${vendor}" min="0" step="0.01" placeholder="0" value="${matching.amount || ''}"></div>`;
  }).join('');
  const vendorSection = salesConfig.onlineVendors.length ? `<div class="col-12 mt-2 mb-1 fw-semibold text-primary">Online Sales By Vendor (Day Basis)</div>${vendorCells}` : '';
  grid.innerHTML = paymentCells + vendorSection;
  saveButton.before(grid);
  document.querySelectorAll('.sales-entry-value').forEach(input => input.addEventListener('input', updateCashierTotal));
  updateCashierTotal();
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
    const remainingByShift = SHIFT_LABELS.reduce((result, shift) => {
      result[shift] = entryRowsForDate.filter(row => row.shift === shift).reduce((sum, row) => sum + row.amount, 0);
      return result;
    }, {});
    const dayOnlineTotal = entryRowsForDate
      .filter(row => row.shift === 'Day' && row.paymentType === ONLINE_VENDOR_PAYMENT_TYPE)
      .reduce((sum, row) => sum + row.amount, 0);
    data.summary.remainingByShift = remainingByShift;
    data.summary.totalSales = Object.values(data.summary.shiftExpenses).reduce((sum, value) => sum + value, 0) + Object.values(remainingByShift).reduce((sum, value) => sum + value, 0) + dayOnlineTotal;
    data.summary.remaining = Object.values(remainingByShift).reduce((sum, value) => sum + value, 0) + dayOnlineTotal;
    document.getElementById('summarySales').textContent = formatCurrency(data.summary.totalSales);
    document.getElementById('summaryExpenses').textContent = formatCurrency(data.summary.expenseTotal);
    document.getElementById('summaryRemaining').textContent = formatCurrency(data.summary.remaining);
      let shiftSummary = document.getElementById('shiftSummary');
      let salesEntryAuditRows = document.getElementById('salesEntryAuditRows');
      if (!shiftSummary) {
        const detailBody = document.getElementById('salesRows');
        const detailTable = detailBody?.closest('.table-responsive');
        if (detailTable) {
          const summaryTable = document.createElement('div');
          summaryTable.className = 'table-responsive mb-3';
          summaryTable.innerHTML = '<table class="table mobile-grid-table shift-summary-table mb-3"><thead><tr><th>Shift</th><th>Shift Expenses</th><th>Remaining Sales</th><th>Total Sales</th></tr></thead><tbody id="shiftSummary"></tbody></table><table class="table mobile-grid-table sales-audit-table"><thead><tr><th>Shift</th><th>Payment Type</th><th>Online Vendor</th><th>Amount</th><th>Last Updated By</th><th>Last Updated At</th></tr></thead><tbody id="salesEntryAuditRows"></tbody></table>';
          detailTable.before(summaryTable);
          shiftSummary = summaryTable.querySelector('#shiftSummary');
          salesEntryAuditRows = summaryTable.querySelector('#salesEntryAuditRows');
          detailTable.remove();
        }
      }
      if (shiftSummary) {
        renderShiftSummaryRows(shiftSummary, data.summary.shiftExpenses, data.summary.remainingByShift, dayOnlineTotal);
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
