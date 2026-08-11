const express = require('express');
const router = express.Router();
const db = require('../db');

function taxiWithDriver(taxi) {
  if (!taxi) return null;
  const driver = db.prepare('SELECT id, name FROM drivers WHERE current_taxi_id = ? AND verification_status = ?').get(taxi.id, 'approved');
  const ratingRow = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as count FROM feedback WHERE taxi_id = ? AND rating IS NOT NULL').get(taxi.id);
  return {
    id: taxi.id,
    plate: taxi.plate,
    status: taxi.status,
    driver: driver || null,
    avgRating: ratingRow.avg,
    ratingCount: ratingRow.count,
  };
}

// Lookup by number plate only (QR code removed)
router.get('/taxi/plate/:plate', (req, res) => {
  const taxi = db.prepare('SELECT * FROM taxis WHERE plate = ?').get(req.params.plate.toUpperCase().trim());
  if (!taxi) return res.status(404).json({ error: 'no taxi found with that plate' });
  res.json(taxiWithDriver(taxi));
});

router.post('/feedback', (req, res) => {
  const { taxi_id, rating, comment, report_types } = req.body;
  if (!taxi_id) return res.status(400).json({ error: 'taxi_id required' });
  const taxi = db.prepare('SELECT * FROM taxis WHERE id = ?').get(taxi_id);
  if (!taxi) return res.status(404).json({ error: 'taxi not found' });
  const driver = db.prepare('SELECT * FROM drivers WHERE current_taxi_id = ? AND verification_status = ?').get(taxi_id, 'approved');

  const types = Array.isArray(report_types) ? report_types : [];
  const info = db.prepare(
    'INSERT INTO feedback (taxi_id, driver_id, rating, comment, report_types) VALUES (?, ?, ?, ?, ?)'
  ).run(taxi_id, driver ? driver.id : null, rating || null, comment || null, JSON.stringify(types));

  const payload = {
    id: info.lastInsertRowid,
    taxi_id, plate: taxi.plate,
    driver_name: driver ? driver.name : null,
    rating, comment, report_types: types,
  };
  req.app.locals.io.to(`owner_${taxi.owner_id}`).emit('new_feedback', payload);
  if (types.length || (rating && rating <= 2)) {
    req.app.locals.io.to(`owner_${taxi.owner_id}`).emit('new_complaint', payload);
  }
  res.json({ ok: true });
});

module.exports = router;
