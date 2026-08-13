const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireDriver } = require('../middleware/auth');
const { saToday, saWeekStart, saWeekEnd, saMonthStart, saMonthEnd, saMonthName } = require('../utils/time');

// ── Auth (public) ────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password)
    return res.status(400).json({ error: 'phone and password are required' });

  const driver = db.prepare('SELECT * FROM drivers WHERE phone = ?').get(phone);
  // Use the same error for "not found" and "wrong password" to prevent phone enumeration
  const AUTH_FAIL = { error: 'Incorrect phone number or password.' };
  if (!driver || !driver.password)
    return res.status(401).json(AUTH_FAIL);

  const match = await bcrypt.compare(password, driver.password);
  if (!match)
    return res.status(401).json(AUTH_FAIL);

  if (driver.verification_status !== 'approved') {
    const msgs = {
      pending:   'Your account is pending verification. The owner has not yet approved your account. Please check back later.',
      rejected:  'Your account registration has been rejected by the owner. Please contact your owner for assistance.',
      suspended: 'Your account has been suspended by the owner. Please contact your owner for assistance.',
    };
    return res.status(403).json({
      error: msgs[driver.verification_status] || 'Your account is not currently approved.',
      verification_status: driver.verification_status,
    });
  }

  req.session.userId = driver.id;
  req.session.role = 'driver';
  req.session.name = driver.name;

  const { password: _pw, selfie_path: _s, license_doc_path: _l, pdp_doc_path: _p, id_number: _i, ...safeDriver } = driver;
  res.json(safeDriver);
});

// ── Protected routes ─────────────────────────────────────────────────────────

// Return current shift status — used by session restore to resume GPS tracking
router.get('/:driverId/shift/status', requireDriver, (req, res) => {
  const driverId = req.session.userId; // always use session, not URL param
  const openShift = db.prepare(
    'SELECT s.id, s.taxi_id, s.start_time, t.plate FROM shifts s LEFT JOIN taxis t ON t.id = s.taxi_id WHERE s.driver_id = ? AND s.end_time IS NULL ORDER BY s.start_time DESC LIMIT 1'
  ).get(driverId);
  const loc = db.prepare('SELECT lat, lng, updated_at FROM driver_locations WHERE driver_id = ?').get(driverId);
  res.json({
    onShift: !!openShift,
    shiftId: openShift?.id || null,
    taxiId:  openShift?.taxi_id || null,
    taxiPlate: openShift?.plate || null,
    shiftStart: openShift?.start_time || null,
    lastLat: loc?.lat || null,
    lastLng: loc?.lng || null,
    lastUpdate: loc?.updated_at || null,
  });
});

router.post('/:driverId/shift/start', requireDriver, (req, res) => {
  const driverId = req.session.userId;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });
  if (!driver.current_taxi_id) return res.status(400).json({ error: 'no taxi assigned — ask your owner to assign one' });

  // Close any stale open shifts first
  db.prepare('UPDATE shifts SET end_time = CURRENT_TIMESTAMP WHERE driver_id = ? AND end_time IS NULL').run(driverId);

  const info = db.prepare('INSERT INTO shifts (driver_id, taxi_id) VALUES (?, ?)').run(driverId, driver.current_taxi_id);
  db.prepare("UPDATE taxis SET status = 'online' WHERE id = ?").run(driver.current_taxi_id);

  const taxi = db.prepare('SELECT plate FROM taxis WHERE id = ?').get(driver.current_taxi_id);

  req.app.locals.io.to(`owner_${driver.owner_id}`).emit('taxi_status', {
    taxi_id: driver.current_taxi_id, status: 'online',
    driver_name: driver.name, plate: taxi?.plate,
  });
  res.json({ ok: true, shiftId: info.lastInsertRowid, taxi_id: driver.current_taxi_id, plate: taxi?.plate });
});

router.post('/:driverId/shift/end', requireDriver, (req, res) => {
  const driverId = req.session.userId;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  db.prepare('UPDATE shifts SET end_time = CURRENT_TIMESTAMP WHERE driver_id = ? AND end_time IS NULL').run(driverId);

  if (driver.current_taxi_id) {
    db.prepare("UPDATE taxis SET status = 'offline' WHERE id = ?").run(driver.current_taxi_id);
    const taxi = db.prepare('SELECT plate FROM taxis WHERE id = ?').get(driver.current_taxi_id);
    req.app.locals.io.to(`owner_${driver.owner_id}`).emit('taxi_status', {
      taxi_id: driver.current_taxi_id, status: 'offline',
      driver_name: driver.name, plate: taxi?.plate,
    });
  }
  res.json({ ok: true });
});

