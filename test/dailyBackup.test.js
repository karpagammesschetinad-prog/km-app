const test = require('node:test');
const assert = require('node:assert/strict');

const { msUntilNextRun, parseTime } = require('../services/dailyBackup');

test('the backup time falls back to 23:45 when unset or invalid', () => {
  assert.deepEqual(parseTime(undefined), { hour: 23, minute: 45 });
  assert.deepEqual(parseTime('nope'), { hour: 23, minute: 45 });
  assert.deepEqual(parseTime('7:05'), { hour: 7, minute: 5 });
  assert.deepEqual(parseTime('99:99'), { hour: 23, minute: 59 });
});

test('the next run is later today, or tomorrow once the time has passed', () => {
  const time = { hour: 23, minute: 45 };
  const beforeRun = new Date(2026, 8, 2, 20, 45, 0);
  assert.equal(msUntilNextRun(time, beforeRun), 3 * 3600000);

  const afterRun = new Date(2026, 8, 2, 23, 45, 0);
  assert.equal(msUntilNextRun(time, afterRun), 86400000);
});
