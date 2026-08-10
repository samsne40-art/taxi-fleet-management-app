/**
 * Auth middleware — checks express-session for role and ownership.
 * Both functions also verify that the :ownerId / :driverId URL param
 * matches the logged-in user so one owner can't read another's data.
 */

function requireOwner(req, res, next) {
  if (!req.session?.userId || req.session.role !== 'owner') {
    return res.status(401).json({ error: 'not authenticated — please log in as an owner' });
  }
  // If the route has an :ownerId param it must match the session
  if (req.params.ownerId !== undefined && parseInt(req.params.ownerId) !== req.session.userId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function requireDriver(req, res, next) {
  if (!req.session?.userId || req.session.role !== 'driver') {
    return res.status(401).json({ error: 'not authenticated — please log in as a driver' });
  }
  // If the route has a :driverId param it must match the session
  if (req.params.driverId !== undefined && parseInt(req.params.driverId) !== req.session.userId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

module.exports = { requireOwner, requireDriver };
