/**
 * Auth middleware — checks express-session for role and ownership.
 * Both functions also verify that the :ownerId / :driverId URL param
 * matches the logged-in user so one owner can't read another's data.
 *
 * requireDriver additionally checks verification_status from the DB on
 * every protected request so that a suspension takes effect immediately
 * even for drivers who are currently logged in.
 */

const db = require('../db');

function requireOwner(req, res, next) {
  if (!req.session?.userId || req.session.role !== 'owner') {
    return res.status(401).json({ error: 'not authenticated — please log in as an owner' });
  }
  if (req.params.ownerId !== undefined && parseInt(req.params.ownerId) !== req.session.userId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function requireDriver(req, res, next) {
  if (!req.session?.userId || req.session.role !== 'driver') {
    return res.status(401).json({ error: 'not authenticated — please log in as a driver' });
  }
  if (req.params.driverId !== undefined && parseInt(req.params.driverId) !== req.session.userId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  // Live verification check — catches suspensions that happen mid-session
  const row = db.prepare('SELECT verification_status FROM drivers WHERE id = ?').get(req.session.userId);
  if (!row || row.verification_status !== 'approved') {
    const msgs = {
      pending:   'Your account is pending owner approval.',
      rejected:  'Your account registration was rejected. Contact your owner.',
      suspended: 'Your account has been suspended. Contact your owner.',
    };
    return res.status(403).json({
      error: msgs[row?.verification_status] || 'Your account is not currently approved.',
      verification_status: row?.verification_status,
    });
  }
  next();
}

module.exports = { requireOwner, requireDriver };
