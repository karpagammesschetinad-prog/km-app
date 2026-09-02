/* dashboard.js */

let trendChart = null;
let salesExpenseChart = null;
let employeeStatusLoaded = false;
let recentExpensesLoaded = false;
let dashboardChartData = null;
let categoryChartLoaded = false;
let categoryTrendLoaded = false;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  // Cashier should not access dashboard
  if (user.role !== 'superuser') {
    window.location.href = '/expenses.html';
    return;
  }
  setupDemandLoadedSections();
  await loadDashboard();
});

function setupDemandLoadedSections() {
  document.getElementById('salesExpensePeriod')?.addEventListener('change', changeSalesExpensePeriod);
  document.getElementById('categoryChartPanel')?.addEventListener('shown.bs.collapse', loadCategoryChartOnDemand);
  document.getElementById('categoryTrendPanel')?.addEventListener('shown.bs.collapse', loadCategoryTrendOnDemand);
  document.getElementById('recentExpensesPanel')?.addEventListener('shown.bs.collapse', loadRecentExpensesOnDemand);
  document.getElementById('employeeStatusPanel')?.addEventListener('shown.bs.collapse', loadEmployeeStatusOnDemand);
}

async function loadDashboard() {
  try {
    const fetchNamed = (name, path) => api('GET', path).catch(error => {
      throw new Error(`${name}: ${error.message}`);
    });
    const [expenses, salaries, config, salesHistory] = await Promise.all([
      fetchNamed('Expenses', '/expenses'),
      fetchNamed('Salaries', '/salaries'),
      fetchNamed('Configuration', '/config'),
      fetchNamed('Sales', `/sales/history?days=${salesExpensePeriodDays()}`)
    ]);

    const now = new Date();
    const fyStart = new Date(config.fiscalYear.start + 'T00:00:00');
    const fyEnd = new Date(Math.min(now.getTime(), new Date(config.fiscalYear.end + 'T23:59:59').getTime()));

    const monthExp = expenses.filter(e => {
      const d = new Date(e.date);
      return d >= fyStart && d <= fyEnd;
    });

    const monthSal = salaries.filter(s => s.paymentDate && new Date(s.paymentDate) >= fyStart && new Date(s.paymentDate) <= fyEnd);
    const expenseChartStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 19);
    const recentChartExpenses = expenses.filter(e => {
      const d = new Date(`${e.date}T00:00:00`);
      return d >= expenseChartStart && d <= now;
    });

    const pendingExp = expenses.filter(e => e.status === 'Pending');

    const totalExp = monthExp.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const totalSal = monthSal.reduce((s, e) => s + (parseFloat(e.netSalary) || 0), 0);

    document.getElementById('stat-employees').textContent  = '—';
    document.getElementById('stat-onleave').textContent    = '—';
    document.getElementById('stat-pending-sal').textContent = '—';
    document.getElementById('stat-advance').textContent    = '—';
    document.getElementById('stat-expenses').textContent   = formatCurrency(totalExp);
    document.getElementById('stat-salaries').textContent   = formatCurrency(totalSal);
    document.getElementById('stat-pending').textContent    = pendingExp.length;

    dashboardChartData = { expenses: recentChartExpenses, allExpenses: expenses, salesHistory, referenceDate: now };
    renderSalesExpenseChart(expenses, salesHistory, now, salesExpensePeriodDays());
    categoryChartLoaded = false;
    categoryTrendLoaded = false;
    recentExpensesLoaded = false;
    employeeStatusLoaded = false;
    if (document.getElementById('categoryChartPanel')?.classList.contains('show')) loadCategoryChartOnDemand();
    if (document.getElementById('categoryTrendPanel')?.classList.contains('show')) loadCategoryTrendOnDemand();
    if (document.getElementById('recentExpensesPanel')?.classList.contains('show')) loadRecentExpensesOnDemand();
    if (document.getElementById('employeeStatusPanel')?.classList.contains('show')) loadEmployeeStatusOnDemand();

  } catch (err) {
    showNotification('Failed to load dashboard: ' + err.message, 'danger');
  }
}

function loadCategoryChartOnDemand() {
  if (categoryChartLoaded || !dashboardChartData) return;
  renderCategoryChart(dashboardChartData.expenses);
  categoryChartLoaded = true;
}

function loadCategoryTrendOnDemand() {
  if (categoryTrendLoaded || !dashboardChartData) return;
  renderTrendChart(dashboardChartData.expenses, dashboardChartData.salesHistory, dashboardChartData.referenceDate);
  categoryTrendLoaded = true;
}

