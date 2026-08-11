const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireDriver } = require('../middleware/auth');

// ── Auth (public) ────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password)
    return res.status(400).json({ error: 'phone and password are required' });

  const driver = db.prepare('SELECT * FROM drivers WHERE phone = ?').get(phone);
  if (!driver)
    return res.status(401).json({ error: 'no driver registered with that number — ask your owner to add you' });
  if (!driver.password)
    return res.status(401).json({ error: 'no password set — ask your owner to re-register your account' });

  const match = await bcrypt.compare(password, driver.password);
  if (!match)
    return res.status(401).json({ error: 'incorrect phone number or password' });

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

// ── Earnings ──────────────────────────────────────────────────────────────────

router.get('/:driverId/earnings', requireDriver, (req, res) => {
  const driverId = req.session.userId;
  const earn = (clause) => db.prepare(
    `SELECT COALESCE(SUM(fare),0) as total, COUNT(*) as trips FROM trips WHERE driver_id = ? AND ${clause}`
  ).get(driverId);
  res.json({
    today: earn("date(created_at) = date('now')"),
    week:  earn("created_at >= date('now','-7 days')"),
    month: earn("created_at >= date('now','-30 days')"),
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

// ── Trip logging ──────────────────────────────────────────────────────────────

router.post('/:driverId/trip', requireDriver, (req, res) => {
  const driverId = req.session.userId;
  const { fare } = req.body;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });
  if (!driver.current_taxi_id) return res.status(400).json({ error: 'no taxi assigned' });
  if (fare == null || isNaN(fare)) return res.status(400).json({ error: 'valid fare required' });
  const info = db.prepare('INSERT INTO trips (taxi_id, driver_id, fare) VALUES (?, ?, ?)').run(driver.current_taxi_id, driverId, fare);
  res.json({ ok: true, id: info.lastInsertRowid });
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

module.exports = router;
