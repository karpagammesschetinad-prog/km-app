/* reports.js - Profit & loss with misuse analytics */

let reportData = null;
let occasionalData = null;
let plChart = null;

// Sub-column counts per collapsible group in the daily breakdown table.
const COLUMN_GROUPS = { sales: 2, expenses: 2, salary: 3 };
const BASE_COLUMN_COUNT = 7;
const expandedColumnGroups = new Set();

function plColumnCount() {
  return BASE_COLUMN_COUNT + [...expandedColumnGroups].reduce((sum, key) => sum + (COLUMN_GROUPS[key] || 0), 0);
}

function applyColumnGroups() {
  document.querySelectorAll('#plTable [data-col-group]').forEach(cell => {
    cell.classList.toggle('d-none', !expandedColumnGroups.has(cell.dataset.colGroup));
  });
  document.querySelectorAll('#plTable [data-toggle-group]').forEach(header => {
    const icon = header.querySelector('i');
    if (!icon) return;
    const expanded = expandedColumnGroups.has(header.dataset.toggleGroup);
    icon.className = `bi ${expanded ? 'bi-dash-square' : 'bi-plus-square'} ms-1 small`;
  });
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (user.role !== 'superuser') { window.location.href = '/expenses.html'; return; }

  const today = new Date();
  document.getElementById('fromDate').value = localDateKey(new Date(today.getFullYear(), today.getMonth(), 1));
  document.getElementById('toDate').value = localDateKey(today);
  document.getElementById('fromDate').max = localDateKey(today);
  document.getElementById('toDate').max = localDateKey(today);

  document.getElementById('btnRun').addEventListener('click', loadReport);
  document.getElementById('btnExport').addEventListener('click', exportCsv);
  document.getElementById('btnExportOccasional').addEventListener('click', exportOccasionalCsv);
  document.querySelectorAll('[data-range]').forEach(button => {
    button.addEventListener('click', () => {
      const now = new Date();
      const from = button.dataset.range === 'month'
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
      document.getElementById('fromDate').value = localDateKey(from);
      document.getElementById('toDate').value = localDateKey(now);
      loadReport();
    });
  });

  document.querySelectorAll('#plTable [data-toggle-group]').forEach(header => {
    header.addEventListener('click', () => {
      const group = header.dataset.toggleGroup;
      if (expandedColumnGroups.has(group)) expandedColumnGroups.delete(group);
      else expandedColumnGroups.add(group);
      applyColumnGroups();
    });
  });

  await loadReport();
});

