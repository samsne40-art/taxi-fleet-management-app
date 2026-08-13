const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const { requireOwner } = require('../middleware/auth');
const { saToday, saWeekStart, saWeekEnd, saMonthStart, saMonthEnd, saMonthName } = require('../utils/time');

const SALT_ROUNDS = 10;

// ── Document upload configuration ───────────────────────────────────────────
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
  limits: { fileSize: 5 * 1024 * 1024 },
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
    console.error('[owner register]', e);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
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
    [licenseDocFile, pdpDocFile, selfieFile].forEach((f) => {
      if (f) fs.unlink(path.join(DOCS_DIR, f.filename), () => {});
    });
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'a driver with that phone number already exists' });
    console.error('[owner add-driver]', e);
    res.status(500).json({ error: 'Could not add driver. Please try again.' });
  }
});

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

router.post('/:ownerId/drivers/:driverId/verify', requireOwner, (req, res) => {
  const { driverId } = req.params;
  const { status } = req.body;
  const allowed = ['pending', 'approved', 'rejected', 'suspended'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'status must be one of: ' + allowed.join(', ') });

  const driver = db.prepare('SELECT * FROM drivers WHERE id = ? AND owner_id = ?').get(driverId, req.params.ownerId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  db.prepare('UPDATE drivers SET verification_status = ? WHERE id = ?').run(status, driverId);
  req.app.locals.io.to(`driver_${driverId}`).emit('verification_update', { status });
  res.json({ ok: true, verification_status: status });
});

