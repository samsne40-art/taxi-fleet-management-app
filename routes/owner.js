const express = require('express');
const router = express.Router();
const db = require('../db');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

// --- Auth (prototype only: plaintext passwords, no sessions/JWT) ---
// Extend this before any real deployment: hash passwords (bcrypt),
// issue signed tokens, rate-limit login attempts.

router.post('/register', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) return res.status(400).json({ error: 'name, phone, password required' });
  try {
    const stmt = db.prepare('INSERT INTO owners (name, phone, password) VALUES (?, ?, ?)');
    const info = stmt.run(name, phone, password);
    res.json({ id: info.lastInsertRowid, name, phone });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'phone already registered' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', (req, res) => {
  const { phone, password } = req.body;
  const owner = db.prepare('SELECT id, name, phone FROM owners WHERE phone = ? AND password = ?').get(phone, password);
  if (!owner) return res.status(401).json({ error: 'invalid phone or password' });
  res.json(owner);
});

// --- Taxis ---

router.post('/:ownerId/taxis', async (req, res) => {
  const { ownerId } = req.params;
  const { plate } = req.body;
  if (!plate) return res.status(400).json({ error: 'plate required' });
  const qrToken = uuidv4();
  try {
    const stmt = db.prepare('INSERT INTO taxis (owner_id, plate, qr_token) VALUES (?, ?, ?)');
    const info = stmt.run(ownerId, plate.toUpperCase().trim(), qrToken);
    const passengerUrl = `${req.protocol}://${req.get('host')}/passenger/?t=${qrToken}`;
    const qrDataUrl = await QRCode.toDataURL(passengerUrl);
    res.json({ id: info.lastInsertRowid, plate, qr_token: qrToken, passengerUrl, qrDataUrl });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'plate already registered' });
    res.status(500).json({ error: e.message });
  }
});

router.get('/:ownerId/taxis', async (req, res) => {
  const taxis = db.prepare('SELECT * FROM taxis WHERE owner_id = ? ORDER BY created_at DESC').all(req.params.ownerId);
  const withQr = await Promise.all(taxis.map(async (t) => {
    const passengerUrl = `${req.protocol}://${req.get('host')}/passenger/?t=${t.qr_token}`;
    const qrDataUrl = await QRCode.toDataURL(passengerUrl);
    const driver = db.prepare('SELECT id, name, phone FROM drivers WHERE current_taxi_id = ?').get(t.id);
    return { ...t, passengerUrl, qrDataUrl, driver: driver || null };
  }));
  res.json(withQr);
});

// --- Drivers ---

router.post('/:ownerId/drivers', (req, res) => {
  const { ownerId } = req.params;
  const { name, phone, license_no, pdp_no } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  try {
    const stmt = db.prepare(
      'INSERT INTO drivers (owner_id, name, phone, license_no, pdp_no) VALUES (?, ?, ?, ?, ?)'
    );
    const info = stmt.run(ownerId, name, phone, license_no || null, pdp_no || null);
    res.json({ id: info.lastInsertRowid, name, phone });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'phone already registered' });
    res.status(500).json({ error: e.message });
  }
});

router.get('/:ownerId/drivers', (req, res) => {
  const drivers = db.prepare('SELECT * FROM drivers WHERE owner_id = ? ORDER BY created_at DESC').all(req.params.ownerId);
  res.json(drivers);
});

router.post('/:ownerId/drivers/:driverId/assign', (req, res) => {
  const { driverId } = req.params;
  const { taxi_id } = req.body;
  db.prepare('UPDATE drivers SET current_taxi_id = ? WHERE id = ?').run(taxi_id || null, driverId);
  res.json({ ok: true });
});

router.post('/:ownerId/drivers/:driverId/status', (req, res) => {
  const { driverId } = req.params;
  const { status } = req.body; // active | suspended
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  db.prepare('UPDATE drivers SET status = ? WHERE id = ?').run(status, driverId);
  res.json({ ok: true });
});

