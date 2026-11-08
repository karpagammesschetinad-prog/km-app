const express = require('express');
const { randomUUID } = require('node:crypto');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');
const { holidayRowToObj } = require('../services/restaurantHolidays');

const router = express.Router();
const DAY_MS = 86400000;
let mutationQueue = Promise.resolve();

// Keep the read/validate/write sequence atomic within this server process.
function serializeMutation(mutate) {
  const result = mutationQueue.then(mutate);
  mutationQueue = result.catch(() => {});
  return result;
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function dateMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? date.getTime() : NaN;
}

function validate(body = {}) {
  const { startDate, endDate, reason } = body || {};
  const start = dateMillis(startDate);
  const end = dateMillis(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    fail(400, 'Start and end dates must be real ISO dates (YYYY-MM-DD).');
  }
  if (end < start) fail(400, 'End date must be on or after start date.');
  if ((end - start) / DAY_MS + 1 > 366) fail(400, 'Holiday interval must not exceed 366 days.');
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) {
    fail(400, 'A reason of 1 to 200 characters is required.');
  }
  return { startDate, endDate, reason: reason.trim() };
}

async function checkOverlap(holiday, ignoredId) {
  const rows = await getAllRows(SHEETS.RESTAURANT_HOLIDAYS);
  if (rows.some(row => row[0] !== ignoredId && row[1] <= holiday.endDate && row[2] >= holiday.startDate)) {
    fail(409, 'Holiday dates overlap an existing restaurant holiday.');
  }
}

function sendError(res, error) {
  res.status(error.status || 500).json({ success: false, message: error.message });
}

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const rows = await getAllRows(SHEETS.RESTAURANT_HOLIDAYS);
    const data = rows.map(holidayRowToObj).sort((a, b) =>
      b.startDate.localeCompare(a.startDate) || b.createdAt.localeCompare(a.createdAt));
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', requireSuperUser, async (req, res) => {
  try {
    const data = await serializeMutation(async () => {
      const holiday = validate(req.body);
      await checkOverlap(holiday);
      const row = [randomUUID(), holiday.startDate, holiday.endDate, holiday.reason,
        req.session.user.displayName || '', new Date().toISOString(), '', ''];
      await appendRow(SHEETS.RESTAURANT_HOLIDAYS, row);
      return holidayRowToObj(row);
    });
    res.status(201).json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:id', requireSuperUser, async (req, res) => {
  try {
    const data = await serializeMutation(async () => {
      const found = await findRowById(SHEETS.RESTAURANT_HOLIDAYS, req.params.id);
      if (!found) fail(404, 'Restaurant holiday not found.');
      const holiday = validate(req.body);
      await checkOverlap(holiday, req.params.id);
      const row = [found.row[0], holiday.startDate, holiday.endDate, holiday.reason,
        found.row[4] || '', found.row[5] || '', req.session.user.displayName || '', new Date().toISOString()];
      await updateRow(SHEETS.RESTAURANT_HOLIDAYS, found.index, row);
      return holidayRowToObj(row);
    });
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/:id', requireSuperUser, async (req, res) => {
  try {
    await serializeMutation(async () => {
      const found = await findRowById(SHEETS.RESTAURANT_HOLIDAYS, req.params.id);
      if (!found) fail(404, 'Restaurant holiday not found.');
      await deleteRow(SHEETS.RESTAURANT_HOLIDAYS, found.index);
    });
    res.json({ success: true, message: 'Restaurant holiday deleted.' });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;