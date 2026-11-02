/* reports.js - Profit & loss with misuse analytics */

let reportData = null;
let occasionalData = null;
let plChart = null;

// Sub-column counts per collapsible group in the daily breakdown table.
const COLUMN_GROUPS = { sales: 2, expenses: 4, salary: 3, salarySources: 3 };
const BASE_COLUMN_COUNT = 8;
const expandedColumnGroups = new Set();
let activePLFormula = null;
const PL_FORMULAS = {
  cashInHand: {
    title: 'Cash In Hand calculation',
    formula: 'Previous day Cash In Hand + Cash Sales − Cash-enabled Expenses.',
    groups: ['sales', 'expenses'],
    columns: ['salesTotal', 'expensesTotal', 'market', 'cashInHand']
  },
  onlineBalance: {
    title: 'Online Balance calculation',
    formula: 'Previous day Online Balance + Online Sales − Online Expenses.',
    groups: ['sales', 'expenses'],
    columns: ['salesTotal', 'expensesTotal', 'onlineBalance']
  },
  profit: {
    title: 'Profit calculation',
    formula: 'Sales − Day / Sale expenses − (Salary − Petta − Received) − Market.',
    groups: ['expenses', 'salary'],
    columns: ['salesTotal', 'expensesTotal', 'market', 'profit']
  },
  profitBalance: {
    title: 'Profit Balance calculation',
    formula: 'Previous day Profit Balance + Profit − Day / Online − Occasional / Online − Occasional / Cash.',
    groups: ['expenses', 'salary'],
    columns: ['expensesTotal', 'profit', 'profitBalance']
  }
};

function showPLFormula(key) {
  const definition = PL_FORMULAS[key];
  if (!definition) return;
  activePLFormula = key;
  expandedColumnGroups.clear();
  definition.groups.forEach(group => expandedColumnGroups.add(group));
  const panel = document.getElementById('plFormulaPanel');
  document.getElementById('plFormulaTitle').textContent = definition.title;
  document.getElementById('plFormulaText').textContent = definition.formula;
  panel.hidden = false;
  applyColumnGroups();
}

function resetPLView() {
  activePLFormula = null;
  expandedColumnGroups.clear();
  const panel = document.getElementById('plFormulaPanel');
  if (panel) panel.hidden = true;
  applyColumnGroups();
}

function plColumnCount() {
  return BASE_COLUMN_COUNT +
    (expandedColumnGroups.has('sales') ? COLUMN_GROUPS.sales : 0) +
    (expandedColumnGroups.has('expenses') ? COLUMN_GROUPS.expenses : 0) +
    (expandedColumnGroups.has('salary') ? COLUMN_GROUPS.salary : 0) +
    (expandedColumnGroups.has('salary') && expandedColumnGroups.has('salarySources') ? COLUMN_GROUPS.salarySources : 0);
}

