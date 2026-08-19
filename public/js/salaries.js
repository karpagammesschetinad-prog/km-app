/* salaries.js - Salary overview with date-wise petta and settlement periods */

let allEmpStats = [];
let allPaymentsLog = [];

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;
  if (!canAccess('salaries')) { window.location.href = '/index.html'; return; }
  await loadSalaryPage();
});

function parseDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const s = String(value).slice(0, 10);
  const parts = s.split('-').map(Number);
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLeaveFractionForDay(dayStart, leaves) {
  const dayEnd = addDays(dayStart, 1);
  let frac = 0;
  leaves.forEach(l => {
    const ls = new Date(l.startDateTime);
    const le = new Date(l.endDateTime);
    const s = new Date(Math.max(ls.getTime(), dayStart.getTime()));
    const e = new Date(Math.min(le.getTime(), dayEnd.getTime()));
    if (e > s) frac += (e - s) / 86400000;
  });
  return Math.max(0, Math.min(1, frac));
}

function buildPettaTimeline(emp, pettaHistory) {
  const base = parseFloat(emp.dailyPetta) || 0;
  const entries = (pettaHistory || [])
    .map(p => ({ date: parseDateOnly(p.effectiveDate), amount: parseFloat(p.amount) || 0 }))
    .filter(x => x.date)
    .sort((a, b) => a.date - b.date);
  return { base, entries };
}

function getPettaForDate(day, timeline) {
  let amount = timeline.base;
  for (const p of timeline.entries) {
    if (p.date <= day) amount = p.amount;
    else break;
  }
  return amount;
}

function calcEmployeeSalary(emp, leaves, payments, pettaHistory) {
  const start = parseDateOnly(emp.startDate);
  const today = parseDateOnly(new Date());
  if (!start || !today || start > today) {
    return { workedDays: 0, earned: 0, totalPaid: 0, balance: 0, currentPetta: parseFloat(emp.dailyPetta) || 0 };
  }

  const perDaySalary = parseFloat(emp.perDaySalary) || 0;
  const timeline = buildPettaTimeline(emp, pettaHistory);

  const paymentMap = new Map();
  (payments || []).forEach(p => {
    const d = parseDateOnly(p.paymentDate);
    if (!d || d < start || d > today) return;
    const key = dateKey(d);
    paymentMap.set(key, (paymentMap.get(key) || 0) + (parseFloat(p.amount) || 0));
  });

  const pettaChangeKeys = new Set(
    timeline.entries
      .filter(p => p.date >= start && p.date <= today)
      .map(p => dateKey(p.date))
  );

  let totalPaid = 0;
  let workedDays = 0;
  let earned = 0;
  let runningBalance = 0;

  let segEarned = 0;
  let segPaid = 0;
  let segOpening = 0;

  for (let day = new Date(start); day <= today; day = addDays(day, 1)) {
    const leaveFrac = getLeaveFractionForDay(day, leaves);
    const workedFrac = Math.max(0, 1 - leaveFrac);
    const petta = getPettaForDate(day, timeline);
    const netPerDay = perDaySalary - petta;

    const dayPaid = paymentMap.get(dateKey(day)) || 0;

    workedDays += workedFrac;
    earned += workedFrac * netPerDay;
    totalPaid += dayPaid;

    segEarned += workedFrac * netPerDay;
    segPaid += dayPaid;

    const nextDay = addDays(day, 1);
    const isToday = day.getTime() === today.getTime();
    const pettaChangesTomorrow = nextDay <= today && pettaChangeKeys.has(dateKey(nextDay));
    const paymentSettledToday = dayPaid > 0;

    if (isToday || pettaChangesTomorrow || paymentSettledToday) {
      const segClosing = segOpening + segEarned - segPaid;
      runningBalance = segClosing;
      segOpening = segClosing;
      segEarned = 0;
      segPaid = 0;
    }
  }

  return {
    workedDays,
    earned,
    totalPaid,
    balance: runningBalance,
    currentPetta: getPettaForDate(today, timeline)
  };
}