async function loadRecentExpensesOnDemand() {
  if (recentExpensesLoaded) return;
  const tbody = document.getElementById('recentExpBody');
  if (!tbody) return;
  try {
    const expenses = await api('GET', '/expenses');
    renderRecentExpenses(expenses.slice(-6).reverse());
    recentExpensesLoaded = true;
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-danger py-3">Failed to load recent expenses.</td></tr>';
  }
}

// Leave is counted by calendar date only: a half day is 0.5, any other covered date is a full day.
function leaveDateSpan(leave, reference = new Date()) {
  const startKey = String(leave.startDateTime || '').slice(0, 10);
  if (!startKey) return null;
  const localKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const rawEnd = leave.endDateTime ? new Date(leave.endDateTime) : null;
  if (!rawEnd || Number.isNaN(rawEnd.getTime())) return { startKey, endKey: localKey(reference), fraction: 1 };
  const spanHours = (rawEnd - new Date(leave.startDateTime)) / 3600000;
  const endKey = localKey(new Date(rawEnd.getTime() - 1));
  if (spanHours > 0 && spanHours <= 12 && endKey === startKey) return { startKey, endKey: startKey, fraction: 0.5 };
  return { startKey, endKey: endKey < startKey ? startKey : endKey, fraction: 1 };
}

async function loadEmployeeStatusOnDemand() {
  if (employeeStatusLoaded) return;
  const tbody = document.getElementById('empStatusBody');
  if (!tbody) return;
  try {
    const [employees, allLeaves, allPayments, allSalaryHistory, config] = await Promise.all([
      api('GET', '/employees'), api('GET', '/leaves'), api('GET', '/payments'), api('GET', '/salary-history'), api('GET', '/config')
    ]);
    const now = new Date();
    const fyStart = new Date(config.fiscalYear.start + 'T00:00:00');
    const fyEnd = new Date(Math.min(now.getTime(), new Date(config.fiscalYear.end + 'T23:59:59').getTime()));
    const activeEmp = employees.filter(emp => emp.status === 'Active' && !emp.temporaryEmployee);
    const empStats = activeEmp.map(emp => {
      const leaves = allLeaves.filter(leave => leave.employeeId === emp.id);
      const payments = allPayments.filter(payment => payment.employeeId === emp.id);
      const revisions = allSalaryHistory
        .filter(record => record.employeeId === emp.id)
        .sort((first, second) => String(first.effectiveDate).localeCompare(String(second.effectiveDate)));
      const rateFor = dayKey => revisions.reduce((rate, record) =>
        record.effectiveDate <= dayKey ? (parseFloat(record.amount) || 0) : rate, parseFloat(emp.perDaySalary) || 0);
      const start = new Date(Math.max(new Date(emp.startDate).getTime(), fyStart.getTime()));
      const totalDays = Math.max(0, (fyEnd - start) / 86400000);
      const leaveDays = leaves.reduce((sum, leave) => {
        const span = leaveDateSpan(leave, now);
        if (!span) return sum;
        const spanStart = new Date(Math.max(new Date(`${span.startKey}T00:00:00`).getTime(), start.getTime()));
        const spanEnd = new Date(Math.min(new Date(`${span.endKey}T00:00:00`).getTime(), fyEnd.getTime()));
        if (spanEnd < spanStart) return sum;
        const covered = Math.floor((spanEnd - spanStart) / 86400000) + 1;
        return sum + covered * span.fraction;
      }, 0);
      const workedDays = Math.max(0, totalDays - leaveDays);
      // Revisions split the year into rate spans, so the earned amount is weighted by each span's share of worked days.
      const earned = totalDays > 0
        ? [...Array(Math.ceil(totalDays)).keys()].reduce((sum, offset) => {
          const day = new Date(start.getTime() + offset * 86400000);
          return sum + (rateFor(day.toISOString().slice(0, 10)) - emp.dailyPetta);
        }, 0) * (workedDays / Math.ceil(totalDays))
        : 0;
      const paid = payments.reduce((sum, payment) => sum + payment.amount, 0);
      let carriedBalance = parseFloat(emp.openingBalance) || 0;
      for (let day = new Date(emp.startDate); day < fyStart; day.setDate(day.getDate() + 1)) {
        const dayKey = day.toISOString().slice(0, 10);
        const leave = leaves.some(item => {
          const span = leaveDateSpan(item, now);
          return span && dayKey >= span.startKey && dayKey <= span.endKey;
        });
        const dayPaid = payments.filter(payment => payment.paymentDate === dayKey).reduce((sum, payment) => sum + (parseFloat(payment.amount) || 0), 0);
        carriedBalance += (leave ? 0 : (rateFor(dayKey) - emp.dailyPetta)) - dayPaid;
      }
      const balance = carriedBalance + earned - paid;
      const onLeave = leaves.some(leave => new Date(leave.startDateTime) <= now && (!leave.endDateTime || now <= new Date(leave.endDateTime)));
      return { emp, balance, onLeave };
    });
    document.getElementById('stat-employees').textContent = activeEmp.length;
    document.getElementById('stat-onleave').textContent = empStats.filter(item => item.onLeave).length;
    document.getElementById('stat-pending-sal').textContent = empStats.filter(item => !item.onLeave && item.balance > 0).length;
    document.getElementById('stat-advance').textContent = empStats.filter(item => item.balance < 0).length;
    renderEmployeeStatus(empStats);
    employeeStatusLoaded = true;
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-danger py-3">Failed to load employee status.</td></tr>';
  }
}

