// ============================================================
// activity.js - Log de actividad del bot
// Ring buffer de 150 eventos, persistido en DATA_DIR: con un
// Volume en Railway sobrevive a deploys y reinicios.
// ============================================================

import { loadJSON, saveJSON } from "./storage.js";

const log = loadJSON("activity_log.json", []);
const MAX = 150;

export function logActividad({ tipo, titulo = "", plataforma = "", estado = "OK", detalle = "" }) {
  log.push({
    ts: Date.now(),
    tipo,
    titulo:   titulo.slice(0, 80),
    plataforma,
    estado,
    detalle:  detalle.slice(0, 120),
  });
  if (log.length > MAX) log.shift();
  saveJSON("activity_log.json", log);
}

// Devuelve los últimos n eventos en orden descendente (más reciente primero)
export function getLog(n = 15) {
  const tam = Math.min(Math.abs(n), 50);
  return log.slice(-tam).reverse();
}

// Estadísticas de las últimas 24h
export function getLogStats() {
  const hace24h = Date.now() - 24 * 60 * 60 * 1000;
  const hoy     = log.filter((e) => e.ts > hace24h);
  const ok  = hoy.filter((e) => e.estado === "OK").length;
  const err = hoy.filter((e) => e.estado.startsWith("Error")).length;
  const des = hoy.filter((e) => e.estado === "Descartado").length;
  return { total: hoy.length, ok, err, des };
}
