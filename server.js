require('dotenv').config(); // no-op if env already loaded by Electron
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const { initializeSheets } = require('./services/googleSheets');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'biztracker-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

app.use(express.static(path.join(__dirname, 'public')));

// Config endpoint (public)
app.get('/api/config', (req, res) => {
  res.json({ currency: process.env.CURRENCY || 'USD' });
});

// Auth routes (public)
app.use('/api/auth', require('./routes/auth'));

// Protected API Routes
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/salaries', require('./routes/salaries'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/users', require('./routes/users'));
app.use('/api/leaves', require('./routes/leaves'));
app.use('/api/payments', require('./routes/payments'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve login page for unauthenticated users, otherwise index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function startServer() {
  app.listen(PORT, async () => {
    console.log(`\nBizTracker running at http://localhost:${PORT}\n`);

    if (!process.env.SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      console.warn('⚠  WARNING: SPREADSHEET_ID or GOOGLE_SERVICE_ACCOUNT_KEY is not set in .env');
      console.warn('   Copy .env.example to .env and fill in your credentials.\n');
      return;
    }

    try {
      console.log('Connecting to Google Sheets...');
      await initializeSheets();
      console.log('✔  Google Sheets initialized successfully.\n');
    } catch (err) {
      console.error('✖  Google Sheets init failed:', err.message);
      console.error('   API calls will return errors until credentials are fixed.\n');
    }
  });
}

startServer();