function renderEmployeeStatus(empStats) {
  const tbody = document.getElementById('empStatusBody');
  if (!tbody) return;
  if (!empStats.length) { tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">No active employees</td></tr>'; return; }

  tbody.innerHTML = empStats.map(({ emp, balance, onLeave }) => {
    const isAdv = balance < 0;
    const amt = Math.abs(balance);
    let statusBadgeHtml, salBadgeHtml;

    if (onLeave) {
      statusBadgeHtml = '<span class="badge bg-primary">🔵 On Leave</span>';
    } else {
      statusBadgeHtml = '<span class="badge bg-success-subtle text-success border border-success-subtle">🟢 Active</span>';
    }

    if (isAdv) {
      salBadgeHtml = `<span class="badge bg-warning-subtle text-warning border border-warning-subtle">🟡 Advance: ${formatCurrency(amt)}</span>`;
    } else if (balance > 0) {
      salBadgeHtml = `<span class="badge bg-danger-subtle text-danger border border-danger-subtle">🔴 Pending: ${formatCurrency(amt)}</span>`;
    } else {
      salBadgeHtml = `<span class="badge bg-success-subtle text-success border border-success-subtle">✅ Settled</span>`;
    }

    return `<tr>
        <td data-label="Employee"><a href="/employee-detail.html?id=${emp.id}" class="fw-semibold text-decoration-none">${emp.name}</a>
          ${emp.phone ? `<div class="text-muted small">${emp.phone}</div>` : ''}</td>
        <td data-label="Status">${statusBadgeHtml}</td>
        <td data-label="Salary summary">${salBadgeHtml}</td>
        <td data-label="Actions"><a href="/employee-detail.html?id=${emp.id}" class="btn btn-xs btn-outline-primary btn-action"><i class="bi bi-eye"></i></a></td>
    </tr>`;
  }).join('');
}

function renderCategoryChart(expenses) {
  const ctx = document.getElementById('chartCategory');
  if (!ctx) return;

  const cats = {};
  expenses.forEach(e => {
    const k = e.category || 'Other';
    cats[k] = (cats[k] || 0) + (parseFloat(e.amount) || 0);
  });

  if (Object.keys(cats).length === 0) {
    ctx.closest('.chart-wrap').innerHTML =
      '<p class="text-center text-muted py-4 small">No expense data for the last 20 days</p>';
    return;
  }

  const COLORS = ['#3b82f6','#8b5cf6','#22c55e','#f59e0b','#ef4444','#06b6d4','#f97316','#ec4899','#84cc16'];
  const sortedCategories = Object.entries(cats).sort(([, firstAmount], [, secondAmount]) => secondAmount - firstAmount);
  const labels = sortedCategories.map(([label]) => label);
  const data = sortedCategories.map(([, amount]) => amount);
  const legend = document.getElementById('chartCategoryLegend');
  if (legend) {
    legend.innerHTML = labels.map((label, index) =>
      `<span class="dashboard-category-legend-item"><i style="background-color:${COLORS[index % COLORS.length]}"></i><span>${escapeHtml(label)}</span><strong>${formatCurrency(data[index])}</strong></span>`
    ).join('');
  }

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: labels.map((_, index) => COLORS[index % COLORS.length]), borderWidth: 0, hoverOffset: 8 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '66%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${formatCurrency(c.raw)}` } }
      }
    }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function normalizeToAverage(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return average ? values.map(value => value / average * 100) : values.map(() => 0);
}

