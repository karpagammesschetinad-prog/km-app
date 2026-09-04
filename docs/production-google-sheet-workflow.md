# Production Google Sheet Data Model Rollout Workflow

This workflow is for applying schema and data-model changes safely to the production Google Sheet used by this app.

## Scope

Use this whenever any of the following changes are introduced:

- New sheet tabs
- New columns in existing tabs
- New required settings keys
- Behavior changes that depend on specific column names

This project applies sheet schema through application startup logic in services/googleSheets.js.

## 1. Pre-Deployment Checklist

1. Confirm code is merged and reviewed.
2. Confirm production environment variables are ready:
   - NODE_ENV=production
   - SPREADSHEET_ID_PRODUCTION is set
   - GOOGLE_SERVICE_ACCOUNT_KEY is valid JSON and has access to the production sheet
3. Confirm service account has Editor access on production spreadsheet.
4. Announce a short maintenance window (recommended 10-15 minutes) to avoid active writes during migration.

## 2. Backup Before Any Change

1. Open production spreadsheet in Google Sheets UI.
2. Create a full copy manually:
   - File -> Make a copy
   - Name it with timestamp, for example:
     BizTracker-Prod-Backup-YYYYMMDD-HHMM
3. Store backup spreadsheet ID in deployment notes.

Optional extra backup:
- Export all tabs to XLSX and store in release artifacts.

## 3. Dry Run Against Non-Production First

Run the safe migration on the development sheet before touching production. It creates a backup, expands sheet headers, and adds any newly introduced default Settings keys without changing existing configured values:

PowerShell:

npm run migrate:dev:safe

Verify tab headers and app behavior on development.

## 4. Apply Migration to Production Sheet

From repository root:

PowerShell:

npm run migrate:prod:safe

What this does:
- Creates missing tabs
- Writes headers for newly created tabs
- Expands headers for known schema-growth cases
- Adds missing default Settings keys while preserving existing values

## 5. Start App in Production Mode and Smoke Test

1. Start app:

npm run start:prod

2. Verify basic health:

Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/api/health
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/api/config

3. Log in as superuser and test critical flows:
- Settings page loads and saves
- Sales capture loads and saves
- Expenses create flow works
- Summary screens render

## 6. Data Model Validation Checklist

After migration, validate these production tabs and key columns exist:

- SalesEntries
  - ID, Date, Shift, PaymentType, OnlineVendor, Amount, EnteredBy, CreatedAt, UpdatedAt
- Settings
  - Keys expected by app such as PAYMENT_TYPES, ONLINE_VENDORS, IDLE_TIMEOUT_MINUTES
- ExpenseCategoryTypes
  - DisplayText column exists

Also verify no unexpected duplicate columns were created.

## 7. Rollback Plan

If validation fails:

1. Stop production app process.
2. Point production environment to backup sheet by updating SPREADSHEET_ID_PRODUCTION.
3. Restart app in production mode.
4. Re-test health and login flows.
5. Investigate migration issue in development before retry.

## 8. Operational Guardrails

- Never paste or log private keys in chat, logs, or tickets.
- Keep migration and rollout notes per release.
- Do not apply direct manual header edits in production unless rollback is prepared.
- Prefer additive schema changes over destructive edits.

## 9. Recommended Release Sequence

1. Code deploy
2. Backup production sheet
3. Run initializeSheets migration in production mode
4. Start app in production mode
5. Execute smoke tests
6. Announce completion

## 10. Optional Improvement (Future)

Add a schema version key in Settings, for example DATA_MODEL_VERSION, and fail startup when required model version is missing. This gives explicit migration visibility and safer deployments.
