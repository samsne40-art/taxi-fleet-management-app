/**
 * Notification helper — inserts a notification row and immediately pushes it
 * to the correct authenticated Socket.io room.
 *
 * @param {import('socket.io').Server} io
 * @param {Object} opts
 * @param {'owner'|'driver'} opts.recipientType
 * @param {number}           opts.recipientId
 * @param {string}           opts.type          — e.g. 'shift_start', 'sos_alert'
 * @param {string}           opts.title
 * @param {string}           opts.message
 * @returns {{ id, recipient_type, recipient_id, type, title, message, is_read, created_at }}
 */
const db = require('../db');

function createNotification(io, { recipientType, recipientId, type, title, message }) {
  const info = db.prepare(`
    INSERT INTO notifications (recipient_type, recipient_id, type, title, message)
    VALUES (?, ?, ?, ?, ?)
  `).run(recipientType, recipientId, type, title, message);

  const notif = db.prepare(`
    SELECT id, recipient_type, recipient_id, type, title, message, is_read, created_at
    FROM notifications WHERE id = ?
  `).get(info.lastInsertRowid);

  // Push to the correct room — rooms are validated at join-time (server.js)
  const room = recipientType === 'owner'
    ? `owner_${recipientId}`
    : `driver_${recipientId}`;

  if (io) io.to(room).emit('new_notification', notif);

  return notif;
}

/**
 * Create a doc-expiry notification only if one hasn't been created for the
 * same driver in the last 24 hours (avoids spamming on every dashboard load).
 */
function createDocExpiryNotificationIfNeeded(io, { ownerId, driverId, driverName, expiryFields }) {
  const recent = db.prepare(`
    SELECT id FROM notifications
    WHERE recipient_type = 'owner'
      AND recipient_id   = ?
      AND type           = 'doc_expiry'
      AND json_extract(message, '$.driver_id') = ?
      AND created_at     >= datetime('now', '-24 hours')
    LIMIT 1
  `).get(ownerId, driverId);

  if (recent) return null; // already notified in the last 24h

  const parts = [];
  if (expiryFields.license_expiry) parts.push(`licence expires ${expiryFields.license_expiry}`);
  if (expiryFields.pdp_expiry)     parts.push(`PDP expires ${expiryFields.pdp_expiry}`);

  return createNotification(io, {
    recipientType: 'owner',
    recipientId:   ownerId,
    type:          'doc_expiry',
    title:         `⚠️ Document expiry — ${driverName}`,
    message:       JSON.stringify({ driver_id: driverId, details: parts.join(', ') }),
  });
}

module.exports = { createNotification, createDocExpiryNotificationIfNeeded };
