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
  status TEXT DEFAULT 'offline',       -- offline | online
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
  status TEXT DEFAULT 'active',        -- active | suspended
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
  rating INTEGER,                      -- 1-5, nullable for pure reports
  comment TEXT,
  report_types TEXT,                   -- JSON array string
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  driver_id INTEGER NOT NULL,
  sender TEXT NOT NULL,                -- owner | driver
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

// Migration: add password column to drivers if it doesn't exist yet
// (safe to run every startup — ALTER TABLE fails silently if column exists)
try {
  db.exec(`ALTER TABLE drivers ADD COLUMN password TEXT`);
} catch (_) {
  // column already exists — nothing to do
}

module.exports = db;