router.post('/:ownerId/drivers/:driverId/assign', requireOwner, (req, res) => {
  const { ownerId, driverId } = req.params;
  const { taxi_id } = req.body;

  // Verify that the target driver belongs to this owner
  const driver = db.prepare('SELECT id FROM drivers WHERE id = ? AND owner_id = ?').get(driverId, ownerId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  // If a taxi is being assigned, verify it also belongs to this owner
  if (taxi_id) {
    const taxi = db.prepare('SELECT id FROM taxis WHERE id = ? AND owner_id = ?').get(taxi_id, ownerId);
    if (!taxi) return res.status(403).json({ error: 'taxi does not belong to you' });
  }

  db.prepare('UPDATE drivers SET current_taxi_id = ? WHERE id = ? AND owner_id = ?').run(taxi_id || null, driverId, ownerId);
  res.json({ ok: true });
});

// Messaging (owner → driver)
router.post('/:ownerId/message', requireOwner, (req, res) => {
  const { ownerId } = req.params;
  const { driver_id, text } = req.body;
  if (!driver_id || !text) return res.status(400).json({ error: 'driver_id and text required' });

  // Verify the target driver belongs to this owner before sending
  const driver = db.prepare('SELECT id FROM drivers WHERE id = ? AND owner_id = ?').get(driver_id, ownerId);
  if (!driver) return res.status(403).json({ error: 'driver not found or does not belong to you' });

  db.prepare('INSERT INTO messages (owner_id, driver_id, sender, text) VALUES (?, ?, ?, ?)')
    .run(ownerId, driver_id, 'owner', text);
  req.app.locals.io.to(`driver_${driver_id}`).emit('new_message', { from: 'owner', text });
  res.json({ ok: true });
});

// ── Live Fleet ────────────────────────────────────────────────────────────────

router.get('/:ownerId/fleet', requireOwner, (req, res) => {
  const { ownerId } = req.params;

  const rows = db.prepare(`
    SELECT
      d.id            AS driver_id,
      d.name          AS driver_name,
      d.verification_status,
      t.id            AS taxi_id,
      t.plate         AS taxi_plate,
      t.status        AS taxi_status,
      dl.lat,
      dl.lng,
      dl.updated_at   AS location_updated_at,
      s.start_time    AS shift_start,
      s.id            AS open_shift_id
    FROM drivers d
    LEFT JOIN taxis            t  ON t.id  = d.current_taxi_id
    LEFT JOIN driver_locations dl ON dl.driver_id = d.id
    LEFT JOIN shifts           s  ON s.driver_id  = d.id AND s.end_time IS NULL
    WHERE d.owner_id = ?
    ORDER BY t.status DESC, d.name ASC
  `).all(ownerId);

  res.json(rows);
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

router.get('/:ownerId/dashboard', requireOwner, (req, res) => {
  const { ownerId } = req.params;

  const taxis   = db.prepare('SELECT * FROM taxis WHERE owner_id = ?').all(ownerId);
  const taxiIds = taxis.map((t) => t.id);
  const online  = taxis.filter((t) => t.status === 'online').length;

  const locations = taxiIds.length
    ? db.prepare(`SELECT * FROM driver_locations WHERE taxi_id IN (${taxiIds.map(() => '?').join(',')})`).all(...taxiIds)
    : [];

  // Earnings using SAST-adjusted date for "today"
  const todayEarn = (() => {
    if (!taxiIds.length) return { total: 0, trips: 0 };
    return db.prepare(
      `SELECT COALESCE(SUM(fare),0) AS total, COUNT(*) AS trips
       FROM trips WHERE taxi_id IN (${taxiIds.map(() => '?').join(',')})
       AND date(created_at,'+2 hours') = date('now','+2 hours')`
    ).get(...taxiIds);
  })();

  const earn = (clause) => {
    if (!taxiIds.length) return 0;
    return db.prepare(
      `SELECT COALESCE(SUM(fare),0) AS total FROM trips WHERE taxi_id IN (${taxiIds.map(() => '?').join(',')}) AND ${clause}`
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
    taxisOnline:  online,
    taxisOffline: taxis.length - online,
    totalTaxis:   taxis.length,
    liveLocations: locations,
    earnings: {
      today:      todayEarn.total,
      tripsToday: todayEarn.trips,
      week:       earn("created_at >= date('now','-7 days')"),
      month:      earn("created_at >= date('now','-30 days')"),
    },
    avgRating: avgRatingRow.avg,
    complaints,
    activeSos,
    expiringDocs,
  });
});

// ── Owner Earnings — full breakdown with filtering ────────────────────────────

router.get('/:ownerId/earnings', requireOwner, (req, res) => {
  const ownerId = req.params.ownerId;
  const { start_date, end_date, driver_id, taxi_id } = req.query;

  const today      = saToday();
  const weekStart  = saWeekStart();
  const weekEnd    = saWeekEnd();
  const monthStart = saMonthStart();
  const monthEnd   = saMonthEnd();

  // The period used for breakdowns — defaults to current month if not specified
  const periodStart = start_date || monthStart;
  const periodEnd   = end_date   || monthEnd;

  // Generic aggregate for a date range (respects driver/taxi filters)
  const aggregate = (s, e) => {
    const params = [ownerId, s, e];
    let extra = '';
    if (driver_id) { extra += ' AND t.driver_id=?'; params.push(driver_id); }
    if (taxi_id)   { extra += ' AND t.taxi_id=?';   params.push(taxi_id); }
    return db.prepare(`
      SELECT COALESCE(SUM(t.fare),0) AS total, COUNT(*) AS trips,
             CASE WHEN COUNT(*)>0 THEN ROUND(SUM(t.fare)/COUNT(*),2) ELSE 0 END AS avg_fare
      FROM trips t
      WHERE t.owner_id=?
        AND date(t.created_at,'+2 hours') >= ?
        AND date(t.created_at,'+2 hours') <= ?
        ${extra}
    `).get(...params);
  };

  // Per-driver breakdown (filtered by taxi if provided, grouped by driver)
  const pdParams = [ownerId, periodStart, periodEnd];
  const pdTaxiEx = taxi_id ? ' AND t.taxi_id=?' : '';
  if (taxi_id) pdParams.push(taxi_id);
  pdParams.push(parseInt(ownerId));
  const byDriver = db.prepare(`
    SELECT d.id AS driver_id, d.name AS driver_name,
           COALESCE(SUM(t.fare),0) AS total, COUNT(t.id) AS trips,
           CASE WHEN COUNT(t.id)>0 THEN ROUND(SUM(t.fare)/COUNT(t.id),2) ELSE 0 END AS avg_fare
    FROM drivers d
    LEFT JOIN trips t ON t.driver_id=d.id AND t.owner_id=?
      AND date(t.created_at,'+2 hours')>=? AND date(t.created_at,'+2 hours')<=?
      ${pdTaxiEx}
    WHERE d.owner_id=?
    GROUP BY d.id
    ORDER BY total DESC
  `).all(...pdParams);

  // Per-taxi breakdown (filtered by driver if provided, grouped by taxi)
  const ptParams = [ownerId, periodStart, periodEnd];
  const ptDriverEx = driver_id ? ' AND t.driver_id=?' : '';
  if (driver_id) ptParams.push(driver_id);
  ptParams.push(parseInt(ownerId));
  const byTaxi = db.prepare(`
    SELECT tx.id AS taxi_id, tx.plate AS taxi_plate,
           COALESCE(SUM(t.fare),0) AS total, COUNT(t.id) AS trips,
           CASE WHEN COUNT(t.id)>0 THEN ROUND(SUM(t.fare)/COUNT(t.id),2) ELSE 0 END AS avg_fare
    FROM taxis tx
    LEFT JOIN trips t ON t.taxi_id=tx.id AND t.owner_id=?
      AND date(t.created_at,'+2 hours')>=? AND date(t.created_at,'+2 hours')<=?
      ${ptDriverEx}
    WHERE tx.owner_id=?
    GROUP BY tx.id
    ORDER BY total DESC
  `).all(...ptParams);

  // Daily totals for the period
  const dtParams = [ownerId, periodStart, periodEnd];
  let dtExtra = '';
  if (driver_id) { dtExtra += ' AND t.driver_id=?'; dtParams.push(driver_id); }
  if (taxi_id)   { dtExtra += ' AND t.taxi_id=?';   dtParams.push(taxi_id); }
  const dailyTotals = db.prepare(`
    SELECT date(t.created_at,'+2 hours') AS sa_date,
           COALESCE(SUM(t.fare),0) AS total, COUNT(*) AS trips
    FROM trips t
    WHERE t.owner_id=?
      AND date(t.created_at,'+2 hours') >= ?
      AND date(t.created_at,'+2 hours') <= ?
      ${dtExtra}
    GROUP BY sa_date
    ORDER BY sa_date DESC
  `).all(...dtParams);

  res.json({
    today:  { date: today,      ...aggregate(today, today)                 },
    week:   { start: weekStart,  end: weekEnd,    ...aggregate(weekStart, weekEnd)    },
    month:  { name: saMonthName(), start: monthStart, end: monthEnd, ...aggregate(monthStart, monthEnd) },
    period: { start: periodStart, end: periodEnd, ...aggregate(periodStart, periodEnd) },
    byDriver,
    byTaxi,
    dailyTotals,
  });
});

// ── Owner Trip History — filterable ──────────────────────────────────────────

router.get('/:ownerId/trips', requireOwner, (req, res) => {
  const ownerId = req.params.ownerId;
  const { driver_id, taxi_id, date, start_date, end_date, payment_method } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  const params = [ownerId];
  let extra = '';

  if (driver_id)      { extra += ' AND t.driver_id=?';                                                   params.push(driver_id); }
  if (taxi_id)        { extra += ' AND t.taxi_id=?';                                                      params.push(taxi_id); }
  if (payment_method) { extra += ' AND t.payment_method=?';                                               params.push(payment_method.toUpperCase()); }
  if (date) {
    extra += " AND date(t.created_at,'+2 hours')=?"; params.push(date);
  } else if (start_date && end_date) {
    extra += " AND date(t.created_at,'+2 hours')>=? AND date(t.created_at,'+2 hours')<=?";
    params.push(start_date, end_date);
  }

  const rows = db.prepare(`
    SELECT t.id, t.fare, t.from_location, t.to_location, t.payment_method, t.created_at,
           d.name  AS driver_name,
           tx.plate AS taxi_plate
    FROM trips t
    LEFT JOIN drivers d  ON d.id  = t.driver_id
    LEFT JOIN taxis   tx ON tx.id = t.taxi_id
    WHERE t.owner_id=? ${extra}
    ORDER BY t.created_at DESC
    LIMIT ${limit}
  `).all(...params);

  res.json(rows);
});

// ── Feedback ──────────────────────────────────────────────────────────────────

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
  // Only resolve alerts whose driver belongs to this owner (prevents cross-owner IDOR)
  const result = db.prepare(`
    UPDATE sos_alerts SET resolved = 1
    WHERE id = ?
      AND driver_id IN (SELECT id FROM drivers WHERE owner_id = ?)
  `).run(req.params.sosId, req.params.ownerId);
  if (result.changes === 0) return res.status(404).json({ error: 'SOS alert not found' });
  res.json({ ok: true });
});

module.exports = router;
