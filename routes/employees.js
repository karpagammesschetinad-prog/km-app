const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');

const SHEET = SHEETS.EMPLOYEES;
const C = { ID: 0, NAME: 1, EMAIL: 2, DEPT: 3, POS: 4, SALARY: 5, JOIN: 6, STATUS: 7 };

function rowToObj(row) {
  return {
    id: row[C.ID] || '',
    name: row[C.NAME] || '',
    email: row[C.EMAIL] || '',
    department: row[C.DEPT] || '',
    position: row[C.POS] || '',
    baseSalary: parseFloat(row[C.SALARY]) || 0,
    joinDate: row[C.JOIN] || '',
    status: row[C.STATUS] || 'Active'
  };
}

function objToRow(o) {
  return [o.id, o.name, o.email, o.department, o.position, o.baseSalary, o.joinDate, o.status];
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
    const { name, email, department, position, baseSalary, joinDate, status = 'Active' } = req.body;
    if (!name || !department || !position || baseSalary === undefined) {
      return res.status(400).json({ success: false, message: 'name, department, position, and baseSalary are required.' });
    }
    const obj = {
      id: uuidv4(), name: String(name).trim(),
      email: String(email || '').trim(), department, position: String(position).trim(),
      baseSalary: parseFloat(baseSalary), joinDate: joinDate || '', status
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
    updated.baseSalary = parseFloat(updated.baseSalary) || 0;
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
