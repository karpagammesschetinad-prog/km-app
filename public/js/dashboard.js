/* dashboard.js */

let trendChart = null;
let salesExpenseChart = null;

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  // Cashier should not access dashboard
  if (user.role !== 'superuser') {
    window.location.href = '/expenses.html';
    return;
  }
  await loadDashboard();
});

async function loadDashboard() {
  try {
    const fetchNamed = (name, path) => api('GET', path).catch(error => {
      throw new Error(`${name}: ${error.message}`);
    });
    const [expenses, employees, salaries, allLeaves, allPayments, config, salesHistory] = await Promise.all([
      fetchNamed('Expenses', '/expenses'),
      fetchNamed('Employees', '/employees'),
      fetchNamed('Salaries', '/salaries'),
      fetchNamed('Leaves', '/leaves'),
      fetchNamed('Payments', '/payments'),
      fetchNamed('Configuration', '/config'),
      fetchNamed('Sales', '/sales/history?days=20')
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

    const activeEmp = employees.filter(e => e.status === 'Active' && !e.temporaryEmployee);
    const pendingExp = expenses.filter(e => e.status === 'Pending');

    const totalExp = monthExp.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const totalSal = monthSal.reduce((s, e) => s + (parseFloat(e.netSalary) || 0), 0);

    // Employee salary summaries
    const empStats = activeEmp.map(emp => {
      const leaves  = allLeaves.filter(l => l.employeeId === emp.id);
      const payments = allPayments.filter(p => p.employeeId === emp.id);
      const start = new Date(Math.max(new Date(emp.startDate).getTime(), fyStart.getTime()));
      const end = fyEnd;
      const totalDays = Math.max(0, (end - start) / 86400000);
      const leaveDays = leaves.reduce((sum, l) => {
        const ls = new Date(l.startDateTime), le = l.endDateTime ? new Date(l.endDateTime) : now;
        const s = Math.max(ls, start), e = Math.min(le, end);
        return e > s ? sum + (e - s) / 86400000 : sum;
      }, 0);
      const earned = Math.max(0, totalDays - leaveDays) * (emp.perDaySalary - emp.dailyPetta);
      const paid   = payments.reduce((s, p) => s + p.amount, 0);
      let carriedBalance = 0;
      for (let day = new Date(emp.startDate); day < fyStart; day.setDate(day.getDate() + 1)) {
        const leave = leaves.some(l => new Date(l.startDateTime) <= day && (!l.endDateTime || day <= new Date(l.endDateTime)));
        const dayKey = day.toISOString().slice(0, 10);
        const dayPaid = payments.filter(p => p.paymentDate === dayKey).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
        carriedBalance += (leave ? 0 : (emp.perDaySalary - emp.dailyPetta)) - dayPaid;
      }
      const balance = carriedBalance + earned - paid;
      const onLeave = leaves.some(l => new Date(l.startDateTime) <= now && (!l.endDateTime || now <= new Date(l.endDateTime)));
      return { emp, balance, onLeave };
    });

    const onLeaveCount   = empStats.filter(x => x.onLeave).length;
    const pendingSalCount = empStats.filter(x => !x.onLeave && x.balance > 0).length;
    const advanceCount   = empStats.filter(x => x.balance < 0).length;

    document.getElementById('stat-employees').textContent  = activeEmp.length;
    document.getElementById('stat-onleave').textContent    = onLeaveCount;
    document.getElementById('stat-pending-sal').textContent = pendingSalCount;
    document.getElementById('stat-advance').textContent    = advanceCount;
    document.getElementById('stat-expenses').textContent   = formatCurrency(totalExp);
    document.getElementById('stat-salaries').textContent   = formatCurrency(totalSal);
    document.getElementById('stat-pending').textContent    = pendingExp.length;

    renderCategoryChart(recentChartExpenses);
    renderTrendChart(recentChartExpenses, salesHistory, now);
    renderSalesExpenseChart(recentChartExpenses, salesHistory, now);
    renderRecentExpenses(expenses.slice(-6).reverse());
    renderEmployeeStatus(empStats);

  } catch (err) {
    showNotification('Failed to load dashboard: ' + err.message, 'danger');
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

function renderSalesExpenseChart(expenses, salesHistory = [], referenceDate = new Date()) {
  const ctx = document.getElementById('chartSalesExpense');
  if (!ctx) return;

  const days = Array.from({ length: 20 }, (_, index) => {
    const date = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() - (19 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), key };
  });
  const expenseData = days.map(day => expenses
    .filter(expense => expense.date === day.key)
    .reduce((sum, expense) => sum + (parseFloat(expense.amount) || 0), 0));
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
