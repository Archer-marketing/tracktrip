const axios = require('axios');

const ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.com';
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com';
const ORG_ID = process.env.ZOHO_ORGANIZATION_ID || '';

// Token de acceso de corta duracion (~1h en Zoho). Se cachea en memoria y
// se renueva solo cuando ya expiro (o esta por expirar), usando el
// refresh_token de larga duracion generado una vez en el Self Client de
// Zoho (ver README). Un solo proceso Node, no hace falta guardarlo en DB.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const { data } = await axios.post(`${ACCOUNTS_DOMAIN}/oauth/v2/token`, null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    },
  });

  if (!data.access_token) {
    throw new Error(`No se pudo renovar el token de Zoho: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  // Restamos 2 minutos de margen para no usarlo justo cuando expira.
  cachedTokenExpiresAt = Date.now() + (data.expires_in - 120) * 1000;
  return cachedToken;
}

async function zohoClient() {
  const token = await getAccessToken();
  return axios.create({
    baseURL: `${API_DOMAIN}/books/v3`,
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: ORG_ID },
  });
}

// Vendedores dados de alta en Zoho Books (para el selector de mapeo en el panel).
async function getSalespersons() {
  const client = await zohoClient();
  const { data } = await client.get('/salespersons');
  const list = data?.salespersons || [];
  return list
    .filter((s) => s.status !== 'inactive')
    .map((s) => ({ id: s.salesperson_id, name: s.salesperson_name }));
}

// Facturas cuya fecha de factura es hoy (zona horaria del servidor).
// Zoho pagina de a 200 como maximo por pagina.
async function getTodayInvoices() {
  const client = await zohoClient();
  const today = new Date().toISOString().slice(0, 10);

  let invoices = [];
  let page = 1;
  while (true) {
    const { data } = await client.get('/invoices', {
      params: { date_start: today, date_end: today, per_page: 200, page },
    });
    invoices = invoices.concat(data?.invoices || []);
    if (!data?.page_context?.has_more_page) break;
    page++;
  }
  return invoices;
}

// Telefono del contacto (la factura casi nunca trae telefono propio, hay
// que sacarlo del contacto/cliente asociado).
async function getContactPhone(customerId) {
  const client = await zohoClient();
  const { data } = await client.get(`/contacts/${customerId}`);
  return data?.contact?.mobile || data?.contact?.phone || '';
}

module.exports = { getSalespersons, getTodayInvoices, getContactPhone };