async function loadSalaryPage() {
  document.getElementById('salBody').innerHTML = loadingRow(8);
  try {
    const [employees, allLeaves, allPayments, allPetta] = await Promise.all([
      api('GET', '/employees'),
      api('GET', '/leaves'),
      api('GET', '/payments'),
      api('GET', '/petta')
    ]);

    allPaymentsLog = allPayments;

    const now = new Date();
    const active = employees.filter(e => e.status === 'Active');

    allEmpStats = active.map(emp => {
      const leaves = allLeaves.filter(l => l.employeeId === emp.id);
      const payments = allPayments.filter(p => p.employeeId === emp.id);
      const pettaHistory = allPetta.filter(p => p.employeeId === emp.id);

      const sal = calcEmployeeSalary(emp, leaves, payments, pettaHistory);
      const onLeave = leaves.some(l => new Date(l.startDateTime) <= now && now <= new Date(l.endDateTime));

      return {
        emp,
        workedDays: sal.workedDays,
        earned: sal.earned,
        totalPaid: sal.totalPaid,
        balance: sal.balance,
        currentPetta: sal.currentPetta,
        onLeave
      };
    });

    renderStats(allEmpStats);
    renderTable(allEmpStats);
    renderPaymentLog(allPaymentsLog, employees);
  } catch (err) {
    document.getElementById('salBody').innerHTML = emptyRow(8, 'Failed to load salary data.');
    showNotification('Error: ' + err.message, 'danger');
  }
}

function renderStats(stats) {
  const pendingCount = stats.filter(x => x.balance > 0).length;
  const advanceCount = stats.filter(x => x.balance < 0).length;
  const totalPaid = stats.reduce((s, x) => s + x.totalPaid, 0);

  document.getElementById('ss-total').textContent = stats.length;
  document.getElementById('ss-pending').textContent = pendingCount;
  document.getElementById('ss-advance').textContent = advanceCount;
  document.getElementById('ss-paid').textContent = formatCurrency(totalPaid);
}

function renderTable(stats) {
  const tbody = document.getElementById('salBody');
  if (!stats.length) { tbody.innerHTML = emptyRow(8, 'No active employees.'); return; }

  tbody.innerHTML = stats.map(({ emp, workedDays, earned, totalPaid, balance, currentPetta, onLeave }) => {
    const isAdv = balance < 0;
    const balAbs = Math.abs(balance);
    const balColor = isAdv ? 'warning' : (balance > 0 ? 'danger' : 'success');
    const balLabel = isAdv ? 'Advance' : (balance > 0 ? 'Pending' : 'Settled');

    return `<tr>
      <td>
        <a href="/employee-detail.html?id=${emp.id}" class="fw-semibold text-decoration-none">${emp.name}</a>
        ${onLeave ? '<span class="badge bg-primary ms-1">On Leave</span>' : ''}
        ${emp.phone ? `<div class="text-muted small">${emp.phone}</div>` : ''}
      </td>
      <td>${formatDate(emp.startDate)}</td>
      <td>${formatCurrency(emp.perDaySalary)}<span class="text-muted small"> - ${formatCurrency(currentPetta)}</span></td>
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

function renderPaymentLog(payments, employees) {
  const tbody = document.getElementById('payLogBody');
  if (!tbody) return;

  const sorted = [...payments].sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));

  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-3">No payment records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map(p => {
    const emp = employees.find(e => e.id === p.employeeId);
    return `<tr>
      <td>${formatDate(p.paymentDate)}</td>
      <td>
        <a href="/employee-detail.html?id=${p.employeeId}" class="fw-semibold text-decoration-none">${p.employeeName}</a>
        ${emp ? `<div class="text-muted small">${emp.phone || ''}</div>` : ''}
      </td>
      <td class="fw-semibold text-success">${formatCurrency(p.amount)}</td>
      <td>${p.remarks || '-'}</td>
      <td class="text-muted small">${p.createdBy || '-'}</td>
    </tr>`;
  }).join('');

  const badge = document.getElementById('payLogCount');
  if (badge) badge.textContent = sorted.length;
}
