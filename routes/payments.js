const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, deleteRow, findRowById } = require('../services/googleSheets');

const SHEET = SHEETS.SALARY_PAYMENTS;
const C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, DATE: 3, AMOUNT: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };

function rowToObj(row) {
  return {
    id:           row[C.ID]          || '',
    employeeId:   row[C.EMP_ID]      || '',
    employeeName: row[C.EMP_NAME]    || '',
    paymentDate:  row[C.DATE]        || '',
    amount:       parseFloat(row[C.AMOUNT]) || 0,
    remarks:      row[C.REMARKS]     || '',
    createdBy:    row[C.CREATED_BY]  || '',
    createdAt:    row[C.CREATED_AT]  || ''
  };
}

// GET /api/payments?employeeId=X
router.get('/', async (req, res) => {
  try {
    let rows = await getAllRows(SHEET);
    if (req.query.employeeId) {
      rows = rows.filter(r => r[C.EMP_ID] === req.query.employeeId);
    }
    res.json({ success: true, data: rows.map(rowToObj) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/payments
router.post('/', async (req, res) => {
  try {
    const { employeeId, employeeName, paymentDate, amount, remarks } = req.body;
    if (!employeeId || !paymentDate || amount === undefined) {
      return res.status(400).json({ success: false, message: 'employeeId, paymentDate and amount are required.' });
    }
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0.' });
    }
    const obj = {
      id: uuidv4(),
      employeeId,
      employeeName: employeeName || '',
      paymentDate,
      amount: parseFloat(amount),
      remarks: remarks || '',
      createdBy: req.session?.user?.displayName || '',
      createdAt: new Date().toISOString()
    };
    await appendRow(SHEET, [obj.id, obj.employeeId, obj.employeeName, obj.paymentDate,
                            obj.amount, obj.remarks, obj.createdBy, obj.createdAt]);
    res.status(201).json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/payments/:id
router.delete('/:id', async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Payment not found.' });
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Payment deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
