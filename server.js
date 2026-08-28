require('dotenv').config(); // no-op if env already loaded by Electron
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { initializeSheets } = require('./services/googleSheets');
const { SHEETS, getAllRows, trackSheetUsage, getSheetUsage } = require('./services/googleSheets');
const { requireSuperUser } = require('./middleware/authMiddleware');
const { environment, getSpreadsheetId } = require('./config/environment');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'biztracker-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// Keep API data network-only so cached assets never affect synchronization or writes.
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// Per-request Google Sheets call accounting. Enable with LOG_SHEET_CALLS=true.
if (String(process.env.LOG_SHEET_CALLS || '').toLowerCase() === 'true') {
  app.use('/api', (req, res, next) => {
    const startedAt = Date.now();
    trackSheetUsage(() => {
      const usage = getSheetUsage();
      res.on('finish', () => {
        const detail = Object.entries(usage.sheets)
          .map(([sheet, counts]) => `${sheet}:${counts.reads}r/${counts.writes}w`)
          .join(' ');
        console.log(`[sheets] ${req.method} ${req.originalUrl} — ${usage.reads} reads, ${usage.writes} writes, ` +
          `${usage.cacheHits} cached, ${usage.coalesced} coalesced, ${Date.now() - startedAt}ms${detail ? ` | ${detail}` : ''}`);
      });
      next();
    });
  });
}

// Cache static assets briefly; ETag revalidation picks up deployed changes safely.
const staticCacheHeaders = res => { res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate'); };
app.use('/js', express.static(path.join(__dirname, 'public/js'), { setHeaders: staticCacheHeaders }));
app.use('/css', express.static(path.join(__dirname, 'public/css'), { setHeaders: staticCacheHeaders }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: staticCacheHeaders }));

// Config endpoint (public)
app.get('/api/config', async (req, res) => {
  let settings = [];
  try { settings = await getAllRows(SHEETS.SETTINGS); } catch (_) {}
  const getSetting = key => settings.find(row => row[0] === key)?.[1];
  const configuredStart = getSetting('FY_START_DATE');
  const configuredEnd = getSetting('FY_END_DATE');
  const idleTimeoutMinutes = Math.min(1440, Math.max(1, parseInt(getSetting('IDLE_TIMEOUT_MINUTES'), 10) || 15));
  const paymentTypes = String(getSetting('PAYMENT_TYPES') || 'Cash').split(',').map(value => value.trim()).filter(Boolean);
  const onlineVendors = String(getSetting('ONLINE_VENDORS') || '').split(',').map(value => value.trim()).filter(Boolean);
  const autoSaveEnabled = String(getSetting('AUTO_SAVE_ENABLED') || 'true').toLowerCase() === 'true';
  if (configuredStart && configuredEnd) {
    return res.json({ success: true, data: { currency: process.env.CURRENCY || 'USD', idleTimeoutMinutes, paymentTypes, onlineVendors, autoSaveEnabled, fiscalYear: { start: configuredStart, end: configuredEnd } } });
  }
  const startMonth = Math.min(12, Math.max(1, parseInt(getSetting('FY_START_MONTH'), 10) || 4));
  const startDay = Math.min(28, Math.max(1, parseInt(getSetting('FY_START_DAY'), 10) || 1));
    const now = new Date();
    const fyStartYear = now.getMonth() + 1 >= startMonth ? now.getFullYear() : now.getFullYear() - 1;
    const pad = value => String(value).padStart(2, '0');
    const fyStart = `${fyStartYear}-${pad(startMonth)}-${pad(startDay)}`;
    const nextYear = fyStartYear + 1;
    const fyEndDate = new Date(nextYear, startMonth - 1, startDay - 1);
    const fyEnd = `${fyEndDate.getFullYear()}-${pad(fyEndDate.getMonth() + 1)}-${pad(fyEndDate.getDate())}`;
    res.json({ success: true, data: { currency: process.env.CURRENCY || 'USD', idleTimeoutMinutes, paymentTypes, onlineVendors, autoSaveEnabled, fiscalYear: { startMonth, startDay, start: fyStart, end: fyEnd } } });
});

// Auth routes (public)
app.use('/api/auth', require('./routes/auth'));

// Protected API Routes
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/sales-entries', require('./routes/salesEntries'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/salaries', require('./routes/salaries'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/users', require('./routes/users'));
app.use('/api/leaves', require('./routes/leaves'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/petta', require('./routes/petta'));
app.use('/api/settings', require('./routes/settings'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve login page for unauthenticated users, otherwise index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  const server = app.listen(PORT, HOST, async () => {
    console.log(`\nBizTracker running at http://${HOST}:${PORT}\n`);

    if (!getSpreadsheetId() || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      console.warn(`⚠  WARNING: Spreadsheet configuration for ${environment} or GOOGLE_SERVICE_ACCOUNT_KEY is not set`);
      console.warn('   Copy .env.example to .env and fill in your credentials.\n');
      return;
    }

    try {
      console.log(`Connecting to Google Sheets (${environment})...`);
      await initializeSheets();
      console.log('✔  Google Sheets initialized successfully.\n');
    } catch (err) {
      console.error('✖  Google Sheets init failed:', err.message);
      console.error('   API calls will return errors until credentials are fixed.\n');
    }
  });

  server.on('error', err => {
    console.error('✖  Server startup/runtime error:', err.message);
    process.exit(1);
  });
}

process.on('unhandledRejection', reason => {
  console.error('✖  Unhandled promise rejection:', reason);
});

process.on('uncaughtException', err => {
  console.error('✖  Uncaught exception:', err);
  process.exit(1);
});

startServer();