function calculateCorrelation(firstValues, secondValues) {
  const length = Math.min(firstValues.length, secondValues.length);
  if (length < 2) return null;
  const firstAverage = firstValues.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  const secondAverage = secondValues.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  let covariance = 0;
  let firstVariance = 0;
  let secondVariance = 0;
  for (let index = 0; index < length; index++) {
    const firstDifference = firstValues[index] - firstAverage;
    const secondDifference = secondValues[index] - secondAverage;
    covariance += firstDifference * secondDifference;
    firstVariance += firstDifference ** 2;
    secondVariance += secondDifference ** 2;
  }
  return firstVariance && secondVariance ? covariance / Math.sqrt(firstVariance * secondVariance) : null;
}

function renderTrendChart(expenses, salesHistory = [], referenceDate = new Date()) {
  const ctx = document.getElementById('chartTrend');
  const categoryOptions = document.getElementById('trendCategoryOptions');
  const categoryButton = document.getElementById('trendCategoryButton');
  if (!ctx || !categoryOptions || !categoryButton) return;

  const days = Array.from({ length: 20 }, (_, i) => {
    const d = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() - (19 - i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), key };
  });

  const categoryTotals = expenses.reduce((totals, expense) => {
    const category = expense.category || 'Other';
    totals[category] = (totals[category] || 0) + (parseFloat(expense.amount) || 0);
    return totals;
  }, {});
  const categories = Object.entries(categoryTotals)
    .sort(([, firstAmount], [, secondAmount]) => secondAmount - firstAmount)
    .map(([category]) => category);
  const previousSelection = new Set([...categoryOptions.querySelectorAll('input:checked')].map(input => input.value));
  const selectedCategories = categories.filter(category => previousSelection.has(category));
  if (!selectedCategories.length && categories[0]) selectedCategories.push(categories[0]);
  categoryOptions.innerHTML = categories.map(category =>
    `<label class="dropdown-item-text d-flex align-items-center gap-2 py-1"><input class="form-check-input trend-category-check m-0" type="checkbox" value="${escapeHtml(category)}"${selectedCategories.includes(category) ? ' checked' : ''}><span>${escapeHtml(category)}</span></label>`
  ).join('') || '<span class="dropdown-item-text text-muted small">No expense categories</span>';
  categoryButton.textContent = selectedCategories.length === 1
    ? selectedCategories[0]
    : `${selectedCategories.length} categories selected`;

  const categoryData = new Map(selectedCategories.map(category => [category, days.map(day => expenses
    .filter(expense => expense.date === day.key && (expense.category || 'Other') === category)
    .reduce((sum, expense) => sum + (parseFloat(expense.amount) || 0), 0))]));
  const salesByDate = new Map((salesHistory || []).map(row => [row.date, Number(row.totalSales) || 0]));
  const salesData = days.map(day => salesByDate.get(day.key) || 0);
  const normalizedSalesData = normalizeToAverage(salesData);
  const normalizedCategoryData = new Map(selectedCategories.map(category => [
    category,
    normalizeToAverage(categoryData.get(category))
  ]));
  const insight = document.getElementById('trendInsight');
  if (insight) {
    const relationships = selectedCategories.map(category => {
      const correlation = calculateCorrelation(salesData, categoryData.get(category));
      if (correlation === null) return `${escapeHtml(category)}: insufficient variation to compare`;
      const direction = correlation >= .6 ? 'tracks strongly with sales' : correlation >= .3 ? 'generally rises and falls with sales' : correlation <= -.3 ? 'moves opposite to sales' : 'has no clear movement pattern with sales';
      return `${escapeHtml(category)}: ${direction} (${correlation.toFixed(2)})`;
    });
    insight.innerHTML = relationships.length
      ? `Indexed to each series' 20-day average (100%). ${relationships.join(' · ')}`
      : 'Select one or more categories to compare their movement with sales.';
  }

  categoryOptions.querySelectorAll('.trend-category-check').forEach(input => {
    input.addEventListener('change', () => renderTrendChart(expenses, salesHistory, referenceDate));
  });
  if (trendChart) trendChart.destroy();

  const categoryColors = ['#2563eb', '#ea580c', '#9333ea', '#0891b2', '#ca8a04', '#db2777'];
  const categoryDatasets = selectedCategories.map((category, index) => ({
    label: category,
    data: normalizedCategoryData.get(category),
    actualData: categoryData.get(category),
    borderColor: categoryColors[index % categoryColors.length],
    backgroundColor: `${categoryColors[index % categoryColors.length]}20`,
    borderWidth: 2,
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: .3,
    fill: false
  }));

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: days.map(day => day.label),
      datasets: [{
        label: 'Sales',
        data: normalizedSalesData,
        actualData: salesData,
        borderColor: '#16a34a',
        backgroundColor: 'rgba(22,163,74,.12)',
        borderWidth: 3,
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: .3,
        fill: false
      }, ...categoryDatasets]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 10, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: {
          label: context => {
            const actual = context.dataset.actualData?.[context.dataIndex] || 0;
            return ` ${context.dataset.label}: ${formatCurrency(actual)} (${context.raw.toFixed(0)}% of average)`;
          },
          afterBody: tooltipItems => {
            const sales = salesData[tooltipItems[0]?.dataIndex] || 0;
            if (!sales) return '';
            const dayIndex = tooltipItems[0]?.dataIndex;
            return selectedCategories.map(category => {
              const expense = categoryData.get(category)?.[dayIndex] || 0;
              return `${category}: ${(expense / sales * 100).toFixed(1)}% of sales`;
            });
          }
        } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { callback: value => `${value}%` }, title: { display: true, text: 'Index: 100% = 20-day average' } },
        x: { grid: { display: false } }
      }
    }
  });
}

