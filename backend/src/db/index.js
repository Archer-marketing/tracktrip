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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
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

// Liga publica de rastreo por cliente (se genera al asignar una ruta).
// ALTER TABLE ... ADD COLUMN no tiene "IF NOT EXISTS" en SQLite, asi que
// se intenta y se ignora el error si la columna ya existe.
try {
  db.exec(`ALTER TABLE customers ADD COLUMN tracking_token TEXT`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE customers ADD COLUMN tracking_token_expires_at TEXT`);
} catch (e) {}
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_tracking_token ON customers(tracking_token)`
);

// Factura (texto o liga, tal cual venga del campo de Kommo configurado).
try {
  db.exec(`ALTER TABLE customers ADD COLUMN invoice TEXT`);
} catch (e) {}

// Marca si ya se disparo el salesbot de "faltan 3" / "eres el siguiente"
// para este pedido, para no repetir el disparo en cada entrega/poll.
try {
  db.exec(`ALTER TABLE stops ADD COLUMN notified_3_away INTEGER DEFAULT 0`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE stops ADD COLUMN notified_next INTEGER DEFAULT 0`);
} catch (e) {}

// Interruptor de alertas por cliente/pedido - ya no se usa (se reemplazo
// por notified_3_away/notified_next expuestos como checkbox por alerta),
// se deja la columna por compatibilidad con datos viejos pero el codigo
// no la lee.
try {
  db.exec(`ALTER TABLE customers ADD COLUMN alerts_enabled INTEGER DEFAULT 1`);
} catch (e) {}

// Repartidor tiene que tocar "Iniciar ruta" en su pantalla antes de que se
// dispare cualquier alerta de Kommo para su ruta actual. Se resetea a 0
// cada vez que se le confirma una ruta nueva (assign-route).
try {
  db.exec(`ALTER TABLE drivers ADD COLUMN route_started INTEGER DEFAULT 0`);
} catch (e) {}

// Desde cuando el repartidor esta en (mas o menos) el mismo punto - solo
// para que el admin vea "detenido hace Xm". Se actualiza a la hora actual
// cuando se mueve mas de ~40m; si no, se deja igual.
try {
  db.exec(`ALTER TABLE driver_locations ADD COLUMN stationary_since TEXT`);
} catch (e) {}

// Punto de partida por defecto para armar rutas (ej. la oficina/bodega).
// Se deja precargado con esta liga solo la primera vez; si el admin la
// cambia despues desde el panel, no se vuelve a pisar.
const hasDefaultStart = db.prepare(`SELECT 1 FROM settings WHERE key = 'default_start_url'`).get();
if (!hasDefaultStart) {
  const seed = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
  seed.run('default_start_url', 'https://maps.app.goo.gl/oSd1ksT2SCvapnu9A');
  seed.run('default_start_label', '🏢 Oficina');
}

module.exports = db;
