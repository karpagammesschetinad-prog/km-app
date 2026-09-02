/* Shared spreadsheet copy helpers used by the CLI script and the nightly backup job. */

const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

function timestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const rangeFor = title => `'${String(title).replace(/'/g, "''")}'!A1:ZZ`;

function sheetsClient(credentialsJson, scopes) {
  if (!credentialsJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set.');
  const credentials = typeof credentialsJson === 'string' ? JSON.parse(credentialsJson) : credentialsJson;
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is invalid. Missing client_email/private_key.');
  }
  const auth = new google.auth.JWT({ email: credentials.client_email, key: credentials.private_key, scopes });
  return google.sheets({ version: 'v4', auth });
}

async function readAllSheets(client, spreadsheetId) {
  const metadata = await client.spreadsheets.get({ spreadsheetId });
  const tabs = (metadata.data.sheets || []).map(item => item.properties).filter(Boolean);
  const data = {};
  for (const tab of tabs) {
    const res = await client.spreadsheets.values.get({ spreadsheetId, range: rangeFor(tab.title) });
    data[tab.title] = res.data.values || [];
  }
  return { title: metadata.data.properties?.title || '', tabs, data };
}

function writeLocalBackup(label, spreadsheetId, snapshot) {
  const backupDir = path.resolve(process.cwd(), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const filePath = path.join(backupDir, `sheet-backup-${label}-${timestamp()}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    environment: label,
    spreadsheetId,
    capturedAt: new Date().toISOString(),
    sheetTitles: Object.keys(snapshot.data),
    valuesBySheet: snapshot.data
  }, null, 2), 'utf8');
  return filePath;
}

async function ensureTab(client, spreadsheetId, title, existingTitles) {
  if (existingTitles.has(title)) return;
  await client.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [{ addSheet: { properties: { title } } }] }
  });
  existingTitles.add(title);
}

// Replaces the target tabs with the source values. The target is snapshotted to backups/ first.
async function copySpreadsheetData({ sourceId, targetId, sourceCredentials, targetCredentials, only = [], targetLabel = 'target', log = () => {} }) {
  if (!sourceId || !targetId) throw new Error('Both source and target spreadsheet ids are required.');
  if (sourceId === targetId) throw new Error('Source and target spreadsheets are the same id. Aborting.');

  const sourceClient = sheetsClient(sourceCredentials, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const targetClient = sheetsClient(targetCredentials, ['https://www.googleapis.com/auth/spreadsheets']);

  const source = await readAllSheets(sourceClient, sourceId);
  const titles = Object.keys(source.data).filter(title => !only.length || only.includes(title));
  if (!titles.length) throw new Error('No matching sheets found in the source spreadsheet.');

  const targetSnapshot = await readAllSheets(targetClient, targetId);
  const backupPath = writeLocalBackup(targetLabel, targetId, targetSnapshot);
  log(`target backup written: ${backupPath}`);

  const existingTitles = new Set(targetSnapshot.tabs.map(tab => tab.title));
  for (const title of titles) {
    await ensureTab(targetClient, targetId, title, existingTitles);
    await targetClient.spreadsheets.values.clear({ spreadsheetId: targetId, range: rangeFor(title) });
    const values = source.data[title];
    if (values.length) {
      await targetClient.spreadsheets.values.update({
        spreadsheetId: targetId,
        range: rangeFor(title),
        valueInputOption: 'RAW',
        resource: { values }
      });
    }
    log(`copied ${title}`);
  }

  return { copied: titles, backupPath };
}

module.exports = { sheetsClient, readAllSheets, writeLocalBackup, copySpreadsheetData, rangeFor, timestamp };