function applyColumnGroups() {
  document.querySelectorAll('#plTable [data-col-group]').forEach(cell => {
    const group = cell.dataset.colGroup;
    const visible = group === 'salarySources'
      ? expandedColumnGroups.has('salary') && expandedColumnGroups.has('salarySources')
      : expandedColumnGroups.has(group);
    cell.classList.toggle('d-none', !visible);
  });
  document.querySelectorAll('#plTable [data-toggle-group]').forEach(header => {
    const icon = header.querySelector('i');
    if (!icon) return;
    const expanded = expandedColumnGroups.has(header.dataset.toggleGroup);
    icon.className = `bi ${expanded ? 'bi-dash-square' : 'bi-plus-square'} ms-1 small`;
  });
  const formula = PL_FORMULAS[activePLFormula];
  document.querySelectorAll('#plTable [data-col-group], #plTable [data-formula-column]').forEach(cell => {
    const column = cell.dataset.formulaColumn;
    const group = cell.dataset.colGroup;
    const highlighted = !!formula && (
      formula.columns.includes(column) ||
      (group && (group === 'salarySources' ? formula.groups.includes('salary') : formula.groups.includes(group)))
    );
    cell.classList.toggle('pl-formula-highlight', highlighted);
  });
  document.querySelectorAll('#plTable [data-formula]').forEach(header => {
    header.classList.toggle('pl-formula-active', header.dataset.formula === activePLFormula);
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
      if (expandedColumnGroups.has(group)) {
        expandedColumnGroups.delete(group);
        if (group === 'salary') expandedColumnGroups.delete('salarySources');
      }
      else expandedColumnGroups.add(group);
      applyColumnGroups();
    });
  });
  document.querySelectorAll('#plTable [data-formula]').forEach(header => {
    header.addEventListener('click', () => showPLFormula(header.dataset.formula));
    header.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      showPLFormula(header.dataset.formula);
    });
  });
  document.getElementById('btnResetPLView').addEventListener('click', resetPLView);

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
  const expenses = totals.dailyCashExpense + totals.dailyOnlineExpense + totals.occasionalExpense + totals.occasionalCashExpense;
  document.getElementById('summaryCards').innerHTML =
    card('Total Sales', formatCurrency(totals.sales), 'primary',
      `Cash ${formatCurrency(totals.cashSales)} · Online ${formatCurrency(totals.onlineSales)}`) +
    card('Expenses', formatCurrency(expenses), 'warning',
      `Day / Sale ${formatCurrency(totals.dailyCashExpense)} · Day / Online ${formatCurrency(totals.dailyOnlineExpense)} · Occasional / Online ${formatCurrency(totals.occasionalExpense)} · Occasional / Cash ${formatCurrency(totals.occasionalCashExpense)}`) +
    card('Pending Salary', formatCurrency(totals.salaryPending), 'info',
      `Salary ${formatCurrency(totals.salaryGross)} − petta ${formatCurrency(totals.pettaTotal)} − received ${formatCurrency(totals.salaryPaid)} · Day Sale Cash ${formatCurrency(totals.salaryDaySaleCash)} · Cash In Hand ${formatCurrency(totals.salaryCashInHand)} · Online ${formatCurrency(totals.salaryOnline)}`) +
    card('Cash In Hand', formatCurrency(totals.cashInHand), totals.cashInHand >= 0 ? 'primary' : 'danger',
      `Cash sales ${formatCurrency(totals.cashSales)} − cash expenses ${formatCurrency(totals.cashExpenses)} · Range balance`) +
    card('Online Balance', formatCurrency(totals.onlineInHand), totals.onlineInHand >= 0 ? 'info' : 'danger',
      `Online sales ${formatCurrency(totals.onlineSales)} − online expenses ${formatCurrency(totals.onlineExpenses)} · Range balance`) +
    card(totals.profitBalance >= 0 ? 'Profit Balance' : 'Profit Balance (Advance)', formatCurrency(totals.profitBalance), totals.profitBalance >= 0 ? 'success' : 'danger',
      `Operating profit ${formatCurrency(totals.profit)} · Paid from profit ${formatCurrency(totals.profitBalancePayments)}${totals.margin === null ? '' : ` · Margin ${totals.margin}%`}`);
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
  const rows = days.filter(day => day.sales || day.totalCost || day.profitBalancePayments);
  body.innerHTML = rows.length ? rows.map(day => `<tr>
    <td data-label="Date" class="text-nowrap">${formatDate(day.date)}</td>
    <td data-label="Sales" data-formula-column="salesTotal" class="text-end fw-semibold">${formatCurrency(day.sales)}</td>
    <td data-label="Cash" class="text-end" data-col-group="sales">${formatCurrency(day.cashSales)}</td>
    <td data-label="Online" class="text-end" data-col-group="sales">${formatCurrency(day.onlineSales)}</td>
    <td data-label="Expenses" class="text-end" data-formula-column="expensesTotal">${formatCurrency(day.dailyCashExpense + day.dailyOnlineExpense + day.occasionalExpense + day.occasionalCashExpense)}</td>
    <td data-label="Daily Cash Exp" class="text-end" data-col-group="expenses">${formatCurrency(day.dailyCashExpense)}</td>
    <td data-label="Day / Online" class="text-end" data-col-group="expenses">${formatCurrency(day.dailyOnlineExpense)}</td>
    <td data-label="Occasional / Online" class="text-end" data-col-group="expenses">${formatCurrency(day.occasionalExpense)}</td>
    <td data-label="Occasional / Cash" class="text-end" data-col-group="expenses">${formatCurrency(day.occasionalCashExpense)}</td>
    <td data-label="Pending Salary" class="text-end">${formatCurrency(day.salaryPending)}</td>
    <td data-label="Salary" class="text-end" data-col-group="salary">${formatCurrency(day.salaryGross)}</td>
    <td data-label="Received" class="text-end" data-col-group="salary">${formatCurrency(day.salaryPaid)}</td>
    <td data-label="Day Sale Cash" class="text-end" data-col-group="salarySources">${formatCurrency(day.salaryDaySaleCash)}</td>
    <td data-label="Cash In Hand" class="text-end" data-col-group="salarySources">${formatCurrency(day.salaryCashInHand)}</td>
    <td data-label="Online Paid" class="text-end" data-col-group="salarySources">${formatCurrency(day.salaryOnline)}</td>
    <td data-label="Petta" class="text-end" data-col-group="salary">${formatCurrency(day.pettaTotal)}</td>
    <td data-label="Market" class="text-end" data-formula-column="market">${formatCurrency(day.marketExpense)}</td>
    <td data-label="Operating Cost" class="text-end">${formatCurrency(day.totalCost)}</td>
    <td data-label="Cash In Hand" data-formula-column="cashInHand" class="text-end fw-semibold ${day.cashInHand >= 0 ? 'text-primary' : 'text-danger'}">${formatCurrency(day.cashInHand)}</td>
    <td data-label="Online Balance" data-formula-column="onlineBalance" class="text-end fw-semibold ${day.onlineInHand >= 0 ? 'text-info' : 'text-danger'}">${formatCurrency(day.onlineInHand)}</td>
    <td data-label="Profit" data-formula-column="profit" class="text-end fw-semibold ${day.profit >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(day.profit)}</td>
    <td data-label="Profit Balance" data-formula-column="profitBalance" class="text-end fw-semibold ${day.profitBalance >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(day.profitBalance)}</td>
  </tr>`).join('') : emptyRow(plColumnCount(), 'No sales or costs in this range.');

  document.getElementById('plFoot').innerHTML = rows.length ? `<tr class="fw-bold" style="background:#f0f9ff">
    <td>Total</td>
    <td class="text-end" data-formula-column="salesTotal">${formatCurrency(totals.sales)}</td>
    <td class="text-end" data-col-group="sales">${formatCurrency(totals.cashSales)}</td>
    <td class="text-end" data-col-group="sales">${formatCurrency(totals.onlineSales)}</td>
    <td class="text-end" data-formula-column="expensesTotal">${formatCurrency(totals.dailyCashExpense + totals.dailyOnlineExpense + totals.occasionalExpense + totals.occasionalCashExpense)}</td>
    <td class="text-end" data-col-group="expenses">${formatCurrency(totals.dailyCashExpense)}</td>
    <td class="text-end" data-col-group="expenses">${formatCurrency(totals.dailyOnlineExpense)}</td>
    <td class="text-end" data-col-group="expenses">${formatCurrency(totals.occasionalExpense)}</td>
    <td class="text-end" data-col-group="expenses">${formatCurrency(totals.occasionalCashExpense)}</td>
    <td class="text-end">${formatCurrency(totals.salaryPending)}</td>
    <td class="text-end" data-col-group="salary">${formatCurrency(totals.salaryGross)}</td>
    <td class="text-end" data-col-group="salary">${formatCurrency(totals.salaryPaid)}</td>
    <td class="text-end" data-col-group="salarySources">${formatCurrency(totals.salaryDaySaleCash)}</td>
    <td class="text-end" data-col-group="salarySources">${formatCurrency(totals.salaryCashInHand)}</td>
    <td class="text-end" data-col-group="salarySources">${formatCurrency(totals.salaryOnline)}</td>
    <td class="text-end" data-col-group="salary">${formatCurrency(totals.pettaTotal)}</td>
    <td class="text-end" data-formula-column="market">${formatCurrency(totals.marketExpense)}</td>
    <td class="text-end">${formatCurrency(totals.totalCost)}</td>
    <td class="text-end ${totals.cashInHand >= 0 ? 'text-primary' : 'text-danger'}" data-formula-column="cashInHand">${formatCurrency(totals.cashInHand)}</td>
    <td class="text-end ${totals.onlineInHand >= 0 ? 'text-info' : 'text-danger'}" data-formula-column="onlineBalance">${formatCurrency(totals.onlineInHand)}</td>
    <td class="text-end ${totals.profit >= 0 ? 'text-success' : 'text-danger'}" data-formula-column="profit">${formatCurrency(totals.profit)}</td>
    <td class="text-end ${totals.profitBalance >= 0 ? 'text-success' : 'text-danger'}" data-formula-column="profitBalance">${formatCurrency(totals.profitBalance)}</td>
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
      <td colspan="7">${formatDate(entry.date)}</td>
      <td class="text-end">${formatCurrency(totalsByDate.get(entry.date).amount)}</td></tr>`;
    lastDate = entry.date;
    return header + `<tr>
      <td data-label="Date" class="text-nowrap">${formatDate(entry.date)}</td>
      <td data-label="Category" class="fw-semibold">${escapeHtml(entry.category)}</td>
      <td data-label="Type">${escapeHtml(entry.type)}</td>
      <td data-label="Payment">${escapeHtml(entry.paymentMode || 'Online')}</td>
      <td data-label="Remarks" class="text-muted">${escapeHtml(entry.remarks || '—')}</td>
      <td data-label="Submitted By">${escapeHtml(entry.submittedBy || '—')}</td>
      <td data-label="Status">${statusBadge(entry.approvalStatus)}</td>
      <td data-label="Amount" class="text-end fw-semibold">${formatCurrency(entry.amount)}</td>
    </tr>`;
  }).join('') : emptyRow(8, 'No occasional expenses in this range.');

  document.getElementById('occasionalFoot').innerHTML = data.entries.length
    ? `<tr class="fw-bold" style="background:#f0f9ff"><td colspan="7">Total</td><td class="text-end">${formatCurrency(data.totals.amount)}</td></tr>`
    : '';
}

