/* Auth middleware */

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }
  next();
}

function requireSuperUser(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }
  if (req.session.user.role !== 'superuser') {
    return res.status(403).json({ success: false, message: 'Access denied. Super user required.' });
  }
  next();
}

module.exports = { requireAuth, requireSuperUser };
