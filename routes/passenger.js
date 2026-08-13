const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Allowed report type values — arbitrary strings are rejected
const ALLOWED_REPORT_TYPES = [
  'unsafe driving',
  'overloading',
  'rude behaviour',
  'reckless speeding',
  'compliment',
];

function taxiWithDriver(taxi) {
  if (!taxi) return null;
  const driver = db.prepare(
    'SELECT id, name FROM drivers WHERE current_taxi_id = ? AND verification_status = ?'
  ).get(taxi.id, 'approved');
  const ratingRow = db.prepare(
    'SELECT AVG(rating) as avg, COUNT(*) as count FROM feedback WHERE taxi_id = ? AND rating IS NOT NULL'
  ).get(taxi.id);
  return {
    id:          taxi.id,
    plate:       taxi.plate,
    status:      taxi.status,
    driver:      driver || null,
    avgRating:   ratingRow.avg,
    ratingCount: ratingRow.count,
  };
}

// Lookup by number plate
router.get('/taxi/plate/:plate', (req, res) => {
  const taxi = db.prepare('SELECT * FROM taxis WHERE plate = ?').get(
    req.params.plate.toUpperCase().trim()
  );
  if (!taxi) return res.status(404).json({ error: 'No taxi found with that plate. Check the plate and try again.' });
  res.json(taxiWithDriver(taxi));
});

router.post('/feedback', (req, res) => {
  const { taxi_id, rating, comment, report_types } = req.body;
  if (!taxi_id) return res.status(400).json({ error: 'taxi_id required' });

  // ── Server-side rating validation ─────────────────────────────────────────
  // Rating is required; must be a whole number between 1 and 5.
  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number between 1 and 5.' });
  }

  // ── Comment length limit ───────────────────────────────────────────────────
  if (comment && comment.length > 1000) {
    return res.status(400).json({ error: 'Comment must be 1000 characters or fewer.' });
  }

  // ── report_types allowlist ────────────────────────────────────────────────
  // Filter to only recognised values; unknown strings are silently dropped.
  const rawTypes = Array.isArray(report_types) ? report_types : [];
  const types = rawTypes.filter((t) => ALLOWED_REPORT_TYPES.includes(t));

  const taxi = db.prepare('SELECT * FROM taxis WHERE id = ?').get(taxi_id);
  if (!taxi) return res.status(404).json({ error: 'Taxi not found.' });

  const driver = db.prepare(
    'SELECT * FROM drivers WHERE current_taxi_id = ? AND verification_status = ?'
  ).get(taxi_id, 'approved');

  const info = db.prepare(
    'INSERT INTO feedback (taxi_id, driver_id, rating, comment, report_types) VALUES (?, ?, ?, ?, ?)'
  ).run(
    taxi_id,
    driver ? driver.id : null,
    ratingNum,
    comment || null,
    JSON.stringify(types)
  );

  const payload = {
    id:          info.lastInsertRowid,
    taxi_id,
    plate:       taxi.plate,
    driver_name: driver ? driver.name : null,
    rating:      ratingNum,
    comment,
    report_types: types,
  };

  req.app.locals.io.to(`owner_${taxi.owner_id}`).emit('new_feedback', payload);

  // Alert owner if rating is low (≤ 2) or incident types reported
  if (types.length || ratingNum <= 2) {
    req.app.locals.io.to(`owner_${taxi.owner_id}`).emit('new_complaint', payload);
  }

  res.json({ ok: true });
});

module.exports = router;
