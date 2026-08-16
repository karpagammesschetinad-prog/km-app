/* dashboard.js */

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  await loadDashboard();
});

async function loadDashboard() {
  try {
    const [expenses, employees, salaries] = await Promise.all([
      api('GET', '/expenses'),
      api('GET', '/employees'),
      api('GET', '/salaries')
    ]);

    const now = new Date();
    const cm = now.getMonth() + 1, cy = now.getFullYear();

    const monthExp = expenses.filter(e => {
      const d = new Date(e.date);
      return d.getMonth() + 1 === cm && d.getFullYear() === cy;
    });

    const monthSal = salaries.filter(s =>
      parseInt(s.month) === cm && parseInt(s.year) === cy
    );

    const activeEmp = employees.filter(e => e.status === 'Active');
    const pendingExp = expenses.filter(e => e.status === 'Pending');

    const totalExp = monthExp.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const totalSal = monthSal.reduce((s, e) => s + (parseFloat(e.netSalary) || 0), 0);

    document.getElementById('stat-employees').textContent = activeEmp.length;
    document.getElementById('stat-expenses').textContent = formatCurrency(totalExp);
    document.getElementById('stat-salaries').textContent = formatCurrency(totalSal);
    document.getElementById('stat-pending').textContent = pendingExp.length;

    renderCategoryChart(monthExp);
    renderTrendChart(expenses);
    renderRecentExpenses(expenses.slice(-6).reverse());

  } catch (err) {
    showNotification('Failed to load dashboard: ' + err.message, 'danger');
  }
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
      '<p class="text-center text-muted py-4 small">No expense data for this month</p>';
    return;
  }

  const COLORS = ['#3b82f6','#8b5cf6','#22c55e','#f59e0b','#ef4444','#06b6d4','#f97316','#ec4899','#84cc16'];
  const labels = Object.keys(cats), data = Object.values(cats);

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: COLORS.slice(0, labels.length), borderWidth: 0, hoverOffset: 8 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '66%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, padding: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${formatCurrency(c.raw)}` } }
      }
    }
  });
}

function renderTrendChart(expenses) {
  const ctx = document.getElementById('chartTrend');
  if (!ctx) return;

  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    return { label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), m: d.getMonth() + 1, y: d.getFullYear() };
  });

  const data = months.map(mo =>
    expenses
      .filter(e => { const d = new Date(e.date); return d.getMonth() + 1 === mo.m && d.getFullYear() === mo.y; })
      .reduce((s, e) => s + (parseFloat(e.amount) || 0), 0)
  );

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months.map(m => m.label),
      datasets: [{
        label: 'Expenses',
        data,
        backgroundColor: 'rgba(59,130,246,.8)',
        borderRadius: 6,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${formatCurrency(c.raw)}` } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { callback: v => formatCurrency(v) } },
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
      <td>${formatDate(e.date)}</td>
      <td><span class="badge bg-light text-dark border">${e.category}</span></td>
      <td class="text-muted">${e.description || '—'}</td>
      <td class="fw-semibold">${formatCurrency(e.amount)}</td>
      <td>${statusBadge(e.status)}</td>
    </tr>
  `).join('');
}
