const express = require('express');
const router = express.Router();
const db = require('../db');

// Phone-based login. In production, add an OTP/SMS verification step
// before trusting the phone number.
router.post('/login', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const driver = db.prepare('SELECT * FROM drivers WHERE phone = ?').get(phone);
  if (!driver) return res.status(404).json({ error: 'no driver registered with this number - ask your owner to register you' });
  if (driver.status === 'suspended') return res.status(403).json({ error: 'your account has been suspended by the owner' });
  res.json(driver);
});

router.post('/:driverId/shift/start', (req, res) => {
  const { driverId } = req.params;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });
  if (!driver.current_taxi_id) return res.status(400).json({ error: 'no taxi assigned - ask your owner to assign one' });
  if (driver.status === 'suspended') return res.status(403).json({ error: 'account suspended' });

  db.prepare('INSERT INTO shifts (driver_id, taxi_id) VALUES (?, ?)').run(driverId, driver.current_taxi_id);
  db.prepare("UPDATE taxis SET status = 'online' WHERE id = ?").run(driver.current_taxi_id);

  req.app.locals.io.to(`owner_${driver.owner_id}`).emit('taxi_status', { taxi_id: driver.current_taxi_id, status: 'online' });
  res.json({ ok: true, taxi_id: driver.current_taxi_id });
});

router.post('/:driverId/shift/end', (req, res) => {
  const { driverId } = req.params;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  db.prepare('UPDATE shifts SET end_time = CURRENT_TIMESTAMP WHERE driver_id = ? AND end_time IS NULL').run(driverId);
  if (driver.current_taxi_id) {
    db.prepare("UPDATE taxis SET status = 'offline' WHERE id = ?").run(driver.current_taxi_id);
    req.app.locals.io.to(`owner_${driver.owner_id}`).emit('taxi_status', { taxi_id: driver.current_taxi_id, status: 'offline' });
  }
  res.json({ ok: true });
});

router.post('/:driverId/location', (req, res) => {
  const { driverId } = req.params;
  const { lat, lng } = req.body;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  db.prepare(
    `INSERT INTO driver_locations (driver_id, taxi_id, lat, lng, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(driver_id) DO UPDATE SET taxi_id=excluded.taxi_id, lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at`
  ).run(driverId, driver.current_taxi_id, lat, lng);

  req.app.locals.io.to(`owner_${driver.owner_id}`).emit('location_update', {
    driver_id: Number(driverId), taxi_id: driver.current_taxi_id, lat, lng,
  });
  res.json({ ok: true });
});

router.post('/:driverId/trip', (req, res) => {
  const { driverId } = req.params;
  const { fare } = req.body;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });
  if (!driver.current_taxi_id) return res.status(400).json({ error: 'no taxi assigned' });
  if (fare == null || isNaN(fare)) return res.status(400).json({ error: 'valid fare required' });

  const info = db.prepare('INSERT INTO trips (taxi_id, driver_id, fare) VALUES (?, ?, ?)').run(driver.current_taxi_id, driverId, fare);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.get('/:driverId/earnings', (req, res) => {
  const { driverId } = req.params;
  const earn = (clause) => db.prepare(`SELECT COALESCE(SUM(fare),0) as total, COUNT(*) as trips FROM trips WHERE driver_id = ? AND ${clause}`).get(driverId);
  res.json({
    today: earn("date(created_at) = date('now')"),
    week: earn("created_at >= date('now','-7 days')"),
    month: earn("created_at >= date('now','-30 days')"),
  });
});

router.get('/:driverId/messages', (req, res) => {
  const rows = db.prepare('SELECT * FROM messages WHERE driver_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.driverId);
  res.json(rows);
});

router.post('/:driverId/sos', (req, res) => {
  const { driverId } = req.params;
  const { lat, lng } = req.body;
  const driver = db.prepare('SELECT * FROM drivers WHERE id = ?').get(driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  const info = db.prepare('INSERT INTO sos_alerts (driver_id, taxi_id, lat, lng) VALUES (?, ?, ?, ?)')
    .run(driverId, driver.current_taxi_id, lat || null, lng || null);

  req.app.locals.io.to(`owner_${driver.owner_id}`).emit('sos_alert', {
    id: info.lastInsertRowid, driver_id: Number(driverId), driver_name: driver.name, taxi_id: driver.current_taxi_id, lat, lng,
  });
  res.json({ ok: true });
});

module.exports = router;
