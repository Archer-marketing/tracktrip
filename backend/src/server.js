require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');

const adminRoutes = require('./routes/admin');
const driverRoutes = require('./routes/driver');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

app.use('/api/admin', adminRoutes);
app.use('/api/driver', driverRoutes);

app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/driver', express.static(path.join(__dirname, '..', 'public', 'driver')));
app.get('/', (req, res) => res.redirect('/admin'));

// --- Socket.IO: ubicacion en tiempo real ---
io.on('connection', (socket) => {
  socket.on('driver:location', ({ driver_id, lat, lng }) => {
    if (!driver_id || lat == null || lng == null) return;
    db.prepare(
      `INSERT INTO driver_locations (driver_id, lat, lng, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(driver_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at`
    ).run(driver_id, lat, lng);

    // Reenviar a todos los paneles de admin conectados
    io.emit('admin:driverUpdate', { driver_id, lat, lng, updated_at: new Date().toISOString() });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