async function loadReport() {
  const from = document.getElementById('fromDate').value;
  const to = document.getElementById('toDate').value;
  if (!from || !to) return showNotification('Select both dates.', 'warning');
  if (from > to) return showNotification('From date must be on or before To date.', 'warning');

  document.getElementById('plBody').innerHTML = loadingRow(plColumnCount());
  document.getElementById('occasionalBody').innerHTML = loadingRow(7);
  try {
    reportData = await api('GET', `/reports/profit-loss?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    renderSummary(reportData.totals);
    renderChart(reportData.days);
    renderTable(reportData.days, reportData.totals);
    renderAnalytics(reportData.analytics);
  } catch (err) {
    document.getElementById('plBody').innerHTML = `<tr><td colspan="${plColumnCount()}" class="text-danger text-center py-3">${escapeHtml(err.message)}</td></tr>`;
    showNotification('Failed to load report: ' + err.message, 'danger');
  }

  try {
    occasionalData = await api('GET', `/reports/occasional?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    renderOccasional(occasionalData);
  } catch (err) {
    document.getElementById('occasionalBody').innerHTML = `<tr><td colspan="7" class="text-danger text-center py-3">${escapeHtml(err.message)}</td></tr>`;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function card(title, value, tone, hint) {
  return `<div class="col-6 col-lg-3"><div class="card-panel h-100"><div class="card-panel-body">
    <div class="text-muted small">${title}</div>
    <div class="fs-5 fw-semibold text-${tone}">${value}</div>
    ${hint ? `<div class="text-muted" style="font-size:.75rem">${hint}</div>` : ''}
  </div></div></div>`;
}

function renderSummary(totals) {
  const expenses = totals.dailyCashExpense + totals.occasionalExpense;
  document.getElementById('summaryCards').innerHTML =
    card('Total Sales', formatCurrency(totals.sales), 'primary',
      `Cash ${formatCurrency(totals.cashSales)} · Online ${formatCurrency(totals.onlineSales)}`) +
    card('Expenses', formatCurrency(expenses), 'warning',
      `Daily cash ${formatCurrency(totals.dailyCashExpense)} · Occasional ${formatCurrency(totals.occasionalExpense)}`) +
    card('Pending Salary', formatCurrency(totals.salaryPending), 'info',
      `Salary ${formatCurrency(totals.salaryGross)} − petta ${formatCurrency(totals.pettaTotal)} − received ${formatCurrency(totals.salaryPaid)}`) +
    card(totals.profit >= 0 ? 'Profit' : 'Loss', formatCurrency(totals.profit), totals.profit >= 0 ? 'success' : 'danger',
      `Market ${formatCurrency(totals.marketExpense)}${totals.margin === null ? '' : ` · Margin ${totals.margin}%`}`);
}

function renderChart(days) {
  const canvas = document.getElementById('plChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (plChart) plChart.destroy();
  plChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: days.map(day => day.date.slice(5)),
      datasets: [
        { label: 'Sales', data: days.map(day => day.sales), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,.12)', fill: true, tension: .3 },
        { label: 'Total Cost', data: days.map(day => day.totalCost), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,.12)', fill: true, tension: .3 },
        { label: 'Profit', data: days.map(day => day.profit), borderColor: '#10b981', tension: .3 }
      ]
    },
    options: { responsive: true, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom' } } }
  });
}

function renderTable(days, totals) {
  const body = document.getElementById('plBody');
  const rows = days.filter(day => day.sales || day.totalCost);
  body.innerHTML = rows.length ? rows.map(day => `<tr>
    <td data-label="Date" class="text-nowrap">${formatDate(day.date)}</td>
    <td data-label="Sales" class="text-end fw-semibold">${formatCurrency(day.sales)}</td>
    <td data-label="Cash" class="text-end" data-col-group="sales">${formatCurrency(day.cashSales)}</td>
    <td data-label="Online" class="text-end" data-col-group="sales">${formatCurrency(day.onlineSales)}</td>
    <td data-label="Expenses" class="text-end">${formatCurrency(day.dailyCashExpense + day.occasionalExpense)}</td>
    <td data-label="Daily Cash Exp" class="text-end" data-col-group="expenses">${formatCurrency(day.dailyCashExpense)}</td>
    <td data-label="Occasional" class="text-end" data-col-group="expenses">${formatCurrency(day.occasionalExpense)}</td>
    <td data-label="Pending Salary" class="text-end">${formatCurrency(day.salaryPending)}</td>
    <td data-label="Salary" class="text-end" data-col-group="salary">${formatCurrency(day.salaryGross)}</td>
    <td data-label="Received" class="text-end" data-col-group="salary">${formatCurrency(day.salaryPaid)}</td>
    <td data-label="Petta" class="text-end" data-col-group="salary">${formatCurrency(day.pettaTotal)}</td>
    <td data-label="Market (from this day's cash)" class="text-end">${formatCurrency(day.marketExpense)}</td>
    <td data-label="Total Cost" class="text-end">${formatCurrency(day.totalCost)}</td>
    <td data-label="Profit" class="text-end fw-semibold ${day.profit >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(day.profit)}</td>
  </tr>`).join('') : emptyRow(plColumnCount(), 'No sales or costs in this range.');

  document.getElementById('plFoot').innerHTML = rows.length ? `<tr class="fw-bold" style="background:#f0f9ff">
    <td>Total</td>
    <td class="text-end">${formatCurrency(totals.sales)}</td>
    <td class="text-end" data-col-group="sales">${formatCurrency(totals.cashSales)}</td>
    <td class="text-end" data-col-group="sales">${formatCurrency(totals.onlineSales)}</td>
    <td class="text-end">${formatCurrency(totals.dailyCashExpense + totals.occasionalExpense)}</td>
    <td class="text-end" data-col-group="expenses">${formatCurrency(totals.dailyCashExpense)}</td>
    <td class="text-end" data-col-group="expenses">${formatCurrency(totals.occasionalExpense)}</td>
    <td class="text-end">${formatCurrency(totals.salaryPending)}</td>
    <td class="text-end" data-col-group="salary">${formatCurrency(totals.salaryGross)}</td>
    <td class="text-end" data-col-group="salary">${formatCurrency(totals.salaryPaid)}</td>
    <td class="text-end" data-col-group="salary">${formatCurrency(totals.pettaTotal)}</td>
    <td class="text-end">${formatCurrency(totals.marketExpense)}</td>
    <td class="text-end">${formatCurrency(totals.totalCost)}</td>
    <td class="text-end ${totals.profit >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(totals.profit)}</td>
  </tr>` : '';

  applyColumnGroups();
}

function statusBadge(status) {
  const tone = status === 'Approved' || status === 'AutoApproved' ? 'success' : status === 'Rejected' ? 'danger' : 'warning';
  return `<span class="badge bg-${tone}-subtle text-${tone} border border-${tone}-subtle">${escapeHtml(status)}</span>`;
}

function renderOccasional(data) {
  const totalsByDate = new Map(data.days.map(day => [day.date, day]));
  const body = document.getElementById('occasionalBody');
  document.getElementById('occasionalSummary').textContent =
    `${formatCurrency(data.totals.amount)} · ${data.totals.count} entr${data.totals.count === 1 ? 'y' : 'ies'} · ${data.totals.days} day${data.totals.days === 1 ? '' : 's'}`;

  document.getElementById('occasionalCategories').innerHTML = data.categories.length
    ? `<div class="d-flex flex-wrap gap-2 mb-3">${data.categories.map(item =>
      `<span class="badge bg-light text-dark border">${escapeHtml(item.category)}: ${formatCurrency(item.amount)}</span>`).join('')}</div>`
    : '';

  let lastDate = null;
  body.innerHTML = data.entries.length ? data.entries.map(entry => {
    // A subtotal row opens each new date so the day-wise capture is easy to scan.
    const header = entry.date === lastDate ? '' : `<tr class="table-light fw-semibold">
      <td colspan="6">${formatDate(entry.date)}</td>
      <td class="text-end">${formatCurrency(totalsByDate.get(entry.date).amount)}</td></tr>`;
    lastDate = entry.date;
    return header + `<tr>
      <td data-label="Date" class="text-nowrap">${formatDate(entry.date)}</td>
      <td data-label="Category" class="fw-semibold">${escapeHtml(entry.category)}</td>
      <td data-label="Type">${escapeHtml(entry.type)}</td>
      <td data-label="Remarks" class="text-muted">${escapeHtml(entry.remarks || '—')}</td>
      <td data-label="Submitted By">${escapeHtml(entry.submittedBy || '—')}</td>
      <td data-label="Status">${statusBadge(entry.approvalStatus)}</td>
      <td data-label="Amount" class="text-end fw-semibold">${formatCurrency(entry.amount)}</td>
    </tr>`;
  }).join('') : emptyRow(7, 'No occasional expenses in this range.');

  document.getElementById('occasionalFoot').innerHTML = data.entries.length
    ? `<tr class="fw-bold" style="background:#f0f9ff"><td colspan="6">Total</td><td class="text-end">${formatCurrency(data.totals.amount)}</td></tr>`
    : '';
}

function exportOccasionalCsv() {
  if (!occasionalData) return showNotification('Run the report first.', 'warning');
  const headers = ['Date', 'Category', 'Type', 'Remarks', 'Submitted By', 'Status', 'Amount'];
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')].concat(occasionalData.entries.map(entry => [
    entry.date, cell(entry.category), cell(entry.type), cell(entry.remarks),
    cell(entry.submittedBy), entry.approvalStatus, entry.amount
  ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `occasional-expenses-${occasionalData.range.from}-to-${occasionalData.range.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function analyticsSection(title, icon, count, inner) {
  const tone = count ? 'danger' : 'success';
  return `<section class="mb-3">
    <div class="d-flex align-items-center gap-2 mb-2">
      <i class="bi ${icon} text-${tone}"></i>
      <strong>${title}</strong>
      <span class="badge bg-${tone}-subtle text-${tone} border border-${tone}-subtle">${count}</span>
    </div>
    ${count ? inner : '<div class="text-muted small">Nothing flagged.</div>'}
  </section>`;
}

function miniTable(headers, rows) {
  return `<div class="table-responsive"><table class="table table-sm mobile-grid-table mb-0">
    <thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

function renderAnalytics(analytics) {
  const total = analytics.selfApproved.length + analytics.outliers.length +
    analytics.lateSalesEdits.length + analytics.dayIssues.length + analytics.ratio.flagged.length;
  document.getElementById('analyticsCount').textContent = `${total} flag${total === 1 ? '' : 's'}`;

  const ratioNote = analytics.ratio.median === null
    ? ''
    : `<div class="text-muted small mb-2">Typical cost-to-sales ratio is ${(analytics.ratio.median * 100).toFixed(1)}%. Days differing by more than ${(analytics.ratio.tolerance * 100).toFixed(0)}% are flagged.</div>`;

  document.getElementById('analyticsBody').innerHTML =
    analyticsSection('Costs not tracking sales', 'bi-graph-up-arrow', analytics.ratio.flagged.length,
      ratioNote + miniTable(['Date', 'Sales', 'Cost', 'Ratio', 'Issue'], analytics.ratio.flagged.map(item => `<tr>
        <td data-label="Date">${formatDate(item.date)}</td>
        <td data-label="Sales">${formatCurrency(item.sales)}</td>
        <td data-label="Cost">${formatCurrency(item.totalCost)}</td>
        <td data-label="Ratio">${(item.ratio * 100).toFixed(1)}%</td>
        <td data-label="Issue" class="text-danger">${escapeHtml(item.direction)}</td></tr>`))) +

    analyticsSection('Self-approved expenses', 'bi-person-check', analytics.selfApproved.length,
      miniTable(['Date', 'Category', 'Amount', 'User'], analytics.selfApproved.map(item => `<tr>
        <td data-label="Date">${formatDate(item.date)}</td>
        <td data-label="Category">${escapeHtml(item.category)}</td>
        <td data-label="Amount">${formatCurrency(item.amount)}</td>
        <td data-label="User">${escapeHtml(item.user)}</td></tr>`))) +

    analyticsSection('Unusually large amounts', 'bi-exclamation-triangle', analytics.outliers.length,
      miniTable(['Date', 'Category', 'Amount', 'Category Avg', 'Times', 'By'], analytics.outliers.map(item => `<tr>
        <td data-label="Date">${formatDate(item.date)}</td>
        <td data-label="Category">${escapeHtml(item.category)}</td>
        <td data-label="Amount">${formatCurrency(item.amount)}</td>
        <td data-label="Category Avg">${formatCurrency(item.categoryAverage)}</td>
        <td data-label="Times">${item.times}x</td>
        <td data-label="By">${escapeHtml(item.submittedBy)}</td></tr>`))) +

    analyticsSection('Sales entered or edited late', 'bi-clock-history', analytics.lateSalesEdits.length,
      miniTable(['Sales Date', 'Shift', 'Amount', 'Action', 'Days Late', 'By'], analytics.lateSalesEdits.map(item => `<tr>
        <td data-label="Sales Date">${formatDate(item.date)}</td>
        <td data-label="Shift">${escapeHtml(item.shift)}</td>
        <td data-label="Amount">${formatCurrency(item.amount)}</td>
        <td data-label="Action">${escapeHtml(item.action)}</td>
        <td data-label="Days Late">${item.daysLate}</td>
        <td data-label="By">${escapeHtml(item.enteredBy)}</td></tr>`))) +

    analyticsSection('Day-level issues', 'bi-calendar-x', analytics.dayIssues.length,
      miniTable(['Date', 'Issue', 'Amount'], analytics.dayIssues.map(item => `<tr>
        <td data-label="Date">${formatDate(item.date)}</td>
        <td data-label="Issue">${escapeHtml(item.issue)}</td>
        <td data-label="Amount">${formatCurrency(item.amount)}</td></tr>`))) +

    `<section><div class="d-flex align-items-center gap-2 mb-2"><i class="bi bi-pencil-square text-muted"></i><strong>On-spot category usage</strong></div>
      <div class="text-muted small">${analytics.onSpot.count} entries totalling ${formatCurrency(analytics.onSpot.total)} (${analytics.onSpot.share}% of expenses).</div>
      ${analytics.onSpot.topCategories.length ? `<div class="d-flex flex-wrap gap-2 mt-2">${analytics.onSpot.topCategories.map(item => `<span class="badge bg-light text-dark border">${escapeHtml(item.category)}: ${formatCurrency(item.amount)}</span>`).join('')}</div>` : ''}
    </section>`;
}

function exportCsv() {
  if (!reportData) return showNotification('Run the report first.', 'warning');
  const headers = ['Date', 'Sales', 'Cash Sales', 'Online Sales', 'Daily Cash Expense', 'Occasional', 'Salary', 'Salary Received', 'Petta', 'Pending Salary', 'Market', 'Total Cost', 'Profit'];
  const lines = [headers.join(',')].concat(reportData.days.map(day => [
    day.date, day.sales, day.cashSales, day.onlineSales, day.dailyCashExpense, day.occasionalExpense,
    day.salaryGross, day.salaryPaid, day.pettaTotal, day.salaryPending, day.marketExpense, day.totalCost, day.profit
  ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `profit-loss-${reportData.range.from}-to-${reportData.range.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
