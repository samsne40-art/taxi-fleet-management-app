const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'taxi.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS taxis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  plate TEXT UNIQUE NOT NULL,
  qr_token TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'offline',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password TEXT,
  license_no TEXT,
  pdp_no TEXT,
  status TEXT DEFAULT 'active',
  current_taxi_id INTEGER REFERENCES taxis(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  taxi_id INTEGER NOT NULL REFERENCES taxis(id),
  start_time TEXT DEFAULT CURRENT_TIMESTAMP,
  end_time TEXT
);

CREATE TABLE IF NOT EXISTS driver_locations (
  driver_id INTEGER PRIMARY KEY REFERENCES drivers(id),
  taxi_id INTEGER,
  lat REAL,
  lng REAL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taxi_id INTEGER NOT NULL REFERENCES taxis(id),
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  fare REAL NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taxi_id INTEGER NOT NULL REFERENCES taxis(id),
  driver_id INTEGER,
  rating INTEGER,
  comment TEXT,
  report_types TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  driver_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL,
  taxi_id INTEGER,
  lat REAL,
  lng REAL,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// ── Migrations (safe to run every startup) ───────────────────────────────────

const migrations = [
  // Driver table columns (added over time)
  `ALTER TABLE drivers ADD COLUMN password TEXT`,
  `ALTER TABLE drivers ADD COLUMN id_number TEXT`,
  `ALTER TABLE drivers ADD COLUMN license_expiry TEXT`,
  `ALTER TABLE drivers ADD COLUMN pdp_expiry TEXT`,
  `ALTER TABLE drivers ADD COLUMN selfie_path TEXT`,
  `ALTER TABLE drivers ADD COLUMN license_doc_path TEXT`,
  `ALTER TABLE drivers ADD COLUMN pdp_doc_path TEXT`,
  `ALTER TABLE drivers ADD COLUMN verification_status TEXT`,
  // Trips table enrichment — full trip recording
  `ALTER TABLE trips ADD COLUMN owner_id INTEGER`,
  `ALTER TABLE trips ADD COLUMN shift_id INTEGER`,
  `ALTER TABLE trips ADD COLUMN from_location TEXT`,
  `ALTER TABLE trips ADD COLUMN to_location TEXT`,
  `ALTER TABLE trips ADD COLUMN payment_method TEXT DEFAULT 'CASH'`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists — ignore */ }
}

// Backfill owner_id on existing trips that were recorded before this column existed.
db.prepare(`
  UPDATE trips
  SET owner_id = (SELECT owner_id FROM taxis WHERE taxis.id = trips.taxi_id)
  WHERE owner_id IS NULL AND taxi_id IS NOT NULL
`).run();

// Set verification_status for drivers created before this column existed.
// Active → approved so existing working accounts keep working.
db.prepare(`UPDATE drivers SET verification_status = 'approved'
            WHERE verification_status IS NULL AND (status = 'active' OR status IS NULL)`).run();
db.prepare(`UPDATE drivers SET verification_status = 'suspended'
            WHERE verification_status IS NULL AND status = 'suspended'`).run();
db.prepare(`UPDATE drivers SET verification_status = 'pending'
            WHERE verification_status IS NULL`).run();

module.exports = db;
