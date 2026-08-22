const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { google } = require('googleapis');

function parseTargetEnvironment() {
  const arg = String(process.argv[2] || '').toLowerCase();
  if (arg === 'production' || arg === 'prod') return 'production';
  return 'development';
}

function loadEnvironment(env) {
  process.env.NODE_ENV = env;
  const envPath = env === 'production'
    ? path.resolve(process.cwd(), '.env.production')
    : path.resolve(process.cwd(), '.env');
  dotenv.config({ path: envPath });
  dotenv.config();
}

function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set.');
  const credentials = JSON.parse(raw);
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is invalid. Missing client_email/private_key.');
  }
  return credentials;
}

function getTimestamp() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

async function backupSpreadsheet(spreadsheetId, env) {
  const credentials = getCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const source = await sheets.spreadsheets.get({ spreadsheetId });
  const sourceName = source.data.properties?.title || 'BizTrackerSheet';
  const backupName = `${sourceName}-Backup-${env}-${getTimestamp()}`;

  const copy = await drive.files.copy({
    fileId: spreadsheetId,
    requestBody: { name: backupName },
    fields: 'id,name,webViewLink'
  });

  return {
    id: copy.data.id,
    name: copy.data.name,
    webViewLink: copy.data.webViewLink
  };
}

async function backupSpreadsheetLocally(spreadsheetId, env) {
  const credentials = getCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const metadata = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetTitles = (metadata.data.sheets || []).map(item => item.properties?.title).filter(Boolean);
  const valuesBySheet = {};

  for (const title of sheetTitles) {
    const escaped = `'${String(title).replace(/'/g, "''")}'!A1:ZZ`;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: escaped });
    valuesBySheet[title] = res.data.values || [];
  }

  const backupDir = path.resolve(process.cwd(), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const fileName = `sheet-backup-${env}-${getTimestamp()}.json`;
  const filePath = path.join(backupDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify({
    environment: env,
    spreadsheetId,
    capturedAt: new Date().toISOString(),
    sheetTitles,
    valuesBySheet
  }, null, 2), 'utf8');

  return filePath;
}

async function run() {
  const env = parseTargetEnvironment();
  loadEnvironment(env);

  const { getSpreadsheetId } = require('../config/environment');
  const spreadsheetId = getSpreadsheetId();
  if (!spreadsheetId) {
    throw new Error(`No spreadsheet configured for ${env}. Check SPREADSHEET_ID_${env.toUpperCase()}.`);
  }

  console.log(`[safe-migrate] target environment: ${env}`);
  console.log('[safe-migrate] creating backup copy...');
  try {
    const backup = await backupSpreadsheet(spreadsheetId, env);
    console.log(`[safe-migrate] backup created: ${backup.name}`);
    console.log(`[safe-migrate] backup spreadsheet id: ${backup.id}`);
    if (backup.webViewLink) console.log(`[safe-migrate] backup link: ${backup.webViewLink}`);
  } catch (err) {
    const msg = String(err.message || '').toLowerCase();
    if (msg.includes('storage quota')) {
      console.log('[safe-migrate] drive-copy backup failed due to quota. Falling back to local JSON backup...');
      const backupFilePath = await backupSpreadsheetLocally(spreadsheetId, env);
      console.log(`[safe-migrate] local backup created: ${backupFilePath}`);
    } else {
      throw err;
    }
  }

  console.log('[safe-migrate] applying data model migration...');
  const { initializeSheets } = require('../services/googleSheets');
  await initializeSheets();
  console.log('[safe-migrate] migration completed successfully.');
}

run().catch(err => {
  console.error(`[safe-migrate] failed: ${err.message}`);
  process.exit(1);
});
