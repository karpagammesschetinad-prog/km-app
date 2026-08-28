const express = require('express');
const router = express.Router();
const { SHEETS, getAllRows, appendRow, updateRow } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');

const SETTINGS = ['FY_START_MONTH', 'FY_START_DAY', 'FY_START_DATE', 'FY_END_DATE', 'IDLE_TIMEOUT_MINUTES', 'PAYMENT_TYPES', 'ONLINE_VENDORS'];

router.get('/autosave', requireAuth, async (req, res) => {
  try {
    const rows = await getAllRows(SHEETS.SETTINGS);
    const value = rows.find(row => row[0] === 'AUTO_SAVE_ENABLED')?.[1];
    res.json({ success: true, data: { AUTO_SAVE_ENABLED: value === '' || value === undefined ? 'true' : String(value).toLowerCase() === 'true' ? 'true' : 'false' } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/autosave', requireAuth, async (req, res) => {
  try {
    const enabled = req.body.AUTO_SAVE_ENABLED;
    if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, message: 'AUTO_SAVE_ENABLED must be true or false.' });
    const rows = await getAllRows(SHEETS.SETTINGS);
    const index = rows.findIndex(row => row[0] === 'AUTO_SAVE_ENABLED');
    const value = String(enabled);
    if (index >= 0) await updateRow(SHEETS.SETTINGS, index + 2, ['AUTO_SAVE_ENABLED', value]);
    else await appendRow(SHEETS.SETTINGS, ['AUTO_SAVE_ENABLED', value]);
    res.json({ success: true, data: { AUTO_SAVE_ENABLED: value } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/', requireSuperUser, async (req, res) => {
  try {
    const rows = await getAllRows(SHEETS.SETTINGS);
    const data = Object.fromEntries(SETTINGS.map(key => [key, rows.find(row => row[0] === key)?.[1] || '']));
    data.IDLE_TIMEOUT_MINUTES = data.IDLE_TIMEOUT_MINUTES || '15';
    data.PAYMENT_TYPES = data.PAYMENT_TYPES || 'Cash';
    data.ONLINE_VENDORS = data.ONLINE_VENDORS || '';
    if (!data.FY_START_DATE || !data.FY_END_DATE) {
      const month = parseInt(data.FY_START_MONTH, 10) || 4;
      const day = parseInt(data.FY_START_DAY, 10) || 1;
      const now = new Date();
      const year = now.getMonth() + 1 >= month ? now.getFullYear() : now.getFullYear() - 1;
      const pad = value => String(value).padStart(2, '0');
      const end = new Date(year + 1, month - 1, day - 1);
      data.FY_START_DATE = `${year}-${pad(month)}-${pad(day)}`;
      data.FY_END_DATE = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
    }
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/', requireSuperUser, async (req, res) => {
  try {
    const startDate = String(req.body.FY_START_DATE || '').trim();
    const endDate = String(req.body.FY_END_DATE || '').trim();
    const idleTimeout = parseInt(req.body.IDLE_TIMEOUT_MINUTES, 10);
    const paymentTypes = Array.isArray(req.body.PAYMENT_TYPES)
      ? req.body.PAYMENT_TYPES.map(value => String(value).trim()).filter(Boolean)
      : String(req.body.PAYMENT_TYPES || 'Cash').split(',').map(value => value.trim()).filter(Boolean);
    const onlineVendors = String(req.body.ONLINE_VENDORS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!Number.isInteger(idleTimeout) || idleTimeout < 1 || idleTimeout > 1440) {
      return res.status(400).json({ success: false, message: 'Auto logout must be between 1 and 1440 minutes.' });
    }
    if (!paymentTypes.length) return res.status(400).json({ success: false, message: 'At least one payment type is required.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate >= endDate) {
      return res.status(400).json({ success: false, message: 'Enter valid FY start and end dates.' });
    }
    const start = new Date(`${startDate}T00:00:00`);
    const month = start.getMonth() + 1;
    const day = start.getDate();
    const rows = await getAllRows(SHEETS.SETTINGS);
    for (const [key, value] of [['FY_START_MONTH', String(month)], ['FY_START_DAY', String(day)], ['FY_START_DATE', startDate], ['FY_END_DATE', endDate], ['IDLE_TIMEOUT_MINUTES', String(idleTimeout)], ['PAYMENT_TYPES', paymentTypes.join(',')], ['ONLINE_VENDORS', onlineVendors.join(',')]]) {
      const index = rows.findIndex(row => row[0] === key);
      if (index >= 0) await updateRow(SHEETS.SETTINGS, index + 2, [key, value]);
      else await appendRow(SHEETS.SETTINGS, [key, value]);
    }
    res.json({ success: true, data: { FY_START_MONTH: String(month), FY_START_DAY: String(day), FY_START_DATE: startDate, FY_END_DATE: endDate, IDLE_TIMEOUT_MINUTES: String(idleTimeout), PAYMENT_TYPES: paymentTypes.join(','), ONLINE_VENDORS: onlineVendors.join(',') } });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;