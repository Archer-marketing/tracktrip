require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { updateDriverLocation } = require('./services/locationService');

const adminRoutes = require('./routes/admin');
const driverRoutes = require('./routes/driver');
const trackRoutes = require('./routes/track');
const monitorRoutes = require('./routes/monitor');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Detras del proxy de Easypanel: sin esto, req.protocol siempre da "http"
// aunque el cliente entre por https (afecta la liga publica de rastreo).
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

app.use('/api/admin', adminRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/track', trackRoutes);
app.use('/api/monitor', monitorRoutes);

app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/driver', express.static(path.join(__dirname, '..', 'public', 'driver')));
app.use('/track', express.static(path.join(__dirname, '..', 'public', 'track')));
app.use('/monitor', express.static(path.join(__dirname, '..', 'public', 'monitor')));
// Liga publica de rastreo con token en la URL (/track/<token>): sirve el
// mismo index.html para que el frontend lea el token del path, ya que no
// es un archivo real. La de monitoreo NO lleva token (es /monitor a secas,
// servida directo por el static de arriba) - liga fija y publica a proposito.
app.get('/track/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'track', 'index.html'));
});
app.get('/', (req, res) => res.redirect('/admin'));

// --- Socket.IO: ubicacion en tiempo real ---
io.on('connection', (socket) => {
  socket.on('driver:location', ({ driver_id, lat, lng }) => {
    if (!driver_id || lat == null || lng == null) return;
    updateDriverLocation(driver_id, lat, lng);

    // Reenviar a todos los paneles de admin conectados
    io.emit('admin:driverUpdate', { driver_id, lat, lng, updated_at: new Date().toISOString() });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
