/* expenses.js */

let allExpenses = [];
let allCategories = [];
let pendingRejectDate = null;

const today = new Date().toISOString().split('T')[0];

document.addEventListener('DOMContentLoaded', async () => {
  // Auth guard
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('expenses')) { window.location.href = '/index.html'; return; }

  document.getElementById('expDate').value = today;

  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString().split('T')[0];
  document.getElementById('fDateFrom').value = firstOfMonth;
  document.getElementById('fDateTo').value = today;

  document.getElementById('expDate').addEventListener('change', function () {
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
    [allCategories, allExpenses] = await Promise.all([
      api('GET', '/categories'),
      api('GET', '/expenses')
    ]);
    loadDateIntoForm(today);
  } catch (err) {
    showNotification('Error loading data: ' + err.message, 'danger');
  }
});

/* ---- Load a date into the entry form ---- */

function loadDateIntoForm(date) {
  const existing = getExistingForDate(date);
  const hasData = Object.keys(existing).length > 0;
  const isToday = date === today;

  document.getElementById('formTitle').innerHTML =
    '<i class="bi bi-pencil-square me-2"></i>Expense';

  const badge = document.getElementById('formBadge');
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

  // Show rejection notice if cashier sees a rejected date
  const rejectedRow = allExpenses.find(e => e.date === date && e.approvalStatus === 'Rejected');
  const noticeEl = document.getElementById('rejectionNotice');
  if (rejectedRow && !isSuperUser()) {
    noticeEl.innerHTML =
      '<i class="bi bi-exclamation-triangle-fill me-2"></i><strong>Rejected:</strong> ' +
      (rejectedRow.rejectionReason || 'Please correct and resubmit.') +
      ' <em class="text-muted small">— ' + rejectedRow.approvedBy + '</em>';
    noticeEl.style.display = '';
  } else {
    noticeEl.style.display = 'none';
  }

  buildCategoryInputs(existing);
  updateTotal();
}

function getExistingForDate(date) {
  const map = {};
  allExpenses.filter(e => e.date === date).forEach(e => {
    if (e.category) map[e.category] = (map[e.category] || 0) + (parseFloat(e.amount) || 0);
  });
  return map;
}

/* ---- Category inputs ---- */

function buildCategoryInputs(existingMap) {
  existingMap = existingMap || {};
  const active = allCategories
    .filter(c => c.status === 'Active')
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const container = document.getElementById('categoryInputs');

  if (!active.length) {
    container.innerHTML = '<div class="text-center text-muted py-3">No active categories. <a href="/categories.html">Manage</a></div>';
    return;
  }

  const items = active.map(c => {
    const val = existingMap[c.name] > 0 ? existingMap[c.name] : '';
    return '<div class="d-flex align-items-center gap-3 py-2 border-bottom">' +
      '<span class="fw-medium flex-grow-1" style="font-size:1rem">' + c.name + '</span>' +
      '<div class="input-group" style="width:160px;flex-shrink:0">' +
      '<span class="input-group-text fw-semibold" style="font-size:1rem">&#8377;</span>' +
      '<input type="number" class="form-control cat-amount" data-category="' + c.name + '" ' +
      'min="0" step="0.01" placeholder="0" value="' + val + '" oninput="updateTotal()" style="font-size:1rem">' +
      '</div></div>';
  }).join('');
  container.innerHTML = '<div>' + items + '</div>';
}

function updateTotal() {
  let total = 0;
  document.querySelectorAll('.cat-amount').forEach(inp => {
    total += parseFloat(inp.value) || 0;
  });
  document.getElementById('expRunningTotal').textContent = formatCurrency(total);
}

/* ---- Save ---- */

async function save() {
  const date = document.getElementById('expDate').value;
  if (!date) { showNotification('Please select a date.', 'warning'); return; }

  const entries = [];
  document.querySelectorAll('.cat-amount').forEach(inp => {
    const amount = parseFloat(inp.value);
    if (amount > 0) entries.push({ category: inp.dataset.category, amount });
  });

  if (!entries.length) { showNotification('Enter at least one amount greater than 0.', 'warning'); return; }

  const remarks = document.getElementById('expRemarks').value.trim();
  const btn = document.getElementById('btnSaveExpense');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';

  try {
    await api('POST', '/expenses/bulk', { date, entries, remarks });
    const msg = isSuperUser() ? 'Expense saved and approved.' : 'Expense submitted for approval.';
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

    let actionBtns = `<button class="btn btn-sm btn-outline-secondary btn-action me-1"
      onclick="editFromReport('${date}')" title="Edit"><i class="bi bi-pencil"></i></button>`;
    if (isSuperUser() && entry.status === 'Pending') {
      actionBtns +=
        `<button class="btn btn-sm btn-success btn-action me-1" onclick="approveDate('${date}')" title="Approve">
          <i class="bi bi-check-lg"></i></button>` +
        `<button class="btn btn-sm btn-danger btn-action" onclick="openRejectModal('${date}')" title="Reject">
          <i class="bi bi-x-lg"></i></button>`;
    }

    return `<tr>
      <td class="fw-semibold text-nowrap small">${formatDate(date)}</td>
      <td><div class="d-flex flex-wrap">${catBadges}</div>
        ${entry.submittedBy ? '<div class="text-muted" style="font-size:.75rem">by ' + entry.submittedBy + '</div>' : ''}
      </td>
      <td class="text-end fw-semibold text-nowrap">${formatCurrency(dayTotal)}</td>
      <td>${statusBadgeHtml}</td>
      <td class="text-center text-nowrap">${actionBtns}</td>
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
