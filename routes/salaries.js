const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');

const SHEET = SHEETS.SALARIES;
const C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, MONTH: 3, YEAR: 4, BASE: 5, ALLOW: 6, DED: 7, NET: 8, PAY_DATE: 9, STATUS: 10 };

function rowToObj(row) {
  return {
    id: row[C.ID] || '',
    employeeId: row[C.EMP_ID] || '',
    employeeName: row[C.EMP_NAME] || '',
    month: parseInt(row[C.MONTH]) || 0,
    year: parseInt(row[C.YEAR]) || 0,
    baseSalary: parseFloat(row[C.BASE]) || 0,
    allowances: parseFloat(row[C.ALLOW]) || 0,
    deductions: parseFloat(row[C.DED]) || 0,
    netSalary: parseFloat(row[C.NET]) || 0,
    paymentDate: row[C.PAY_DATE] || '',
    status: row[C.STATUS] || 'Pending'
  };
}

function objToRow(o) {
  return [o.id, o.employeeId, o.employeeName, o.month, o.year, o.baseSalary, o.allowances, o.deductions, o.netSalary, o.paymentDate, o.status];
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
    if (!found) return res.status(404).json({ success: false, message: 'Salary record not found.' });
    res.json({ success: true, data: rowToObj(found.row) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Process monthly salaries for all active employees
router.post('/process', async (req, res) => {
  try {
    const { month, year } = req.body;
    if (!month || !year) {
      return res.status(400).json({ success: false, message: 'month and year are required.' });
    }

    const m = parseInt(month), y = parseInt(year);

    const empRows = await getAllRows(SHEETS.EMPLOYEES);
    const activeEmployees = empRows
      .filter(r => r.length > 0 && r[0] && r[7] === 'Active')
      .map(r => ({ id: r[0], name: r[1], baseSalary: parseFloat(r[5]) || 0 }));

    const existingRows = await getAllRows(SHEET);
    const existing = new Set(
      existingRows
        .filter(r => parseInt(r[C.MONTH]) === m && parseInt(r[C.YEAR]) === y)
        .map(r => r[C.EMP_ID])
    );

    const created = [];
    for (const emp of activeEmployees) {
      if (!existing.has(emp.id)) {
        const obj = {
          id: uuidv4(), employeeId: emp.id, employeeName: emp.name,
          month: m, year: y, baseSalary: emp.baseSalary,
          allowances: 0, deductions: 0, netSalary: emp.baseSalary,
          paymentDate: '', status: 'Pending'
        };
        await appendRow(SHEET, objToRow(obj));
        created.push(obj);
      }
    }

    res.json({ success: true, message: `Created ${created.length} salary record(s).`, data: created });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { employeeId, employeeName, month, year, baseSalary, allowances = 0, deductions = 0, paymentDate, status = 'Pending' } = req.body;
    if (!employeeId || !month || !year || baseSalary === undefined) {
      return res.status(400).json({ success: false, message: 'employeeId, month, year, and baseSalary are required.' });
    }
    const base = parseFloat(baseSalary), allow = parseFloat(allowances), ded = parseFloat(deductions);
    const obj = {
      id: uuidv4(), employeeId, employeeName: String(employeeName || ''),
      month: parseInt(month), year: parseInt(year),
      baseSalary: base, allowances: allow, deductions: ded,
      netSalary: base + allow - ded, paymentDate: paymentDate || '', status
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
    if (!found) return res.status(404).json({ success: false, message: 'Salary record not found.' });
    const existing = rowToObj(found.row);
    const updated = { ...existing, ...req.body, id: existing.id };
    // Recalculate net salary
    updated.baseSalary = parseFloat(updated.baseSalary) || 0;
    updated.allowances = parseFloat(updated.allowances) || 0;
    updated.deductions = parseFloat(updated.deductions) || 0;
    updated.netSalary = updated.baseSalary + updated.allowances - updated.deductions;
    await updateRow(SHEET, found.index, objToRow(updated));
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Salary record not found.' });
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Salary record deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
