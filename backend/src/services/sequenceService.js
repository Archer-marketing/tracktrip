const db = require('../db');

// Ultimo numero de parada que ya trae ese repartidor HOY (asignadas +
// entregadas hoy) - para que una ruta nueva/reasignada/reacomodada no
// empiece de nuevo en 1 y choque con las paradas ya entregadas (se veian
// intercaladas en la lista al ordenar por numero). Entregas de dias
// anteriores no cuentan, asi cada dia arranca limpio en 1. `excludeStopIds`
// deja fuera del calculo los stops que se estan por renumerar en esta
// misma operacion (ej. al reordenar/editar una ruta ya activa), para no
// contarlos dos veces y que siga arrancando en 1 en ese caso.
function nextSequenceForDriverToday(driverId, excludeStopIds = []) {
  const placeholders = excludeStopIds.length ? excludeStopIds.map(() => '?').join(',') : null;
  const row = db
    .prepare(
      `SELECT MAX(sequence) as maxSeq FROM stops
       WHERE driver_id = ?
         ${placeholders ? `AND id NOT IN (${placeholders})` : ''}
         AND (status = 'assigned' OR (status = 'delivered' AND date(delivered_at, 'localtime') = date('now', 'localtime')))`
    )
    .get(driverId, ...excludeStopIds);
  return row.maxSeq || 0;
}

module.exports = { nextSequenceForDriverToday };
