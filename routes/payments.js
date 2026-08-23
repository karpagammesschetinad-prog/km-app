const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, deleteRow, findRowById } = require('../services/googleSheets');
const { requireAuth } = require('../middleware/authMiddleware');

const EXPENSE_SHEET = SHEETS.EXPENSES;
const EXPENSE_C = { DATE: 1, CATEGORY: 2, DESCRIPTION: 3, AMOUNT: 4, EMP_ID: 5, EMP_NAME: 6, PAYMENT_ID: 15 };
const EMPLOYEE_C = { ID: 0, NAME: 1 };

const SHEET = SHEETS.SALARY_PAYMENTS;
const C = { ID: 0, EMP_ID: 1, EMP_NAME: 2, DATE: 3, AMOUNT: 4, REMARKS: 5, CREATED_BY: 6, CREATED_AT: 7 };
const TYPE_C = { ID: 0, NAME: 1, ORDER: 2, STATUS: 3, ACCESS_MODE: 4, ALLOWED_USERS: 5 };

function getBusinessDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function canUseExpenseType(row, user) {
  if (user.role === 'superuser') return true;
  if ((row[TYPE_C.STATUS] || 'Active') !== 'Active') return false;
  return row[TYPE_C.ACCESS_MODE] !== 'Limited' || String(row[TYPE_C.ALLOWED_USERS] || '').split(',').map(v => v.trim()).includes(user.id);
}

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
router.get('/', requireAuth, async (req, res) => {
  try {
    let rows = await getAllRows(SHEET);
    if (req.query.employeeId) {
      rows = rows.filter(r => r[C.EMP_ID] === req.query.employeeId);
    }
    if (req.session.user.role !== 'superuser') {
      const today = getBusinessDate();
      rows = rows.filter(r => r[C.DATE] === today);
    }
    res.json({ success: true, data: rows.map(rowToObj) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/payments
router.post('/', requireAuth, async (req, res) => {
  try {
    const { employeeId, employeeName, paymentDate, amount, remarks, addAsExpense, expenseTypeId } = req.body;
    if (!employeeId || !paymentDate || amount === undefined) {
      return res.status(400).json({ success: false, message: 'employeeId, paymentDate and amount are required.' });
    }
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than 0.' });
    }
    if (req.session.user.role !== 'superuser') {
      const today = getBusinessDate();
      if (paymentDate !== today) return res.status(400).json({ success: false, message: 'Cashier payments must use today\'s date.' });
    }
    const employeeRows = await getAllRows(SHEETS.EMPLOYEES);
    const employee = employeeRows.find(row => row[EMPLOYEE_C.ID] === employeeId);
    const isTemporaryEmployee = String(employee?.[9] || '').toLowerCase() === 'true';
    const shouldAddAsExpense = !!addAsExpense || isTemporaryEmployee;
    let resolvedExpenseTypeId = expenseTypeId || '';
    if (shouldAddAsExpense) {
      const typeRows = await getAllRows(SHEETS.EXPENSE_CATEGORY_TYPES);
      if (!resolvedExpenseTypeId) {
        const generalType = typeRows.find(row => String(row[TYPE_C.NAME] || '').trim().toLowerCase() === 'general' && (row[TYPE_C.STATUS] || 'Active') === 'Active');
        resolvedExpenseTypeId = generalType?.[TYPE_C.ID] || '';
      }
      const type = typeRows.find(row => row[TYPE_C.ID] === resolvedExpenseTypeId);
      if (!type || !canUseExpenseType(type, req.session.user)) return res.status(403).json({ success: false, message: 'You do not have access to this expense category type.' });
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

    // Also record as an expense if cashier confirmed
    if (shouldAddAsExpense) {
      const user = req.session?.user || {};
      const isSuperUser = user.role === 'superuser';
      const expenseRow = [
        uuidv4(),                          // ID
        paymentDate,                       // Date
        employeeName || employeeId,        // Category (employee name)
        remarks || `Salary payment to ${employeeName || employeeId}`, // Description
        obj.amount,                        // Amount
        employeeId,                        // EmployeeID
        employeeName || '',                // EmployeeName
        user.username || obj.createdBy,    // SubmittedBy
        'Pending',                         // ApprovalStatus
        '',                                // ApprovedBy
        '',                                // ApprovedAt
        '',                                // RejectionReason
        obj.createdAt,                     // CreatedAt
        resolvedExpenseTypeId,              // CategoryTypeID
        '',                                // IsOnSpot
        obj.id,                            // PaymentID
        isTemporaryEmployee ? 'Night' : '' // Shift
      ];
      await appendRow(EXPENSE_SHEET, expenseRow);
    }

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
    const payment = rowToObj(found.row);
    const expenseRows = await getAllRows(EXPENSE_SHEET);
    const linked = expenseRows.map((row, index) => ({ row, index }))
      .filter(({ row }) => row[EXPENSE_C.PAYMENT_ID] === payment.id ||
        (!row[EXPENSE_C.PAYMENT_ID] && row[EXPENSE_C.EMP_ID] === payment.employeeId &&
          row[EXPENSE_C.DATE] === payment.paymentDate &&
          parseFloat(row[EXPENSE_C.AMOUNT]) === payment.amount &&
          [payment.employeeName, payment.employeeId].filter(Boolean).includes(row[EXPENSE_C.CATEGORY])));
    for (let i = linked.length - 1; i >= 0; i--) {
      await deleteRow(EXPENSE_SHEET, linked[i].index + 2);
    }
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Payment deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
