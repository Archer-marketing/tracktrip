const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// En Docker/Easypanel se usa SQLITE_PATH (montado en un volumen persistente).
// En local, cae por defecto a backend/data.sqlite
const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  login_code TEXT UNIQUE NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_locations (
  driver_id INTEGER PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (driver_id) REFERENCES drivers(id)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kommo_lead_id TEXT UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  phone TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  driver_id INTEGER,
  sequence INTEGER,
  status TEXT DEFAULT 'pending', -- pending | assigned | delivered | skipped
  assigned_at TEXT,
  delivered_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (driver_id) REFERENCES drivers(id)
);
`);

module.exports = db;
