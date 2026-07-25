const axios = require('axios');

// Busca coordenadas en el texto de un link de Google Maps ya "completo"
// (formatos !3d..!4d.., @lat,lng,zoom o ?q=lat,lng).
function extractLatLngFromText(str) {
  const dataMatch = str.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dataMatch) return { lat: parseFloat(dataMatch[1]), lng: parseFloat(dataMatch[2]) };

  const atMatch = str.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) return { lat: parseFloat(atMatch[1]), lng: parseFloat(atMatch[2]) };

  const qMatch = str.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { lat: parseFloat(qMatch[1]), lng: parseFloat(qMatch[2]) };

  const plainMatch = str.match(/^\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
  if (plainMatch) return { lat: parseFloat(plainMatch[1]), lng: parseFloat(plainMatch[2]) };

  return null;
}

// Ligas cortas (maps.app.goo.gl, goo.gl/maps) no traen coords en el texto,
// pero Google responde con un redirect 302 hacia la URL completa que si las
// trae. Sin API key ni servicio externo: solo seguimos esa redireccion.
async function resolveRedirectLocation(url) {
  try {
    const res = await axios.get(url, { maxRedirects: 0, validateStatus: () => true, timeout: 5000 });
    return res.headers.location || null;
  } catch (err) {
    return null;
  }
}

// Acepta "lat,lng" plano, un link de Google Maps completo, o uno acortado.
async function parseLatLng(raw) {
  if (!raw) return null;

  let current = raw.trim();
  const direct = extractLatLngFromText(current);
  if (direct) return direct;

  if (/^https?:\/\//.test(current)) {
    for (let hop = 0; hop < 5; hop++) {
      const next = await resolveRedirectLocation(current);
      if (!next) break;
      const found = extractLatLngFromText(next);
      if (found) return found;
      current = next;
    }
  }

  return null;
}

module.exports = { parseLatLng };