function salesExpensePeriodDays() {
  return parseInt(document.getElementById('salesExpensePeriod')?.value, 10) || 20;
}

async function changeSalesExpensePeriod() {
  if (!dashboardChartData) return;
  const days = salesExpensePeriodDays();
  const select = document.getElementById('salesExpensePeriod');
  select.disabled = true;
  try {
    const salesHistory = await api('GET', `/sales/history?days=${days}`);
    dashboardChartData.salesHistory = salesHistory;
    renderSalesExpenseChart(dashboardChartData.allExpenses, salesHistory, dashboardChartData.referenceDate, days);
  } catch (err) {
    showNotification('Failed to load sales history: ' + err.message, 'danger');
  } finally {
    select.disabled = false;
  }
}

function renderSalesExpenseChart(expenses, salesHistory = [], referenceDate = new Date(), periodDays = 20) {
  const ctx = document.getElementById('chartSalesExpense');
  if (!ctx) return;

  const days = Array.from({ length: periodDays }, (_, index) => {
    const date = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() - (periodDays - 1 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), key };
  });
  const sumFor = (dayKey, isOccasional) => expenses
    .filter(expense => expense.date === dayKey && (expense.mode === 'Occasional') === isOccasional)
    .reduce((sum, expense) => sum + (parseFloat(expense.amount) || 0), 0);
  const expenseData = days.map(day => sumFor(day.key, false));
  const occasionalData = days.map(day => sumFor(day.key, true));
  const salesByDate = new Map((salesHistory || []).map(row => [row.date, Number(row.totalSales) || 0]));
  const salesData = days.map(day => salesByDate.get(day.key) || 0);

  if (salesExpenseChart) salesExpenseChart.destroy();
  salesExpenseChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days.map(day => day.label),
      datasets: [{
        label: 'Expenses',
        data: expenseData,
        backgroundColor: 'rgba(59,130,246,.8)',
        borderRadius: 6,
        borderSkipped: false
      }, {
        label: 'Occasional',
        data: occasionalData,
        backgroundColor: 'rgba(14,165,233,.55)',
        borderRadius: 6,
        borderSkipped: false
      }, {
        label: 'Sales',
        data: salesData,
        backgroundColor: 'rgba(34,197,94,.8)',
        borderRadius: 6,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 10, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: context => ` ${context.dataset.label}: ${formatCurrency(context.raw)}` } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { callback: value => formatCurrency(value) } },
        x: { grid: { display: false } }
      }
    }
  });
}

function renderRecentExpenses(expenses) {
  const tbody = document.getElementById('recentExpBody');
  if (!tbody) return;

  if (!expenses.length) {
    tbody.innerHTML = emptyRow(5, 'No expenses yet');
    return;
  }

  tbody.innerHTML = expenses.map(e => `
    <tr>
      <td data-label="Date">${formatDate(e.date)}</td>
      <td data-label="Category"><span class="badge bg-light text-dark border">${e.category}</span></td>
      <td data-label="Description" class="text-muted">${e.description || '—'}</td>
      <td data-label="Amount" class="fw-semibold">${formatCurrency(e.amount)}</td>
      <td data-label="Status">${statusBadge(e.status)}</td>
    </tr>
  `).join('');
}
