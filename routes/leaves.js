const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, deleteRow, findRowById } = require('../services/googleSheets');

const SHEET = SHEETS.LEAVES;
const C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, START: 3, END: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };

function rowToObj(row) {
  return {
    id:           row[C.ID]         || '',
    employeeId:   row[C.EMP_ID]     || '',
    employeeName: row[C.EMP_NAME]   || '',
    startDateTime: row[C.START]     || '',
    endDateTime:   row[C.END]       || '',
    remarks:       row[C.REMARKS]   || '',
    createdBy:     row[C.CREATED_BY]|| '',
    createdAt:     row[C.CREATED_AT]|| ''
  };
}

// GET /api/leaves?employeeId=X
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

// POST /api/leaves
router.post('/', async (req, res) => {
  try {
    const { employeeId, employeeName, startDateTime, endDateTime, remarks } = req.body;
    if (!employeeId || !startDateTime || !endDateTime) {
      return res.status(400).json({ success: false, message: 'employeeId, startDateTime and endDateTime are required.' });
    }
    if (new Date(endDateTime) <= new Date(startDateTime)) {
      return res.status(400).json({ success: false, message: 'End date/time must be after start.' });
    }
    const obj = {
      id: uuidv4(),
      employeeId,
      employeeName: employeeName || '',
      startDateTime,
      endDateTime,
      remarks: remarks || '',
      createdBy: req.session?.user?.displayName || '',
      createdAt: new Date().toISOString()
    };
    await appendRow(SHEET, [obj.id, obj.employeeId, obj.employeeName, obj.startDateTime,
                            obj.endDateTime, obj.remarks, obj.createdBy, obj.createdAt]);
    res.status(201).json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/leaves/:id
router.delete('/:id', async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Leave not found.' });
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Leave deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
