/* salaries.js — Salary Overview using per-day salary model */

let allEmpStats = [];

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('salaries')) { window.location.href = '/index.html'; return; }
  await loadSalaryPage();
});

async function loadSalaryPage() {
  document.getElementById('salBody').innerHTML = loadingRow(8);
  try {
    const [employees, allLeaves, allPayments] = await Promise.all([
      api('GET', '/employees'),
      api('GET', '/leaves'),
      api('GET', '/payments')
    ]);

    const now = new Date();
    const active = employees.filter(e => e.status === 'Active');

    allEmpStats = active.map(emp => {
      const leaves   = allLeaves.filter(l => l.employeeId === emp.id);
      const payments = allPayments.filter(p => p.employeeId === emp.id);

      const start = new Date(emp.startDate);
      const end   = new Date(); end.setHours(23, 59, 59, 999);
      const totalDays = Math.max(0, (end - start) / 86400000);

      const leaveDays = leaves.reduce((sum, l) => {
        const ls = new Date(l.startDateTime), le = new Date(l.endDateTime);
        const s = Math.max(ls, start), e = Math.min(le, end);
        return e > s ? sum + (e - s) / 86400000 : sum;
      }, 0);

      const workedDays = Math.max(0, totalDays - leaveDays);
      const earned     = workedDays * (emp.perDaySalary - emp.dailyPetta);
      const totalPaid  = payments.reduce((s, p) => s + p.amount, 0);
      const balance    = earned - totalPaid;
      const onLeave    = leaves.some(l => new Date(l.startDateTime) <= now && now <= new Date(l.endDateTime));

      return { emp, workedDays, earned, totalPaid, balance, onLeave };
    });

    renderStats(allEmpStats);
    renderTable(allEmpStats);

  } catch (err) {
    document.getElementById('salBody').innerHTML = emptyRow(8, 'Failed to load salary data.');
    showNotification('Error: ' + err.message, 'danger');
  }
}

function renderStats(stats) {
  const pendingCount = stats.filter(x => x.balance > 0).length;
  const advanceCount = stats.filter(x => x.balance < 0).length;
  const totalPaid    = stats.reduce((s, x) => s + x.totalPaid, 0);

  document.getElementById('ss-total').textContent   = stats.length;
  document.getElementById('ss-pending').textContent = pendingCount;
  document.getElementById('ss-advance').textContent = advanceCount;
  document.getElementById('ss-paid').textContent    = formatCurrency(totalPaid);
}

function renderTable(stats) {
  const tbody = document.getElementById('salBody');
  if (!stats.length) { tbody.innerHTML = emptyRow(8, 'No active employees.'); return; }

  tbody.innerHTML = stats.map(({ emp, workedDays, earned, totalPaid, balance, onLeave }) => {
    const isAdv    = balance < 0;
    const balAbs   = Math.abs(balance);
    const balColor = isAdv ? 'warning' : (balance > 0 ? 'danger' : 'success');
    const balLabel = isAdv ? 'Advance' : (balance > 0 ? 'Pending' : 'Settled');

    return `<tr>
      <td>
        <a href="/employee-detail.html?id=${emp.id}" class="fw-semibold text-decoration-none">${emp.name}</a>
        ${onLeave ? '<span class="badge bg-primary ms-1">On Leave</span>' : ''}
        ${emp.phone ? `<div class="text-muted small">${emp.phone}</div>` : ''}
      </td>
      <td>${formatDate(emp.startDate)}</td>
      <td>${formatCurrency(emp.perDaySalary)}<span class="text-muted small"> &minus; ${formatCurrency(emp.dailyPetta)}</span></td>
      <td>${workedDays.toFixed(1)} days</td>
      <td class="text-success fw-semibold">${formatCurrency(earned)}</td>
      <td class="text-info fw-semibold">${formatCurrency(totalPaid)}</td>
      <td>
        <span class="badge bg-${balColor}-subtle text-${balColor} border border-${balColor}-subtle px-2 py-1">
          ${balLabel}: ${formatCurrency(balAbs)}
        </span>
      </td>
      <td>
        <a href="/employee-detail.html?id=${emp.id}" class="btn btn-xs btn-outline-primary btn-action">
          <i class="bi bi-eye"></i>
        </a>
      </td>
    </tr>`;
  }).join('');
}

function filterTable() {
  const q = document.getElementById('salSearch').value.toLowerCase();
  const filtered = allEmpStats.filter(x => x.emp.name.toLowerCase().includes(q));
  renderTable(filtered);
}