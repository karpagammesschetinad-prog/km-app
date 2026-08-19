const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, deleteRow } = require('../services/googleSheets');

const SHEET = SHEETS.PETTA_HISTORY;
const C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, EFFECTIVE_DATE: 3, AMOUNT: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };

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
      const empId = String(req.query.employeeId);
      list = list.filter(x => x.employeeId === empId);
    }
    list.sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1));
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
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      return res.status(400).json({ success: false, message: 'amount must be >= 0.' });
    }

    const obj = {
      id: uuidv4(),
      employeeId: String(employeeId),
      employeeName: String(employeeName),
      effectiveDate: String(effectiveDate),
      amount: amt,
      remarks: String(remarks || ''),
      createdBy: req.session?.user?.displayName || '',
      createdAt: new Date().toISOString()
    };

    await appendRow(SHEET, [obj.id, obj.employeeId, obj.employeeName, obj.effectiveDate, obj.amount, obj.remarks, obj.createdBy, obj.createdAt]);
    res.status(201).json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const rows = await getAllRows(SHEET);
    const idx = rows.findIndex(r => String(r[C.ID]) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ success: false, message: 'Record not found.' });
    await deleteRow(SHEET, idx);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
