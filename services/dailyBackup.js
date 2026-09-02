/* Nightly mirror of the live spreadsheet into the backup (development) spreadsheet.

   Enable with DAILY_BACKUP_ENABLED=true. Optional:
     DAILY_BACKUP_TIME=23:45           local time, defaults to 23:45
     SPREADSHEET_ID_BACKUP=<id>        defaults to SPREADSHEET_ID_DEVELOPMENT */

const { copySpreadsheetData } = require('./sheetCopy');
const { getSpreadsheetId } = require('../config/environment');

const DAY_MS = 86400000;
let timer = null;
let running = false;

function log(message) {
  console.log(`[daily-backup] ${message}`);
}

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return { hour: 23, minute: 45 };
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return { hour, minute };
}

function msUntilNextRun({ hour, minute }, now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

async function runBackup() {
  if (running) return;
  running = true;
  try {
    const sourceId = getSpreadsheetId();
    const targetId = process.env.SPREADSHEET_ID_BACKUP || process.env.SPREADSHEET_ID_DEVELOPMENT || '';
    if (!sourceId) throw new Error('No live spreadsheet configured.');
    if (!targetId) throw new Error('Set SPREADSHEET_ID_BACKUP or SPREADSHEET_ID_DEVELOPMENT to receive the backup.');

    const result = await copySpreadsheetData({
      sourceId,
      targetId,
      sourceCredentials: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      targetCredentials: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      targetLabel: 'backup-target',
      log
    });
    log(`completed. ${result.copied.length} sheet(s) mirrored into ${targetId}.`);
  } catch (err) {
    console.error(`[daily-backup] failed: ${err.message}`);
  } finally {
    running = false;
  }
}

function scheduleNext(time) {
  const delay = msUntilNextRun(time);
  timer = setTimeout(async () => {
    await runBackup();
    // Re-derive the delay each night so clock changes cannot drift the schedule.
    scheduleNext(time);
  }, delay);
  timer.unref?.();
  log(`next run in ${(delay / 3600000).toFixed(1)}h (${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')} local).`);
}

function startDailyBackup() {
  if (String(process.env.DAILY_BACKUP_ENABLED || '').toLowerCase() !== 'true') return false;
  if (timer) return true;
  const time = parseTime(process.env.DAILY_BACKUP_TIME);
  scheduleNext(time);
  return true;
}

function stopDailyBackup() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { startDailyBackup, stopDailyBackup, runBackup, msUntilNextRun, parseTime, DAY_MS };