// --- Messaging (owner -> driver) ---

router.post('/:ownerId/message', (req, res) => {
  const { ownerId } = req.params;
  const { driver_id, text } = req.body;
  if (!driver_id || !text) return res.status(400).json({ error: 'driver_id and text required' });
  db.prepare('INSERT INTO messages (owner_id, driver_id, sender, text) VALUES (?, ?, ?, ?)')
    .run(ownerId, driver_id, 'owner', text);
  req.app.locals.io.to(`driver_${driver_id}`).emit('new_message', { from: 'owner', text });
  res.json({ ok: true });
});

// --- Dashboard ---

router.get('/:ownerId/dashboard', (req, res) => {
  const { ownerId } = req.params;

  const taxis = db.prepare('SELECT * FROM taxis WHERE owner_id = ?').all(ownerId);
  const taxiIds = taxis.map((t) => t.id);
  const online = taxis.filter((t) => t.status === 'online').length;

  const locations = taxiIds.length
    ? db.prepare(`SELECT * FROM driver_locations WHERE taxi_id IN (${taxiIds.map(() => '?').join(',')})`).all(...taxiIds)
    : [];

  const earn = (period) => {
    if (!taxiIds.length) return 0;
    const clause = { today: "date(created_at) = date('now')", week: "created_at >= date('now','-7 days')", month: "created_at >= date('now','-30 days')" }[period];
    const row = db.prepare(
      `SELECT COALESCE(SUM(fare),0) as total FROM trips WHERE taxi_id IN (${taxiIds.map(() => '?').join(',')}) AND ${clause}`
    ).get(...taxiIds);
    return row.total;
  };

  const avgRatingRow = taxiIds.length
    ? db.prepare(`SELECT AVG(rating) as avg FROM feedback WHERE taxi_id IN (${taxiIds.map(() => '?').join(',')}) AND rating IS NOT NULL`).get(...taxiIds)
    : { avg: null };

  const complaints = taxiIds.length
    ? db.prepare(`SELECT * FROM feedback WHERE taxi_id IN (${taxiIds.map(() => '?').join(',')}) AND report_types IS NOT NULL AND report_types != '[]' ORDER BY created_at DESC LIMIT 20`).all(...taxiIds)
    : [];

  const activeSos = db.prepare(
    `SELECT s.*, d.name as driver_name FROM sos_alerts s JOIN drivers d ON d.id = s.driver_id WHERE d.owner_id = ? AND s.resolved = 0 ORDER BY s.created_at DESC`
  ).all(ownerId);

  // drivers with expired-ish docs -- placeholder: no expiry dates captured in this prototype,
  // flagged here as a stub so the dashboard shows where that data would appear.
  const expiringDocs = [];

  res.json({
    taxisOnline: online,
    taxisOffline: taxis.length - online,
    totalTaxis: taxis.length,
    liveLocations: locations,
    earnings: { today: earn('today'), week: earn('week'), month: earn('month') },
    avgRating: avgRatingRow.avg,
    complaints,
    activeSos,
    expiringDocs,
  });
});

router.get('/:ownerId/feedback', (req, res) => {
  const { ownerId } = req.params;
  const rows = db.prepare(
    `SELECT f.*, t.plate, d.name as driver_name FROM feedback f
     JOIN taxis t ON t.id = f.taxi_id
     LEFT JOIN drivers d ON d.id = f.driver_id
     WHERE t.owner_id = ? ORDER BY f.created_at DESC LIMIT 100`
  ).all(ownerId);
  res.json(rows.map((r) => ({ ...r, report_types: JSON.parse(r.report_types || '[]') })));
});

router.post('/:ownerId/sos/:sosId/resolve', (req, res) => {
  db.prepare('UPDATE sos_alerts SET resolved = 1 WHERE id = ?').run(req.params.sosId);
  res.json({ ok: true });
});

module.exports = router;
