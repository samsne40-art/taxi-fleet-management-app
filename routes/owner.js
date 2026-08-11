const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const { requireOwner } = require('../middleware/auth');

const SALT_ROUNDS = 10;

// ── Document upload configuration ───────────────────────────────────────────
// Documents are stored in data/driver_docs/ — NOT inside the public/ folder,
// so they are never served by Express static middleware.
const DOCS_DIR = path.join(__dirname, '..', 'data', 'driver_docs');
fs.mkdirSync(DOCS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOCS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only images (jpg/png/webp) and PDFs are accepted'));
  },
});

const driverUpload = upload.fields([
  { name: 'license_doc', maxCount: 1 },
  { name: 'pdp_doc', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
]);

// ── Auth (public) ────────────────────────────────────────────────────────────

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

// ── All routes below require an authenticated owner session ──────────────────

// ── Taxis ────────────────────────────────────────────────────────────────────

router.post('/:ownerId/taxis', requireOwner, async (req, res) => {
  const { ownerId } = req.params;
  const { plate } = req.body;
  if (!plate) return res.status(400).json({ error: 'plate required' });
  // qr_token kept for DB integrity (NOT NULL constraint); not exposed to clients.
  const qrToken = uuidv4();
  try {
    const info = db.prepare('INSERT INTO taxis (owner_id, plate, qr_token) VALUES (?, ?, ?)').run(ownerId, plate.toUpperCase().trim(), qrToken);
    res.json({ id: info.lastInsertRowid, plate: plate.toUpperCase().trim() });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'a taxi with that plate is already registered' });
    res.status(500).json({ error: e.message });
  }
});

router.get('/:ownerId/taxis', requireOwner, (req, res) => {
  const taxis = db.prepare('SELECT id, plate, status, created_at FROM taxis WHERE owner_id = ? ORDER BY created_at DESC').all(req.params.ownerId);
  const withDriver = taxis.map((t) => {
    const driver = db.prepare('SELECT id, name, phone FROM drivers WHERE current_taxi_id = ?').get(t.id);
    return { ...t, driver: driver || null };
  });
  res.json(withDriver);
});

// ── Drivers ──────────────────────────────────────────────────────────────────

