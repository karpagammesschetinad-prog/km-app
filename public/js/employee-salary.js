/* Shared Employee Detail salary calculation, also used by directory PDF export. */
function calculateEmployeeDetailSalary({ employee, leaves = [], payments = [], pettaHistory = [], salaryHistory = [], start, end }) {
  const dateOnly = value => {
    if (!value) return null;
    const parts = String(value).slice(0, 10).split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  };
  const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const next = date => { const result = new Date(date); result.setDate(result.getDate() + 1); return result; };
  const employeeStart = dateOnly(employee.startDate);
  const paymentDays = new Map();
  payments.forEach(payment => {
    const date = String(payment.paymentDate || '').slice(0, 10);
    const day = paymentDays.get(date) || { paid: 0, bonus: 0 };
    day.paid += parseFloat(payment.amount) || 0;
    day.bonus += parseFloat(payment.bonusAmount) || 0;
    paymentDays.set(date, day);
  });
  if (employee.temporaryEmployee) {
    const periods = [...paymentDays.entries()].filter(([date]) => (!start || dateOnly(date) >= start) && (!end || dateOnly(date) <= end))
      .sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({
        start: dateOnly(date), end: dateOnly(date), petta: employee.dailySalaryEnabled ? parseFloat(employee.dailyPetta) || 0 : 0,
        totalDays: 1, leaveDays: 0, workedDays: 1, earned: day.paid, paid: day.paid, opening: 0, closing: 0
      }));
    const totalPaid = periods.reduce((sum, period) => sum + period.paid, 0);
    return { totalDays: periods.length.toFixed(1), leaveDays: '0.0', workedDays: periods.length.toFixed(1), earnedSalary: totalPaid, totalPaid, balance: 0, currentPetta: employee.dailySalaryEnabled ? parseFloat(employee.dailyPetta) || 0 : 0, periods };
  }
  const calculationStart = employeeStart > start ? employeeStart : start;
  if (!employeeStart || !start || !end || calculationStart > end) {
    return { totalDays: '0.0', leaveDays: '0.0', workedDays: '0.0', earnedSalary: 0, totalPaid: 0, balance: 0, currentPetta: parseFloat(employee.dailyPetta) || 0, periods: [] };
  }
  const timeline = records => records.map(record => ({ date: dateOnly(record.effectiveDate), amount: parseFloat(record.amount) || 0 }))
    .filter(record => record.date).sort((a, b) => a.date - b.date);
  const pettaChanges = timeline(pettaHistory);
  const salaryChanges = timeline(salaryHistory);
  const amountOn = (date, base, changes) => {
    let amount = parseFloat(base) || 0;
    changes.forEach(change => { if (change.date <= date) amount = change.amount; });
    return amount;
  };
  const rateOn = date => amountOn(date, employee.perDaySalary, salaryChanges);
  const pettaOn = date => amountOn(date, employee.dailyPetta, pettaChanges);
  const leaveSpans = leaves.map(leave => {
    const first = dateOnly(leave.startDateTime);
    if (!first) return null;
    const rawEnd = leave.endDateTime ? new Date(leave.endDateTime) : null;
    const now = new Date();
    if (!rawEnd || Number.isNaN(rawEnd.getTime())) return { start: first, end: new Date(now.getFullYear(), now.getMonth(), now.getDate()), fraction: 1 };
    const lastInstant = new Date(rawEnd.getTime() - 1);
    const last = new Date(lastInstant.getFullYear(), lastInstant.getMonth(), lastInstant.getDate());
    const hours = (rawEnd - new Date(leave.startDateTime)) / 3600000;
    return { start: first, end: last < first ? first : last, fraction: hours > 0 && hours <= 12 && key(last) === key(first) ? 0.5 : 1 };
  }).filter(Boolean);
  const leaveOn = date => Math.min(1, leaveSpans.reduce((sum, span) => sum + (date >= span.start && date <= span.end ? span.fraction : 0), 0));
  let opening = parseFloat(employee.openingBalance) || 0;
  for (let date = new Date(employeeStart); date < calculationStart; date = next(date)) {
    const day = paymentDays.get(key(date)) || { paid: 0, bonus: 0 };
    opening += (1 - leaveOn(date)) * (rateOn(date) - pettaOn(date)) + day.bonus - day.paid;
  }
  const changes = new Set([...pettaChanges, ...salaryChanges].map(change => key(change.date)));
  let totalDays = 0, leaveDays = 0, workedDays = 0, earnedSalary = 0, totalPaid = 0, totalBonus = 0;
  let segment = { start: new Date(calculationStart), totalDays: 0, leaveDays: 0, workedDays: 0, earned: 0, paid: 0, opening };
  let balance = opening;
  const periods = [];
  for (let date = new Date(calculationStart); date <= end; date = next(date)) {
    const leave = leaveOn(date);
    const worked = 1 - leave;
    const day = paymentDays.get(key(date)) || { paid: 0, bonus: 0 };
    const earned = worked * (rateOn(date) - pettaOn(date)) + day.bonus;
    totalDays++; leaveDays += leave; workedDays += worked;
    earnedSalary += earned; totalPaid += day.paid; totalBonus += day.bonus;
    segment.totalDays++; segment.leaveDays += leave; segment.workedDays += worked;
    segment.earned += earned; segment.paid += day.paid;
    if (date.getTime() === end.getTime() || changes.has(key(next(date))) || day.paid > 0) {
      balance = segment.opening + segment.earned - segment.paid;
      periods.push({ ...segment, end: new Date(date), petta: pettaOn(segment.start), perDay: rateOn(segment.start), closing: balance });
      segment = { start: next(date), totalDays: 0, leaveDays: 0, workedDays: 0, earned: 0, paid: 0, opening: balance };
    }
  }
  return {
    totalDays: totalDays.toFixed(1), leaveDays: leaveDays.toFixed(1), workedDays: workedDays.toFixed(1), earnedSalary, totalBonus,
    totalPaid: employee.dailySalaryEnabled ? earnedSalary : totalPaid,
    balance: employee.dailySalaryEnabled ? 0 : balance,
    currentPetta: pettaOn(end), currentPerDay: rateOn(end),
    periods: employee.dailySalaryEnabled ? periods.map(period => ({ ...period, paid: period.earned, opening: 0, closing: 0 })) : periods
  };
}