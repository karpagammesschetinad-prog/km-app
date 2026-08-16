const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { SHEETS, getAllRows, appendRow, updateRow, deleteRow, findRowById } = require('../services/googleSheets');
const { requireAuth, requireSuperUser } = require('../middleware/authMiddleware');

const SHEET = SHEETS.USERS;
const C = { ID: 0, USERNAME: 1, DISPLAY_NAME: 2, ROLE: 3, PASSWORD_HASH: 4, STATUS: 5, CREATED_AT: 6, PERMISSIONS: 7 };

function rowToObj(row, includeHash = false) {
  let permissions = null;
  try { if (row[C.PERMISSIONS]) permissions = JSON.parse(row[C.PERMISSIONS]); } catch (_) {}
  const obj = {
    id:          row[C.ID]           || '',
    username:    row[C.USERNAME]     || '',
    displayName: row[C.DISPLAY_NAME] || '',
    role:        row[C.ROLE]         || 'cashier',
    status:      row[C.STATUS]       || 'Active',
    createdAt:   row[C.CREATED_AT]   || '',
    permissions
  };
  if (includeHash) obj.passwordHash = row[C.PASSWORD_HASH] || '';
  return obj;
}

function objToRow(o) {
  const permsStr = o.permissions ? JSON.stringify(o.permissions) : '';
  return [o.id, o.username, o.displayName, o.role, o.passwordHash, o.status, o.createdAt, permsStr];
}

// GET all users (super user only)
router.get('/', requireSuperUser, async (req, res) => {
  try {
    const rows = await getAllRows(SHEET);
    res.json({ success: true, data: rows.map(r => rowToObj(r)) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST create user (super user only)
router.post('/', requireSuperUser, async (req, res) => {
  try {
    const { username, displayName, role, password } = req.body;
    if (!username || !password || !displayName || !role) {
      return res.status(400).json({ success: false, message: 'username, displayName, role and password are required.' });
    }
    // Check duplicate username
    const rows = await getAllRows(SHEET);
    if (rows.some(r => r[C.USERNAME].toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ success: false, message: 'Username already exists.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const obj = {
      id: uuidv4(),
      username: username.toLowerCase().trim(),
      displayName: displayName.trim(),
      role,
      passwordHash,
      status: 'Active',
      createdAt: new Date().toISOString()
    };
    await appendRow(SHEET, objToRow(obj));
    res.status(201).json({ success: true, data: rowToObj(objToRow(obj).reduce((o, v, i) => { o[i] = v; return o; }, [])) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT update user (super user only)
router.put('/:id', requireSuperUser, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'User not found.' });
    const existing = rowToObj(found.row, true);
    const { displayName, role, status, password } = req.body;

    // Prevent demoting the last superuser
    if (role && role !== 'superuser' && existing.role === 'superuser') {
      const rows = await getAllRows(SHEET);
      const superCount = rows.filter(r => r[C.ROLE] === 'superuser' && r[C.STATUS] === 'Active' && r[C.ID] !== existing.id).length;
      if (superCount === 0) {
        return res.status(400).json({ success: false, message: 'Cannot demote the only super user.' });
      }
    }

    const { permissions } = req.body;
    const updated = {
      ...existing,
      displayName: displayName !== undefined ? displayName.trim() : existing.displayName,
      role:        role !== undefined ? role : existing.role,
      status:      status !== undefined ? status : existing.status,
      passwordHash: existing.passwordHash,
      permissions:  permissions !== undefined ? permissions : existing.permissions
    };
    if (password && password.trim()) {
      updated.passwordHash = await bcrypt.hash(password.trim(), 10);
    }
    await updateRow(SHEET, found.index, objToRow(updated));
    res.json({ success: true, data: rowToObj(objToRow(updated).reduce((o, v, i) => { o[i] = v; return o; }, [])) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE user (super user only, cannot delete self or other super users)
router.delete('/:id', requireSuperUser, async (req, res) => {
  try {
    const found = await findRowById(SHEET, req.params.id);
    if (!found) return res.status(404).json({ success: false, message: 'User not found.' });
    if (found.row[C.ROLE] === 'superuser') {
      return res.status(400).json({ success: false, message: 'Super users cannot be deleted.' });
    }
    if (req.session.user && req.params.id === req.session.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account.' });
    }
    await deleteRow(SHEET, found.index);
    res.json({ success: true, message: 'User deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
