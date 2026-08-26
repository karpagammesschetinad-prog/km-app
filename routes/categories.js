const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');

const SHEET = SHEETS.EXPENSE_CATEGORIES;
const TYPE_SHEET = SHEETS.EXPENSE_CATEGORY_TYPES;
const C = { ID: 0, NAME: 1, ORDER: 2, STATUS: 3, TYPE_ID: 4, EXCLUDE_CASH: 5 };
const T = { ID: 0, NAME: 1, ORDER: 2, STATUS: 3, ACCESS_MODE: 4, ALLOWED_USERS: 5, DISPLAY_TEXT: 6, WORKFLOW: 7 };
const EXPENSE_C = { CATEGORY: 2, EMPLOYEE_ID: 5, TYPE_ID: 13, ON_SPOT: 14 };

function normalizeWorkflow(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'occasional' || normalized === 'occasional_excluded') return 'Occasional';
  if (normalized === 'daily non cash' || normalized === 'daily_non_cash' || normalized === 'dailycashexcluded') return 'Daily Non Cash';
  return 'Daily Cash';
}

function typeRowToObj(row) {
  return {
    id: row[T.ID] || '', name: row[T.NAME] || '', displayText: row[T.DISPLAY_TEXT] || row[T.NAME] || '', sortOrder: parseInt(row[T.ORDER]) || 0,
    status: row[T.STATUS] || 'Active', accessMode: row[T.ACCESS_MODE] === 'Limited' ? 'Limited' : 'All',
    workflow: normalizeWorkflow(row[T.WORKFLOW]),
    allowedUserIds: String(row[T.ALLOWED_USERS] || '').split(',').map(v => v.trim()).filter(Boolean)
  };
}

function canUseType(type, user, manage = false) {
  if (user.role === 'superuser') return true;
  if (type.status !== 'Active') return false;
  if (type.accessMode === 'Limited' && !type.allowedUserIds.includes(user.id)) return false;
  return !manage || !!(user.permissions?.categories?.manage);
}

async function getTypes() {
  const rows = await getAllRows(TYPE_SHEET);
  return rows.map(typeRowToObj).sort((a, b) => a.sortOrder - b.sortOrder);
}

function getLegacyDefaultType(types) {
  return types.find(t => t.name === 'General') || types.find(t => t.sortOrder === 1) || types[0] || {
    id: '', name: 'General', sortOrder: 0, status: 'Active', accessMode: 'All', allowedUserIds: []
  };
}

function rowToObj(row) {
  return {
    id: row[C.ID] || '',
    name: row[C.NAME] || '',
    sortOrder: parseInt(row[C.ORDER]) || 0,
    status: row[C.STATUS] || 'Active',
    typeId: row[C.TYPE_ID] || '',
    excludeDailyCashSales: String(row[C.EXCLUDE_CASH] || '').toLowerCase() === 'true'
  };
}

function objToRow(o) {
  return [o.id, o.name, o.sortOrder, o.status, o.typeId || '', o.excludeDailyCashSales ? 'TRUE' : ''];
}

