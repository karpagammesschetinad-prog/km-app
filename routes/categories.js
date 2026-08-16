const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');

const SHEET = SHEETS.EXPENSE_CATEGORIES;
const C = { ID: 0, NAME: 1, ORDER: 2, STATUS: 3 };

function rowToObj(row) {
  return {
    id: row[C.ID] || '',
    name: row[C.NAME] || '',
    sortOrder: parseInt(row[C.ORDER]) || 0,
    status: row[C.STATUS] || 'Active'
  };
}

function objToRow(o) {
  return [o.id, o.name, o.sortOrder, o.status];
}

// GET all (sorted by order)
router.get('/', async (req, res) => {
  try {
    const rows = await getAllRows(SHEET);
    const cats = rows.map(rowToObj).sort((a, b) => a.sortOrder - b.sortOrder);
    res.json({ success: true, data: cats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET by ID
router.get('/:id', async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Category not found.' });
    res.json({ success: true, data: rowToObj(found.row) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST create
router.post('/', async (req, res) => {
  try {
    const { name, sortOrder, status = 'Active' } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name is required.' });
    const rows = await getAllRows(SHEET);
    const maxOrder = rows.reduce((m, r) => Math.max(m, parseInt(r[C.ORDER]) || 0), 0);
    const obj = {
      id: uuidv4(),
      name: String(name).trim(),
      sortOrder: parseInt(sortOrder) || maxOrder + 1,
      status
    };
    await appendRow(SHEET, objToRow(obj));
    res.status(201).json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT update
router.put('/:id', async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Category not found.' });
    const existing = rowToObj(found.row);
    const updated = { ...existing, ...req.body, id: existing.id };
    updated.sortOrder = parseInt(updated.sortOrder) || existing.sortOrder;
    await updateRow(SHEET, found.index, objToRow(updated));
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE
router.delete('/:id', async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Category not found.' });
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Category deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