function exportOccasionalCsv() {
  if (!occasionalData) return showNotification('Run the report first.', 'warning');
  const headers = ['Date', 'Category', 'Type', 'Payment Mode', 'Remarks', 'Submitted By', 'Status', 'Amount'];
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')].concat(occasionalData.entries.map(entry => [
    entry.date, cell(entry.category), cell(entry.type), entry.paymentMode || 'Online', cell(entry.remarks),
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
  const headers = ['Date', 'Sales', 'Cash Sales', 'Online Sales', 'Day / Sale', 'Day / Online', 'Occasional / Online', 'Occasional / Cash', 'Salary', 'Salary Received', 'Salary Paid from Day Sale Cash', 'Salary Paid from Cash In Hand', 'Salary Paid Online', 'Petta', 'Pending Salary', 'Market', 'Operating Cost', 'Cash In Hand', 'Online Balance', 'Operating Profit', 'Profit Balance'];
  const lines = [headers.join(',')].concat(reportData.days.map(day => [
    day.date, day.sales, day.cashSales, day.onlineSales, day.dailyCashExpense, day.dailyOnlineExpense, day.occasionalExpense, day.occasionalCashExpense,
    day.salaryGross, day.salaryPaid, day.salaryDaySaleCash, day.salaryCashInHand, day.salaryOnline, day.pettaTotal, day.salaryPending, day.marketExpense, day.totalCost, day.cashInHand, day.onlineInHand, day.profit, day.profitBalance
  ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `profit-loss-${reportData.range.from}-to-${reportData.range.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
