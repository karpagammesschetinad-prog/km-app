const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');

const SHEET = SHEETS.EMPLOYEES;
const C = { ID: 0, NAME: 1, ADDRESS: 2, PHONE: 3, START: 4, PER_DAY: 5, PETTA: 6, STATUS: 7 };

function rowToObj(row) {
  return {
    id:           row[C.ID]      || '',
    name:         row[C.NAME]    || '',
    address:      row[C.ADDRESS] || '',
    phone:        row[C.PHONE]   || '',
    startDate:    row[C.START]   || '',
    perDaySalary: parseFloat(row[C.PER_DAY]) || 0,
    dailyPetta:   parseFloat(row[C.PETTA])   || 0,
    status:       row[C.STATUS]  || 'Active'
  };
}

function objToRow(o) {
  return [o.id, o.name, o.address || '', o.phone || '', o.startDate || '',
          o.perDaySalary, o.dailyPetta, o.status];
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
    const { name, phone, address, startDate, perDaySalary, dailyPetta = 0, status = 'Active' } = req.body;
    if (!name || perDaySalary === undefined || !startDate) {
      return res.status(400).json({ success: false, message: 'name, startDate, and perDaySalary are required.' });
    }
    const obj = {
      id: uuidv4(),
      name: String(name).trim(),
      address: String(address || '').trim(),
      phone: String(phone || '').trim(),
      startDate,
      perDaySalary: parseFloat(perDaySalary),
      dailyPetta: parseFloat(dailyPetta) || 0,
      status
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
    updated.perDaySalary = parseFloat(updated.perDaySalary) || 0;
    updated.dailyPetta   = parseFloat(updated.dailyPetta)   || 0;
    await updateRow(SHEET, found.index, objToRow(updated));
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
