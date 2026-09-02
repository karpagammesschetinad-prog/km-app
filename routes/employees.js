const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');
const { requireAuth } = require('../middleware/authMiddleware');

router.use(requireAuth);

const SHEET = SHEETS.EMPLOYEES;
const C = { ID: 0, NAME: 1, ADDRESS: 2, PHONE: 3, START: 4, PER_DAY: 5, PETTA: 6, STATUS: 7, DAILY_PAY: 8, TEMPORARY: 9, OPENING_BALANCE: 10 };
const SALARY_HISTORY_C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, EFFECTIVE_DATE: 3, AMOUNT: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// A rate change must not rewrite earlier days, so the old rate is kept on the timeline before the new one starts.
async function recordSalaryRevision(employee, previousRate, effectiveDate, remarks, createdBy) {
  const rows = await getAllRows(SHEETS.SALARY_HISTORY);
  const hasHistory = rows.some(row => String(row[SALARY_HISTORY_C.EMP_ID]) === String(employee.id));
  const now = new Date().toISOString();
  if (!hasHistory && employee.startDate) {
    await appendRow(SHEETS.SALARY_HISTORY, [uuidv4(), employee.id, employee.name, employee.startDate, previousRate, 'Rate before first revision', createdBy, now]);
  }
  await appendRow(SHEETS.SALARY_HISTORY, [uuidv4(), employee.id, employee.name, effectiveDate, employee.perDaySalary, remarks, createdBy, now]);
}

function rowToObj(row) {
  return {
    id:                 row[C.ID]        || '',
    name:               row[C.NAME]      || '',
    address:            row[C.ADDRESS]   || '',
    phone:              row[C.PHONE]     || '',
    startDate:          row[C.START]     || '',
    perDaySalary:       parseFloat(row[C.PER_DAY]) || 0,
    dailyPetta:         parseFloat(row[C.PETTA])   || 0,
    status:             row[C.STATUS]    || 'Active',
    dailySalaryEnabled: String(row[C.DAILY_PAY] || '').toLowerCase() === 'true' || row[C.DAILY_PAY] === true,
    temporaryEmployee: String(row[C.TEMPORARY] || '').toLowerCase() === 'true' || row[C.TEMPORARY] === true,
    // Salary owed (positive) or advanced (negative) before tracking started.
    openingBalance:     parseFloat(row[C.OPENING_BALANCE]) || 0
  };
}

function objToRow(o) {
  return [o.id, o.name, o.address || '', o.phone || '', o.startDate || '',
          o.perDaySalary, o.dailyPetta, o.status, o.dailySalaryEnabled ? 'true' : 'false', o.temporaryEmployee ? 'true' : 'false',
          o.openingBalance || 0];
}

router.get('/', async (req, res) => {
  try {
    const rows = await getAllRows(SHEET);
    res.json({ success: true, data: rows.map(rowToObj) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Employee not found.' });
    res.json({ success: true, data: rowToObj(found.row) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, phone, address, startDate, perDaySalary, dailyPetta = 0, status = 'Active', dailySalaryEnabled = false, temporaryEmployee = false, openingBalance = 0 } = req.body;
    if (!name || !startDate) {
      return res.status(400).json({ success: false, message: 'name and startDate are required.' });
    }
    if (!temporaryEmployee && perDaySalary === undefined) {
      return res.status(400).json({ success: false, message: 'perDaySalary is required for regular employees.' });
    }
    const obj = {
      id: uuidv4(),
      name: String(name).trim(),
      address: String(address || '').trim(),
      phone: String(phone || '').trim(),
      startDate,
      perDaySalary: parseFloat(perDaySalary),
      dailyPetta: parseFloat(dailyPetta) || 0,
      status,
      dailySalaryEnabled: !!dailySalaryEnabled,
      temporaryEmployee: !!temporaryEmployee,
      openingBalance: parseFloat(openingBalance) || 0
    };
    await appendRow(SHEET, objToRow(obj));
    res.status(201).json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Employee not found.' });
    const existing = rowToObj(found.row);
    const updated = { ...existing, ...req.body, id: existing.id };
    updated.perDaySalary       = parseFloat(updated.perDaySalary) || 0;
    updated.dailyPetta         = parseFloat(updated.dailyPetta)   || 0;
    updated.openingBalance     = parseFloat(updated.openingBalance) || 0;
    updated.dailySalaryEnabled = updated.dailySalaryEnabled === true || updated.dailySalaryEnabled === 'true';
    updated.temporaryEmployee  = updated.temporaryEmployee === true || updated.temporaryEmployee === 'true';
    await updateRow(SHEET, found.index, objToRow(updated));

    const rateChanged = !updated.temporaryEmployee && updated.perDaySalary !== existing.perDaySalary;
    if (rateChanged) {
      const requested = String(req.body.salaryEffectiveDate || '').trim();
      const effectiveDate = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : todayKey();
      await recordSalaryRevision(
        updated,
        existing.perDaySalary,
        effectiveDate,
        String(req.body.salaryRevisionRemarks || '').trim(),
        req.session?.user?.displayName || ''
      );
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Employee not found.' });
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Employee deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
