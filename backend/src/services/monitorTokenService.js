const crypto = require('crypto');

// Token deterministico (no se guarda en la base de datos) para que la liga
// de monitoreo NUNCA cambie, ni siquiera si se resetea la base de datos en
// un deploy - se deriva del password de admin, que ya es el secreto del
// sitio, asi que sigue siendo igual de dificil de adivinar.
function getMonitorToken() {
  const secret = process.env.ADMIN_PASSWORD || '';
  return crypto.createHmac('sha256', secret).update('uchben-monitor-link-v1').digest('base64url').slice(0, 32);
}

module.exports = { getMonitorToken };