// Create a new driver (multipart/form-data for document uploads)
router.post('/:ownerId/drivers', requireOwner, driverUpload, async (req, res) => {
  const { ownerId } = req.params;
  const {
    name, phone, password,
    id_number,
    license_no, license_expiry,
    pdp_no, pdp_expiry,
    current_taxi_id,
  } = req.body;

  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'a password of at least 6 characters is required' });

  const licenseDocFile = req.files?.license_doc?.[0];
  const pdpDocFile     = req.files?.pdp_doc?.[0];
  const selfieFile     = req.files?.selfie?.[0];

  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const info = db.prepare(`
      INSERT INTO drivers
        (owner_id, name, phone, password, id_number,
         license_no, license_expiry, license_doc_path,
         pdp_no, pdp_expiry, pdp_doc_path,
         selfie_path, current_taxi_id, verification_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      ownerId, name, phone, hash,
      id_number || null,
      license_no || null, license_expiry || null, licenseDocFile?.filename || null,
      pdp_no || null, pdp_expiry || null, pdpDocFile?.filename || null,
      selfieFile?.filename || null,
      current_taxi_id || null,
    );
    res.json({ id: info.lastInsertRowid, name, phone, verification_status: 'pending' });
  } catch (e) {
    // Clean up any uploaded files on error
    [licenseDocFile, pdpDocFile, selfieFile].forEach((f) => {
      if (f) fs.unlink(path.join(DOCS_DIR, f.filename), () => {});
    });
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'a driver with that phone number already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Get all drivers for this owner (summary — no sensitive doc paths)
router.get('/:ownerId/drivers', requireOwner, (req, res) => {
  const drivers = db.prepare(`
    SELECT d.id, d.name, d.phone, d.license_no, d.pdp_no,
           d.license_expiry, d.pdp_expiry, d.status,
           d.verification_status, d.current_taxi_id, d.created_at,
           t.plate as taxi_plate
    FROM drivers d
    LEFT JOIN taxis t ON t.id = d.current_taxi_id
    WHERE d.owner_id = ?
    ORDER BY d.created_at DESC
  `).all(req.params.ownerId);
  res.json(drivers);
});

// Get single driver details (for owner verification view — no passwords)
router.get('/:ownerId/drivers/:driverId', requireOwner, (req, res) => {
  const driver = db.prepare(`
    SELECT d.id, d.name, d.phone, d.id_number,
           d.license_no, d.license_expiry,
           d.pdp_no, d.pdp_expiry,
           d.status, d.verification_status, d.current_taxi_id, d.created_at,
           d.selfie_path IS NOT NULL   as has_selfie,
           d.license_doc_path IS NOT NULL as has_license_doc,
           d.pdp_doc_path IS NOT NULL  as has_pdp_doc,
           t.plate as taxi_plate
    FROM drivers d
    LEFT JOIN taxis t ON t.id = d.current_taxi_id
    WHERE d.id = ? AND d.owner_id = ?
  `).get(req.params.driverId, req.params.ownerId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });
  res.json(driver);
});

// Serve a driver document — authenticated owners only, never exposed publicly
router.get('/:ownerId/drivers/:driverId/document/:field', requireOwner, (req, res) => {
  const { driverId, field } = req.params;
  const allowed = ['license_doc_path', 'pdp_doc_path', 'selfie_path'];
  if (!allowed.includes(field)) return res.status(400).json({ error: 'invalid document field' });

  const driver = db.prepare(`SELECT ${field} FROM drivers WHERE id = ? AND owner_id = ?`).get(driverId, req.params.ownerId);
  if (!driver || !driver[field]) return res.status(404).json({ error: 'document not found' });

  const filePath = path.join(DOCS_DIR, path.basename(driver[field]));
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'file not found on server' });
  });
});

// Set verification status (approve / reject / suspend / pending)
router.post('/:ownerId/drivers/:driverId/verify', requireOwner, (req, res) => {
  const { driverId } = req.params;
  const { status } = req.body;
  const allowed = ['pending', 'approved', 'rejected', 'suspended'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'status must be one of: ' + allowed.join(', ') });

  const driver = db.prepare('SELECT * FROM drivers WHERE id = ? AND owner_id = ?').get(driverId, req.params.ownerId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  db.prepare('UPDATE drivers SET verification_status = ? WHERE id = ?').run(status, driverId);

  // Notify the driver via socket if they happen to be connected
  req.app.locals.io.to(`driver_${driverId}`).emit('verification_update', { status });

  res.json({ ok: true, verification_status: status });
});

// Assign a taxi to a driver
router.post('/:ownerId/drivers/:driverId/assign', requireOwner, (req, res) => {
  const { driverId } = req.params;
  const { taxi_id } = req.body;
  db.prepare('UPDATE drivers SET current_taxi_id = ? WHERE id = ?').run(taxi_id || null, driverId);
  res.json({ ok: true });
});

// Messaging (owner → driver)
router.post('/:ownerId/message', requireOwner, (req, res) => {
  const { ownerId } = req.params;
  const { driver_id, text } = req.body;
  if (!driver_id || !text) return res.status(400).json({ error: 'driver_id and text required' });
  db.prepare('INSERT INTO messages (owner_id, driver_id, sender, text) VALUES (?, ?, ?, ?)')
    .run(ownerId, driver_id, 'owner', text);
  req.app.locals.io.to(`driver_${driver_id}`).emit('new_message', { from: 'owner', text });
  res.json({ ok: true });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

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
    const clause = {
      today: "date(created_at) = date('now')",
      week:  "created_at >= date('now','-7 days')",
      month: "created_at >= date('now','-30 days')",
    }[period];
    return db.prepare(
      `SELECT COALESCE(SUM(fare),0) as total FROM trips WHERE taxi_id IN (${taxiIds.map(() => '?').join(',')}) AND ${clause}`
    ).get(...taxiIds).total;
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

  // Drivers with expiring documents (within next 60 days)
  const expiringDocs = db.prepare(`
    SELECT id, name, license_expiry, pdp_expiry FROM drivers
    WHERE owner_id = ? AND verification_status = 'approved'
    AND (
      (license_expiry IS NOT NULL AND license_expiry <= date('now', '+60 days'))
      OR
      (pdp_expiry IS NOT NULL AND pdp_expiry <= date('now', '+60 days'))
    )
  `).all(ownerId);

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
  const rows = db.prepare(`
    SELECT f.*, t.plate, d.name as driver_name
    FROM feedback f
    JOIN taxis t ON t.id = f.taxi_id
    LEFT JOIN drivers d ON d.id = f.driver_id
    WHERE t.owner_id = ? ORDER BY f.created_at DESC LIMIT 100
  `).all(req.params.ownerId);
  res.json(rows.map((r) => ({ ...r, report_types: JSON.parse(r.report_types || '[]') })));
});

router.post('/:ownerId/sos/:sosId/resolve', requireOwner, (req, res) => {
  db.prepare('UPDATE sos_alerts SET resolved = 1 WHERE id = ?').run(req.params.sosId);
  res.json({ ok: true });
});

module.exports = router;
