/* dashboard.js */

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
    const [expenses, employees, salaries, allLeaves, allPayments, config] = await Promise.all([
      fetchNamed('Expenses', '/expenses'),
      fetchNamed('Employees', '/employees'),
      fetchNamed('Salaries', '/salaries'),
      fetchNamed('Leaves', '/leaves'),
      fetchNamed('Payments', '/payments'),
      fetchNamed('Configuration', '/config')
    ]);

    const now = new Date();
    const fyStart = new Date(config.fiscalYear.start + 'T00:00:00');
    const fyEnd = new Date(Math.min(now.getTime(), new Date(config.fiscalYear.end + 'T23:59:59').getTime()));

    const monthExp = expenses.filter(e => {
      const d = new Date(e.date);
      return d >= fyStart && d <= fyEnd;
    });

    const monthSal = salaries.filter(s => s.paymentDate && new Date(s.paymentDate) >= fyStart && new Date(s.paymentDate) <= fyEnd);

    const activeEmp = employees.filter(e => e.status === 'Active');
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

    renderCategoryChart(monthExp);
    renderTrendChart(expenses);
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
      <td data-label="Date">${formatDate(e.date)}</td>
      <td data-label="Category"><span class="badge bg-light text-dark border">${e.category}</span></td>
      <td data-label="Description" class="text-muted">${e.description || '—'}</td>
      <td data-label="Amount" class="fw-semibold">${formatCurrency(e.amount)}</td>
      <td data-label="Status">${statusBadge(e.status)}</td>
    </tr>
  `).join('');
}
