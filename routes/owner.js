const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { requireOwner } = require('../middleware/auth');

const SALT_ROUNDS = 10;

// ─── Auth (public) ────────────────────────────────────────────────────────────

router.post('/register', async (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password)
    return res.status(400).json({ error: 'name, phone and password are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const info = db.prepare('INSERT INTO owners (name, phone, password) VALUES (?, ?, ?)').run(name, phone, hash);
    const owner = { id: info.lastInsertRowid, name, phone };
    // Log in immediately after registration
    req.session.userId = owner.id;
    req.session.role = 'owner';
    req.session.name = owner.name;
    res.json(owner);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'that phone number is already registered' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password)
    return res.status(400).json({ error: 'phone and password are required' });
  const owner = db.prepare('SELECT * FROM owners WHERE phone = ?').get(phone);
  if (!owner) return res.status(401).json({ error: 'incorrect phone number or password' });
  const match = await bcrypt.compare(password, owner.password);
  if (!match) return res.status(401).json({ error: 'incorrect phone number or password' });
  req.session.userId = owner.id;
  req.session.role = 'owner';
  req.session.name = owner.name;
  res.json({ id: owner.id, name: owner.name, phone: owner.phone });
});

// ─── All routes below require an authenticated owner session ─────────────────

// --- Taxis ---

router.post('/:ownerId/taxis', requireOwner, async (req, res) => {
  const { ownerId } = req.params;
  const { plate } = req.body;
  if (!plate) return res.status(400).json({ error: 'plate required' });
  const qrToken = uuidv4();
  try {
    const info = db.prepare('INSERT INTO taxis (owner_id, plate, qr_token) VALUES (?, ?, ?)').run(ownerId, plate.toUpperCase().trim(), qrToken);
    const passengerUrl = `${req.protocol}://${req.get('host')}/passenger/?t=${qrToken}`;
    const qrDataUrl = await QRCode.toDataURL(passengerUrl);
    res.json({ id: info.lastInsertRowid, plate, qr_token: qrToken, passengerUrl, qrDataUrl });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'a taxi with that plate is already registered' });
    res.status(500).json({ error: e.message });
  }
});

router.get('/:ownerId/taxis', requireOwner, async (req, res) => {
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

router.post('/:ownerId/drivers', requireOwner, async (req, res) => {
  const { ownerId } = req.params;
  const { name, phone, password, license_no, pdp_no } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'a password of at least 6 characters is required for the driver to log in' });
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const info = db.prepare(
      'INSERT INTO drivers (owner_id, name, phone, password, license_no, pdp_no) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(ownerId, name, phone, hash, license_no || null, pdp_no || null);
    res.json({ id: info.lastInsertRowid, name, phone });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'a driver with that phone number already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.get('/:ownerId/drivers', requireOwner, (req, res) => {
  const drivers = db.prepare('SELECT * FROM drivers WHERE owner_id = ? ORDER BY created_at DESC').all(req.params.ownerId);
  res.json(drivers);
});

router.post('/:ownerId/drivers/:driverId/assign', requireOwner, (req, res) => {
  const { driverId } = req.params;
  const { taxi_id } = req.body;
  db.prepare('UPDATE drivers SET current_taxi_id = ? WHERE id = ?').run(taxi_id || null, driverId);
  res.json({ ok: true });
});

router.post('/:ownerId/drivers/:driverId/status', requireOwner, (req, res) => {
  const { driverId } = req.params;
  const { status } = req.body; // active | suspended
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  db.prepare('UPDATE drivers SET status = ? WHERE id = ?').run(status, driverId);
  res.json({ ok: true });
});

// --- Messaging (owner -> driver) ---

router.post('/:ownerId/message', requireOwner, (req, res) => {
  const { ownerId } = req.params;
  const { driver_id, text } = req.body;
  if (!driver_id || !text) return res.status(400).json({ error: 'driver_id and text required' });
  db.prepare('INSERT INTO messages (owner_id, driver_id, sender, text) VALUES (?, ?, ?, ?)')
    .run(ownerId, driver_id, 'owner', text);
  req.app.locals.io.to(`driver_${driver_id}`).emit('new_message', { from: 'owner', text });
  res.json({ ok: true });
});

// --- Dashboard ---

router.get('/:ownerId/dashboard', requireOwner, (req, res) => {
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

router.get('/:ownerId/feedback', requireOwner, (req, res) => {
  const { ownerId } = req.params;
  const rows = db.prepare(
    `SELECT f.*, t.plate, d.name as driver_name FROM feedback f
     JOIN taxis t ON t.id = f.taxi_id
     LEFT JOIN drivers d ON d.id = f.driver_id
     WHERE t.owner_id = ? ORDER BY f.created_at DESC LIMIT 100`
  ).all(ownerId);
  res.json(rows.map((r) => ({ ...r, report_types: JSON.parse(r.report_types || '[]') })));
});

router.post('/:ownerId/sos/:sosId/resolve', requireOwner, (req, res) => {
  db.prepare('UPDATE sos_alerts SET resolved = 1 WHERE id = ?').run(req.params.sosId);
  res.json({ ok: true });
});

module.exports = router;
