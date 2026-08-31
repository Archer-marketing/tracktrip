const axios = require('axios');

// Google a veces se comporta distinto (o pide cookies de consentimiento)
// con clientes sin User-Agent de navegador.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Busca coordenadas en el texto de un link de Google Maps ya "completo"
// (formatos !3d..!4d.., @lat,lng,zoom o ?q=lat,lng), o en el HTML de la
// pagina si vienen embebidas ahi.
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
// pero Google normalmente responde con un redirect 302 hacia la URL
// completa que si las trae. Sin API key ni servicio externo: solo
// seguimos esa redireccion, salto por salto.
async function resolveRedirectLocation(url) {
  try {
    const res = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 5000,
      headers: { 'User-Agent': BROWSER_UA },
    });
    return res.headers.location || null;
  } catch (err) {
    return null;
  }
}

// Respaldo si lo anterior no encontro nada (ej. el link no responde con un
// header "Location" limpio y solo redirige via HTML/JS): deja que axios
// siga las redirecciones solo, y revisa tanto la URL donde termino como el
// HTML de esa pagina por si las coordenadas quedaron ahi.
async function resolveViaFullFetch(url) {
  try {
    const res = await axios.get(url, {
      maxRedirects: 5,
      timeout: 8000,
      validateStatus: () => true,
      headers: { 'User-Agent': BROWSER_UA },
    });

    const finalUrl = res.request?.res?.responseUrl;
    if (finalUrl) {
      const found = extractLatLngFromText(finalUrl);
      if (found) return found;
    }

    if (typeof res.data === 'string') {
      return extractLatLngFromText(res.data);
    }
  } catch (err) {
    return null;
  }
  return null;
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

    const viaFullFetch = await resolveViaFullFetch(raw.trim());
    if (viaFullFetch) return viaFullFetch;
  }

  return null;
}

module.exports = { parseLatLng };