// Location update — secured: session userId is used for all DB writes
router.post('/:driverId/location', requireDriver, (req, res) => {
  const driverId = req.session.userId; // ignore URL param entirely for writes

  const { lat, lng } = req.body;

  // Validate coordinates
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng are required' });
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  if (isNaN(latN) || isNaN(lngN)) return res.status(400).json({ error: 'lat and lng must be numbers' });
  if (latN < -90 || latN > 90)    return res.status(400).json({ error: 'lat must be between -90 and 90' });
  if (lngN < -180 || lngN > 180)  return res.status(400).json({ error: 'lng must be between -180 and 180' });

  const driver = db.prepare('SELECT owner_id, current_taxi_id FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  // Only accept location if the driver has an active (open) shift
  const openShift = db.prepare(
    'SELECT id FROM shifts WHERE driver_id = ? AND end_time IS NULL LIMIT 1'
  ).get(driverId);
  if (!openShift) return res.status(409).json({ error: 'no active shift — start your shift first' });

  db.prepare(`
    INSERT INTO driver_locations (driver_id, taxi_id, lat, lng, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(driver_id) DO UPDATE
      SET taxi_id=excluded.taxi_id, lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at
  `).run(driverId, driver.current_taxi_id, latN, lngN);

  req.app.locals.io.to(`owner_${driver.owner_id}`).emit('location_update', {
    driver_id: driverId,
    taxi_id: driver.current_taxi_id,
    lat: latN,
    lng: lngN,
    updated_at: new Date().toISOString(),
  });

  res.json({ ok: true });
});

// ── Trip recording ────────────────────────────────────────────────────────────

router.post('/:driverId/trip', requireDriver, (req, res) => {
  const driverId = req.session.userId;
  const { from_location, to_location, fare, payment_method } = req.body;

  // Validate required fields
  const from = (from_location || '').trim();
  const to   = (to_location   || '').trim();
  if (!from) return res.status(400).json({ error: 'Starting point is required' });
  if (!to)   return res.status(400).json({ error: 'Destination is required' });

  const fareNum = parseFloat(fare);
  if (fare == null || isNaN(fareNum) || fareNum <= 0)
    return res.status(400).json({ error: 'Fare must be a positive number (R)' });
  if (fareNum > 10000)
    return res.status(400).json({ error: 'Fare cannot exceed R10,000' });

  const VALID_PAYMENTS = ['CASH', 'EFT', 'OTHER'];
  const payment = ((payment_method || 'CASH') + '').trim().toUpperCase();
  if (!VALID_PAYMENTS.includes(payment))
    return res.status(400).json({ error: 'Payment method must be CASH, EFT, or OTHER' });

  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  if (!driver.current_taxi_id)
    return res.status(400).json({ error: 'No taxi assigned — ask your owner to assign you a taxi' });

  // Require an active (open) shift — driver must be ON DUTY
  const openShift = db.prepare(
    'SELECT id FROM shifts WHERE driver_id = ? AND end_time IS NULL LIMIT 1'
  ).get(driverId);
  if (!openShift)
    return res.status(409).json({ error: 'You must be on duty to record a trip. Start your shift first.' });

  // All checks passed — insert trip. created_at is UTC server time (SQLite default).
  const info = db.prepare(`
    INSERT INTO trips (owner_id, driver_id, taxi_id, shift_id, from_location, to_location, fare, payment_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(driver.owner_id, driverId, driver.current_taxi_id, openShift.id, from, to, fareNum, payment);

  res.json({ ok: true, id: info.lastInsertRowid });
});

// ── Driver trip history ───────────────────────────────────────────────────────

// Helper: build WHERE extra clause + params for driver trip filters.
function buildDriverTripFilters(query) {
  const { date, start_date, end_date, payment_method } = query;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const VALID_PM = ['CASH', 'EFT', 'OTHER'];

  const params = [];
  let extra = '';

  if (payment_method) {
    const pm = payment_method.toUpperCase();
    if (!VALID_PM.includes(pm)) return null;
    extra += ' AND t.payment_method=?'; params.push(pm);
  }

  if (date) {
    if (!DATE_RE.test(date)) return null;
    extra += " AND date(t.created_at,'+2 hours') = ?"; params.push(date);
  } else if (start_date || end_date) {
    if (!start_date || !end_date) return null;
    if (!DATE_RE.test(start_date) || !DATE_RE.test(end_date)) return null;
    if (start_date > end_date) return null;
    extra += " AND date(t.created_at,'+2 hours') >= ? AND date(t.created_at,'+2 hours') <= ?";
    params.push(start_date, end_date);
  }

  return { extra, params };
}

router.get('/:driverId/trips', requireDriver, (req, res) => {
  const driverId = req.session.userId;
  const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0,  0);

  const filters = buildDriverTripFilters(req.query);
  if (!filters) return res.status(400).json({ error: 'Invalid filter parameters' });

  const params = [driverId, ...filters.params];

  const rows = db.prepare(`
    SELECT t.id, t.from_location, t.to_location, t.fare, t.payment_method, t.created_at,
           tx.plate AS taxi_plate
    FROM trips t
    LEFT JOIN taxis tx ON tx.id = t.taxi_id
    WHERE t.driver_id = ? ${filters.extra}
    ORDER BY t.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all(...params);

  res.json(rows);
});

// ── Driver trip summary — totals for a filtered period ────────────────────────

router.get('/:driverId/trips/summary', requireDriver, (req, res) => {
  const driverId = req.session.userId;

  const filters = buildDriverTripFilters(req.query);
  if (!filters) return res.status(400).json({ error: 'Invalid filter parameters' });

  const params = [driverId, ...filters.params];

  const row = db.prepare(`
    SELECT
      COUNT(*)                                                        AS total_trips,
      COALESCE(SUM(t.fare), 0)                                        AS total_fare,
      COALESCE(SUM(CASE WHEN t.payment_method='CASH'  THEN t.fare ELSE 0 END), 0) AS cash_total,
      COALESCE(SUM(CASE WHEN t.payment_method='EFT'   THEN t.fare ELSE 0 END), 0) AS eft_total,
      COALESCE(SUM(CASE WHEN t.payment_method='OTHER' THEN t.fare ELSE 0 END), 0) AS other_total,
      CASE WHEN COUNT(*) > 0 THEN ROUND(SUM(t.fare) / COUNT(*), 2) ELSE 0 END     AS avg_fare
    FROM trips t
    WHERE t.driver_id = ? ${filters.extra}
  `).get(...params);

  res.json(row);
});

// ── Driver earnings — proper SAST periods ────────────────────────────────────

router.get('/:driverId/earnings', requireDriver, (req, res) => {
  const driverId = req.session.userId;

  const today      = saToday();
  const weekStart  = saWeekStart();
  const weekEnd    = saWeekEnd();
  const monthStart = saMonthStart();
  const monthEnd   = saMonthEnd();

  const agg = (s, e) => db.prepare(`
    SELECT COALESCE(SUM(fare), 0) AS total, COUNT(*) AS trips
    FROM trips
    WHERE driver_id = ?
      AND date(created_at, '+2 hours') >= ?
      AND date(created_at, '+2 hours') <= ?
  `).get(driverId, s, e);

  res.json({
    today: {
      date: today,
      ...agg(today, today),
    },
    week: {
      start: weekStart,
      end:   weekEnd,
      ...agg(weekStart, weekEnd),
    },
    month: {
      name:  saMonthName(),
      start: monthStart,
      end:   monthEnd,
      ...agg(monthStart, monthEnd),
    },
  });
});

// ── Messages ──────────────────────────────────────────────────────────────────

router.get('/:driverId/messages', requireDriver, (req, res) => {
  const driverId = req.session.userId;
  const rows = db.prepare(
    'SELECT * FROM messages WHERE driver_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(driverId);
  res.json(rows);
});

// ── SOS ───────────────────────────────────────────────────────────────────────

router.post('/:driverId/sos', requireDriver, (req, res) => {
  const driverId = req.session.userId;
  const { lat, lng } = req.body;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  const latN = lat != null ? parseFloat(lat) : null;
  const lngN = lng != null ? parseFloat(lng) : null;

  const info = db.prepare(
    'INSERT INTO sos_alerts (driver_id, taxi_id, lat, lng) VALUES (?, ?, ?, ?)'
  ).run(driverId, driver.current_taxi_id, latN, lngN);

  req.app.locals.io.to(`owner_${driver.owner_id}`).emit('sos_alert', {
    id: info.lastInsertRowid, driver_id: driverId,
    driver_name: driver.name, taxi_id: driver.current_taxi_id, lat: latN, lng: lngN,
  });
  res.json({ ok: true });
});

// ── Passenger ratings for this driver ─────────────────────────────────────────

router.get('/:driverId/ratings', requireDriver, (req, res) => {
  const driverId = req.params.driverId;

  // Drivers may only view their own ratings
  if (String(req.session.userId) !== String(driverId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const stats = db.prepare(`
    SELECT
      AVG(rating)   AS avg_rating,
      COUNT(rating) AS total_ratings
    FROM feedback
    WHERE driver_id = ? AND rating IS NOT NULL
  `).get(driverId);

  const recent = db.prepare(`
    SELECT rating, comment, created_at
    FROM feedback
    WHERE driver_id = ? AND rating IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 10
  `).all(driverId);

  res.json({
    avg_rating:    stats.avg_rating,
    total_ratings: stats.total_ratings || 0,
    recent,
  });
});

module.exports = router;
