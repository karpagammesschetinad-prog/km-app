const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { SHEETS, getAllRows } = require('../services/googleSheets');
const { ROLE_DEFAULTS } = require('../config/roleDefaults');

const C = { ID: 0, USERNAME: 1, DISPLAY_NAME: 2, ROLE: 3, PASSWORD_HASH: 4, STATUS: 5, CREATED_AT: 6, PERMISSIONS: 7 };

async function findUser(username) {
  try {
    const rows = await getAllRows(SHEETS.USERS);
    const row = rows.find(r => (r[C.USERNAME] || '').toLowerCase() === username.toLowerCase());
    if (!row) return null;

    let permissions = null;
    try { if (row[C.PERMISSIONS]) permissions = JSON.parse(row[C.PERMISSIONS]); } catch (_) {}

    // If permissions is the old array format [{label,allowed}] or old flat boolean map, discard it
    if (Array.isArray(permissions)) permissions = null;
    if (permissions && typeof permissions.expenses !== 'object') permissions = null;

    // Fall back to role defaults
    const role = row[C.ROLE] || 'cashier';
    let resolvedPermissions = permissions || ROLE_DEFAULTS[role] || ROLE_DEFAULTS.cashier;

    // Enforce role-level screen access using current role defaults.
    // If role default says a screen is OFF → always block it (security).
    // If role default says a screen is ON but stored says OFF → stale data, use role default.
    // If both agree screen is ON → keep stored sub-permissions (user customisation preserved).
    if (role !== 'superuser') {
      const roleDefault = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.cashier;
      const merged = {};
      Object.keys(roleDefault).forEach(screen => {
        const stored = resolvedPermissions[screen] || {};
        const def    = roleDefault[screen];
        if (!def.enabled) {
          merged[screen] = def;            // role says blocked — always enforce
        } else if (!stored.enabled) {
          merged[screen] = def;            // stale stored data — reset to role default
        } else {
          merged[screen] = stored;         // screen enabled in both — keep user's sub-perms
        }
      });
      resolvedPermissions = merged;
    }

    return {
      id:           row[C.ID]           || '',
      username:     row[C.USERNAME]     || '',
      displayName:  row[C.DISPLAY_NAME] || '',
      role,
      status:       row[C.STATUS]       || 'Active',
      passwordHash: row[C.PASSWORD_HASH]|| '',
      permissions:  resolvedPermissions
    };
  } catch (_) {
    return null;
  }
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }
  const user = await findUser(username.trim());
  if (!user || user.status !== 'Active') {
    return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  }
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return res.status(401).json({ success: false, message: 'Invalid username or password.' });
  }
  req.session.user = {
    id: user.id, username: user.username, role: user.role,
    displayName: user.displayName, permissions: user.permissions
  };
  res.json({ success: true, data: req.session.user });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }
  // If permissions missing from session (old session), re-fetch from sheet
  if (!req.session.user.permissions) {
    const fresh = await findUser(req.session.user.username);
    if (fresh) {
      req.session.user.permissions = fresh.permissions;
    }
  }
  res.json({ success: true, data: req.session.user });
});

module.exports = router;
