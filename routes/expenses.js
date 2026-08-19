const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');

const SHEET = SHEETS.EXPENSES;
// Columns: ID, Date, Category, Description, Amount, EmployeeID, EmployeeName,
//          SubmittedBy, ApprovalStatus, ApprovedBy, ApprovedAt, RejectionReason, CreatedAt
const C = {
  ID: 0, DATE: 1, CATEGORY: 2, DESCRIPTION: 3, AMOUNT: 4,
  EMP_ID: 5, EMP_NAME: 6,
  SUBMITTED_BY: 7, APPROVAL_STATUS: 8, APPROVED_BY: 9,
  APPROVED_AT: 10, REJECTION_REASON: 11, CREATED_AT: 12
};

const AUTO_APPROVE_DAYS = 7;

function rowToObj(row) {
  return {
    id:               row[C.ID]              || '',
    date:             row[C.DATE]            || '',
    category:         row[C.CATEGORY]        || '',
    description:      row[C.DESCRIPTION]     || '',
    amount:           parseFloat(row[C.AMOUNT]) || 0,
    employeeId:       row[C.EMP_ID]          || '',
    employeeName:     row[C.EMP_NAME]        || '',
    submittedBy:      row[C.SUBMITTED_BY]    || '',
    approvalStatus:   row[C.APPROVAL_STATUS] || 'Pending',
    approvedBy:       row[C.APPROVED_BY]     || '',
    approvedAt:       row[C.APPROVED_AT]     || '',
    rejectionReason:  row[C.REJECTION_REASON]|| '',
    createdAt:        row[C.CREATED_AT]      || ''
  };
}

function objToRow(o) {
  return [
    o.id, o.date, o.category, o.description, o.amount,
    o.employeeId, o.employeeName,
    o.submittedBy, o.approvalStatus, o.approvedBy,
    o.approvedAt, o.rejectionReason, o.createdAt
  ];
}

// Auto-approve rows older than 7 days that are still Pending
async function runAutoApproval(rows) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - AUTO_APPROVE_DAYS);
  for (let i = 0; i < rows.length; i++) {
    const obj = rowToObj(rows[i]);
    if (obj.approvalStatus === 'Pending') {
      const created = new Date(obj.createdAt);
      if (!isNaN(created) && created < cutoff) {
        obj.approvalStatus = 'AutoApproved';
        obj.approvedBy     = 'system';
        obj.approvedAt     = new Date().toISOString();
        await updateRow(SHEET, i + 2, objToRow(obj));
        rows[i] = objToRow(obj); // update in-memory copy
      }
    }
  }
}

// GET all
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await getAllRows(SHEET);
    await runAutoApproval(rows);
    res.json({ success: true, data: rows.map(rowToObj) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Expense not found.' });
    res.json({ success: true, data: rowToObj(found.row) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST bulk save
router.post('/bulk', requireAuth, async (req, res) => {
  try {
    const { date, entries, remarks } = req.body;
    if (!date || !Array.isArray(entries)) {
      return res.status(400).json({ success: false, message: 'date and entries[] are required.' });
    }
    const user = req.session.user;
    const isSuperUser = user.role === 'superuser';
    const approvalStatus = isSuperUser ? 'Approved' : 'Pending';

    // Delete existing rows for this date (exclude auto-created payment entries linked to employees)
    const rows = await getAllRows(SHEET);
    const toDelete = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][C.DATE] === date && !rows[i][C.EMP_ID]) toDelete.push(i + 2);
    }
    for (let i = toDelete.length - 1; i >= 0; i--) {
      await deleteRow(SHEET, toDelete[i]);
    }
    // Insert new rows
    const created = [];
    for (const entry of entries) {
      const amount = parseFloat(entry.amount);
      if (!entry.category || !(amount > 0)) continue;
      const obj = {
        id: uuidv4(), date,
        category: String(entry.category),
        description: String(remarks || ''),
        amount,
        employeeId: '', employeeName: '',
        submittedBy:    user.username,
        approvalStatus,
        approvedBy:     isSuperUser ? user.username : '',
        approvedAt:     isSuperUser ? new Date().toISOString() : '',
        rejectionReason: '',
        createdAt: new Date().toISOString()
      };
      await appendRow(SHEET, objToRow(obj));
      created.push(obj);
    }
    res.json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST approve a date (super user only)
router.post('/approve/:date', requireSuperUser, async (req, res) => {
  try {
    const { date } = req.params;
    const user = req.session.user;
    const rows = await getAllRows(SHEET);
    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      const obj = rowToObj(rows[i]);
      if (obj.date === date && obj.approvalStatus === 'Pending') {
        obj.approvalStatus = 'Approved';
        obj.approvedBy     = user.username;
        obj.approvedAt     = new Date().toISOString();
        obj.rejectionReason = '';
        await updateRow(SHEET, i + 2, objToRow(obj));
        updated++;
      }
    }
    res.json({ success: true, data: { updated } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST reject a date (super user only)
router.post('/reject/:date', requireSuperUser, async (req, res) => {
  try {
    const { date } = req.params;
    const { reason } = req.body;
    const user = req.session.user;
    const rows = await getAllRows(SHEET);
    let updated = 0;
    for (let i = 0; i < rows.length; i++) {
      const obj = rowToObj(rows[i]);
      if (obj.date === date && (obj.approvalStatus === 'Pending' || obj.approvalStatus === 'Approved' || obj.approvalStatus === 'AutoApproved')) {
        obj.approvalStatus  = 'Rejected';
        obj.approvedBy      = user.username;
        obj.approvedAt      = new Date().toISOString();
        obj.rejectionReason = reason || '';
        await updateRow(SHEET, i + 2, objToRow(obj));
        updated++;
      }
    }
    res.json({ success: true, data: { updated } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE
router.delete('/:id', requireSuperUser, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Expense not found.' });
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Expense deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
