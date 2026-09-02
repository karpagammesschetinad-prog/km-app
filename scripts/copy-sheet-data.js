/* Copies sheet data between the development and production spreadsheets.

   Usage:
     node scripts/copy-sheet-data.js --from=prod --to=dev            (dry run)
     node scripts/copy-sheet-data.js --from=prod --to=dev --yes      (apply)
     node scripts/copy-sheet-data.js --from=dev --to=prod --yes --sheets=Expenses,Sales

   The target spreadsheet is always backed up to backups/ before anything is written. */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { sheetsClient, readAllSheets, copySpreadsheetData } = require('../services/sheetCopy');

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach(item => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(item);
    if (match) args[match[1].toLowerCase()] = match[2] === undefined ? 'true' : match[2];
  });
  return args;
}

function normalizeEnvironment(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'prod' || normalized === 'production') return 'production';
  if (normalized === 'dev' || normalized === 'development') return 'development';
  throw new Error(`--${label} must be "dev" or "prod".`);
}

function readEnvFile(fileName) {
  const filePath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath));
}

const ENV_FILES = {
  development: readEnvFile('.env'),
  production: readEnvFile('.env.production')
};

function settingFor(env, key) {
  return ENV_FILES[env][key] || process.env[key] || '';
}

function spreadsheetIdFor(env) {
  const id = env === 'production'
    ? settingFor(env, 'SPREADSHEET_ID_PRODUCTION')
    : settingFor(env, 'SPREADSHEET_ID_DEVELOPMENT') || settingFor(env, 'SPREADSHEET_ID');
  if (!id) throw new Error(`No spreadsheet id configured for ${env}. Set SPREADSHEET_ID_${env.toUpperCase()}.`);
  return id;
}

function sheetsClientFor(env, scopes) {
  return sheetsClient(settingFor(env, 'GOOGLE_SERVICE_ACCOUNT_KEY'), scopes);
}

async function run() {
  const args = parseArgs();
  const from = normalizeEnvironment(args.from, 'from');
  const to = normalizeEnvironment(args.to, 'to');
  if (from === to) throw new Error('--from and --to must be different environments.');

  const sourceId = spreadsheetIdFor(from);
  const targetId = spreadsheetIdFor(to);
  if (sourceId === targetId) throw new Error('Source and target spreadsheets are the same id. Aborting.');

  const only = String(args.sheets || '').split(',').map(value => value.trim()).filter(Boolean);
  // `npm run copy:... --yes` is swallowed by npm, which exposes it as npm_config_yes instead.
  const apply = args.yes === 'true' || process.env.npm_config_yes === 'true';

  console.log(`[copy-sheet] ${from} (${sourceId}) -> ${to} (${targetId})`);

  if (!apply) {
    const preview = await readAllSheets(sheetsClientFor(from, ['https://www.googleapis.com/auth/spreadsheets.readonly']), sourceId);
    Object.keys(preview.data)
      .filter(title => !only.length || only.includes(title))
      .forEach(title => console.log(`[copy-sheet]   ${title}: ${Math.max(0, preview.data[title].length - 1)} data rows`));
    console.log(`[copy-sheet] dry run only. Re-run with "npm run copy:${from === 'development' ? 'dev-to-prod' : 'prod-to-dev'} -- --yes" to overwrite the target sheets listed above.`);
    return;
  }

  const result = await copySpreadsheetData({
    sourceId,
    targetId,
    sourceCredentials: settingFor(from, 'GOOGLE_SERVICE_ACCOUNT_KEY'),
    targetCredentials: settingFor(to, 'GOOGLE_SERVICE_ACCOUNT_KEY'),
    only,
    targetLabel: to,
    log: message => console.log(`[copy-sheet] ${message}`)
  });

  console.log(`[copy-sheet] done. ${result.copied.length} sheet(s) copied from ${from} to ${to}.`);
}

run().catch(err => {
  console.error(`[copy-sheet] failed: ${err.message}`);
  process.exit(1);
});
