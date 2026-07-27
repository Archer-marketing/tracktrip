const db = require('../db');
const { runSalesbot } = require('./kommoService');

// Salesbots de Kommo a disparar segun cuantos pedidos le faltan a un
// repartidor antes de llegar a ese lead.
const BOT_3_AWAY_ID = process.env.KOMMO_BOT_3_AWAY_ID || '103880';
const BOT_NEXT_ID = process.env.KOMMO_BOT_NEXT_ID || '103878';

// Revisa la ruta actual (asignada, sin entregar) de un repartidor y dispara
// el bot correspondiente a cada lead que este a exactamente 3 paradas o a
// 0 (el siguiente). Si una ruta nunca pasa por "3 antes" (se asigna con
// menos), esa condicion simplemente nunca se cumple y solo se dispara el
// de "el siguiente" cuando le toque - no hace falta logica aparte para eso.
// El conteo de "cuantos faltan" siempre cuenta TODAS las paradas de
// adelante (tengan o no alertas activas); el interruptor por cliente solo
// decide si a ESE cliente en particular se le manda el bot o no.
// Se llama tanto al confirmar una ruta como despues de cada entrega, para
// cubrir tanto el estado inicial como los cambios por avance del repartidor.
async function checkBotTriggersForDriver(driverId) {
  if (!driverId) return;

  const stops = db
    .prepare(
      `SELECT s.id, s.notified_3_away, s.notified_next, c.kommo_lead_id, c.alerts_enabled
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.driver_id = ? AND s.status = 'assigned'
       ORDER BY s.sequence ASC`
    )
    .all(driverId);

  const mark3Away = db.prepare('UPDATE stops SET notified_3_away = 1 WHERE id = ?');
  const markNext = db.prepare('UPDATE stops SET notified_next = 1 WHERE id = ?');

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const remaining = i; // ya viene ordenado por sequence y solo trae 'assigned'
    if (!stop.kommo_lead_id) continue;

    // Este cliente en particular tiene las alertas apagadas: no se le
    // dispara nada, pero tampoco se marca como notificado - si se vuelven
    // a activar despues, sigue avisando normal.
    if (stop.alerts_enabled === 0) continue;

    if (remaining === 3 && !stop.notified_3_away) {
      await runSalesbot(BOT_3_AWAY_ID, stop.kommo_lead_id);
      mark3Away.run(stop.id);
    }
    if (remaining === 0 && !stop.notified_next) {
      await runSalesbot(BOT_NEXT_ID, stop.kommo_lead_id);
      markNext.run(stop.id);
    }
  }
}

module.exports = { checkBotTriggersForDriver };