// GET all (sorted by order)
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await getAllRows(SHEET);
    const types = await getTypes();
      const general = getLegacyDefaultType(types);
    const visibleTypes = types.filter(t => canUseType(t, req.session.user));
    const visibleIds = new Set(visibleTypes.map(t => t.id));
    const cats = rows.map(rowToObj)
      .filter(c => !c.typeId ? canUseType(general, req.session.user) : visibleIds.has(c.typeId))
      .map(c => ({ ...c, typeId: c.typeId || general.id, typeName: c.typeId ? (types.find(t => t.id === c.typeId)?.displayText || types.find(t => t.id === c.typeId)?.name || general.displayText || general.name) : (general.displayText || general.name) }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    res.json({ success: true, data: cats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET by ID
router.get('/:id([0-9a-fA-F-]{36})', requireAuth, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Category not found.' });
    const category = rowToObj(found.row);
    const types = await getTypes();
    const legacyType = getLegacyDefaultType(types);
    const type = category.typeId ? types.find(t => t.id === category.typeId) : legacyType;
    if (!type || !canUseType(type, req.session.user)) return res.status(403).json({ success: false, message: 'Access denied for this category type.' });
    res.json({ success: true, data: { ...category, typeId: category.typeId || legacyType.id, typeName: type.displayText || type.name } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST create
router.post('/', requireSuperUser, async (req, res) => {
  try {
    const { name, sortOrder, status = 'Active', typeId = '', excludeDailyCashSales = false } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name is required.' });
    const rows = await getAllRows(SHEET);
    const maxOrder = rows.reduce((m, r) => Math.max(m, parseInt(r[C.ORDER]) || 0), 0);
    const obj = {
      id: uuidv4(),
      name: String(name).trim(),
      sortOrder: parseInt(sortOrder) || maxOrder + 1,
      status, typeId,
      excludeDailyCashSales: !!excludeDailyCashSales
    };
    await appendRow(SHEET, objToRow(obj));
    res.status(201).json({ success: true, data: obj });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT update
router.put('/:id([0-9a-fA-F-]{36})', requireSuperUser, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Category not found.' });
    const existing = rowToObj(found.row);
    const updated = { ...existing, ...req.body, id: existing.id };
    if (updated.typeId) {
      const types = await getTypes();
      if (!types.some(type => type.id === updated.typeId)) {
        return res.status(400).json({ success: false, message: 'Selected category type does not exist.' });
      }
    }
    updated.sortOrder = parseInt(updated.sortOrder) || existing.sortOrder;
    await updateRow(SHEET, found.index, objToRow(updated));
    if (updated.name !== existing.name) {
      const expenseRows = await getAllRows(SHEETS.EXPENSES);
      for (let index = 0; index < expenseRows.length; index++) {
        const row = expenseRows[index];
        const isOnSpot = String(row[EXPENSE_C.ON_SPOT] || '').toLowerCase() === 'true';
        if (row[EXPENSE_C.CATEGORY] !== existing.name ||
            row[EXPENSE_C.TYPE_ID] !== existing.typeId ||
            row[EXPENSE_C.EMPLOYEE_ID] || isOnSpot) continue;
        const updatedRow = [...row];
        updatedRow[EXPENSE_C.CATEGORY] = updated.name;
        await updateRow(SHEETS.EXPENSES, index + 2, updatedRow);
      }
    }
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE
router.delete('/:id([0-9a-fA-F-]{36})', requireSuperUser, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Category not found.' });
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'Category deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/types/all', requireAuth, async (req, res) => {
  try {
    const types = await getTypes();
    res.json({ success: true, data: req.session.user.role === 'superuser' ? types : types.filter(t => canUseType(t, req.session.user)) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/types', requireSuperUser, async (req, res) => {
  try {
    const { name, displayText, sortOrder, status = 'Active', accessMode = 'All', allowedUserIds = [], workflow = 'Daily Cash' } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: 'Type name is required.' });
    const rows = await getAllRows(TYPE_SHEET);
    const obj = { id: uuidv4(), name: String(name).trim(), displayText: String(displayText || name).trim(), sortOrder: parseInt(sortOrder) || rows.length + 1, status, accessMode: accessMode === 'Limited' ? 'Limited' : 'All', allowedUserIds: Array.isArray(allowedUserIds) ? allowedUserIds : [], workflow: normalizeWorkflow(workflow) };
    await appendRow(TYPE_SHEET, [obj.id, obj.name, obj.sortOrder, obj.status, obj.accessMode, obj.allowedUserIds.join(','), obj.displayText || obj.name, obj.workflow]);
    res.status(201).json({ success: true, data: obj });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/types/:id', requireSuperUser, async (req, res) => {
  try {
    const found = await findRowById(TYPE_SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Category type not found.' });
    const existing = typeRowToObj(found.row);
    const updated = { ...existing, ...req.body, id: existing.id, accessMode: req.body.accessMode === 'Limited' ? 'Limited' : (req.body.accessMode || existing.accessMode), allowedUserIds: Array.isArray(req.body.allowedUserIds) ? req.body.allowedUserIds : existing.allowedUserIds };
    updated.workflow = normalizeWorkflow(updated.workflow);
    await updateRow(TYPE_SHEET, found.index, [updated.id, updated.name, parseInt(updated.sortOrder) || existing.sortOrder, updated.status, updated.accessMode, updated.allowedUserIds.join(','), updated.displayText || updated.name, updated.workflow]);
    if (updated.name !== existing.name) {
      const expenseRows = await getAllRows(SHEETS.EXPENSES);
      for (let index = 0; index < expenseRows.length; index++) {
        const row = expenseRows[index];
        if (row[EXPENSE_C.TYPE_ID] !== existing.id || row[EXPENSE_C.CATEGORY] !== existing.name) continue;
        const updatedRow = [...row];
        updatedRow[EXPENSE_C.CATEGORY] = updated.name;
        await updateRow(SHEETS.EXPENSES, index + 2, updatedRow);
      }
    }
    res.json({ success: true, data: updated });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete('/types/:id', requireSuperUser, async (req, res) => {
  try {
    const found = await findRowById(TYPE_SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'Category type not found.' });
    if (found.row[T.NAME] === 'General') return res.status(400).json({ success: false, message: 'The General category type cannot be deleted.' });
    const categoryRows = await getAllRows(SHEET);
    for (let i = 0; i < categoryRows.length; i++) {
      if (categoryRows[i][C.TYPE_ID] === req.params.id) {
        const category = rowToObj(categoryRows[i]);
        category.typeId = '';
        await updateRow(SHEET, i + 2, objToRow(category));
      }
    }
    await deleteRow(TYPE_SHEET, found.index);
    res.json({ success: true, message: 'Category type deleted.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;
