const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, deleteRow, findRowById, updateRow } = require('../services/googleSheets');
const { requireAuth } = require('../middleware/authMiddleware');

router.use(requireAuth);

const SHEET = SHEETS.SALARY_HISTORY;
const C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, EFFECTIVE_DATE: 3, AMOUNT: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };
const EMPLOYEE_PER_DAY = 5;

// The employee row holds the rate in force, so removing a revision must roll it back to the latest one left.
async function syncEmployeeRate(employeeId) {
  const remaining = (await getAllRows(SHEETS.SALARY_HISTORY))
    .filter(row => String(row[C.EMP_ID]) === String(employeeId))
    .sort((first, second) => String(first[C.EFFECTIVE_DATE]).localeCompare(String(second[C.EFFECTIVE_DATE])));
  if (!remaining.length) return;
  const employee = await findRowById(SHEETS.EMPLOYEES, employeeId);
  if (!employee) return;
  const row = [...employee.row];
  row[EMPLOYEE_PER_DAY] = parseFloat(remaining[remaining.length - 1][C.AMOUNT]) || 0;
  await updateRow(SHEETS.EMPLOYEES, employee.index, row);
}

function rowToObj(row) {
  return {
    id: row[C.ID] || '',
    employeeId: row[C.EMP_ID] || '',
    employeeName: row[C.EMP_NAME] || '',
    effectiveDate: row[C.EFFECTIVE_DATE] || '',
    amount: parseFloat(row[C.AMOUNT]) || 0,
    remarks: row[C.REMARKS] || '',
    createdBy: row[C.CREATED_BY] || '',
    createdAt: row[C.CREATED_AT] || ''
  };
}

router.get('/', async (req, res) => {
  try {
    const rows = await getAllRows(SHEET);
    let list = rows.map(rowToObj);
    if (req.query.employeeId) {
      const employeeId = String(req.query.employeeId);
      list = list.filter(record => record.employeeId === employeeId);
    }
    list.sort((first, second) => (first.effectiveDate < second.effectiveDate ? 1 : -1));
    res.json({ success: true, data: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { employeeId, employeeName, effectiveDate, amount, remarks = '' } = req.body;
    if (!employeeId || !employeeName || !effectiveDate || amount === undefined) {
      return res.status(400).json({ success: false, message: 'employeeId, employeeName, effectiveDate, amount required.' });
    }
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ success: false, message: 'amount must be >= 0.' });
    }

    const record = {
      id: uuidv4(),
      employeeId: String(employeeId),
      employeeName: String(employeeName),
      effectiveDate: String(effectiveDate),
      amount: value,
      remarks: String(remarks || ''),
      createdBy: req.session?.user?.displayName || '',
      createdAt: new Date().toISOString()
    };

    await appendRow(SHEET, [record.id, record.employeeId, record.employeeName, record.effectiveDate, record.amount, record.remarks, record.createdBy, record.createdAt]);
    await syncEmployeeRate(record.employeeId);
    res.status(201).json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const rows = await getAllRows(SHEET);
    const index = rows.findIndex(row => String(row[C.ID]) === String(req.params.id));
    if (index < 0) return res.status(404).json({ success: false, message: 'Record not found.' });
    const employeeId = rows[index][C.EMP_ID];
    await deleteRow(SHEET, index + 2);
    await syncEmployeeRate(employeeId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
