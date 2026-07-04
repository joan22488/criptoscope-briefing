// ============================================================
// tracker.js - Registro, backtesting y correlación de señales
// Persiste en Notion si está configurado, si no en archivo local
// ============================================================

import { loadJSON, saveJSON } from "./storage.js";
import { guardarSenalEnNotion, obtenerSenalesPendientes, actualizarResultadoSenal, obtenerSenalesSemana } from "./notion.js";

const USA_NOTION = !!process.env.NOTION_TOKEN;

// ─── Persistencia local (fallback sin Notion) ───────────────

const leerSeñalesLocales = () => loadJSON("signals.json", []);
const guardarSeñalesLocales = (senales) => saveJSON("signals.json", senales);

// ─── Registrar nueva señal ───────────────────────────────────

export async function registrarSenal(sym, senal, precio) {
  if (senal.op === "ESPERAR" || !senal.entrada) return null;

  const registro = {
    id: `${sym}-${Date.now()}`,
    symbol: sym,
    op: senal.op,
    entrada: senal.entrada,
    tp1: senal.tp1,
    tp2: senal.tp2,
    sl: senal.sl,
    rr: senal.rr,
    precio_al_enviar: precio,
    fecha: new Date().toISOString(),
    resultado: "PENDIENTE",
    resultado_fecha: null,
  };

  if (USA_NOTION) {
    try { await guardarSenalEnNotion(registro); } catch (e) { console.warn("⚠️  Notion señal:", e.message); }
  } else {
    const todas = leerSeñalesLocales();
    todas.push(registro);
    guardarSeñalesLocales(todas);
  }

  return registro;
}

// ─── Verificar resultados de señales pendientes ──────────────

export async function verificarResultados(preciosActuales) {
  // preciosActuales = { BTC: 64500, ETH: 1680, SOL: 150 }
  const actualizadas = [];

  if (USA_NOTION) {
    try {
      const pendientes = await obtenerSenalesPendientes();
      for (const s of pendientes) {
        const precio = preciosActuales[s.symbol];
        if (!precio) continue;
        const resultado = evaluarSenal(s, precio);
        if (resultado) {
          await actualizarResultadoSenal(s.id, resultado);
          actualizadas.push({ ...s, resultado });
        }
      }
    } catch (e) { console.warn("⚠️  Verificación Notion:", e.message); }
  } else {
    const todas = leerSeñalesLocales();
    let cambios = false;
    for (const s of todas) {
      if (s.resultado !== "PENDIENTE") continue;
      const precio = preciosActuales[s.symbol];
      if (!precio) continue;
      // Expirar señales de más de 48h
      if (Date.now() - new Date(s.fecha).getTime() > 48 * 60 * 60 * 1000) {
        s.resultado = "EXPIRADO";
        s.resultado_fecha = new Date().toISOString();
        cambios = true;
        continue;
      }
      const resultado = evaluarSenal(s, precio);
      if (resultado) {
        s.resultado = resultado;
        s.resultado_fecha = new Date().toISOString();
        actualizadas.push(s);
        cambios = true;
      }
    }
    if (cambios) guardarSeñalesLocales(todas);
  }

  return actualizadas;
}

function evaluarSenal(s, precioActual) {
  if (s.op === "LONG") {
    if (s.tp2 && precioActual >= s.tp2) return "TP2 ✅";
    if (s.tp1 && precioActual >= s.tp1) return "TP1 ✅";
    if (s.sl && precioActual <= s.sl) return "SL ❌";
  } else if (s.op === "SHORT") {
    if (s.tp2 && precioActual <= s.tp2) return "TP2 ✅";
    if (s.tp1 && precioActual <= s.tp1) return "TP1 ✅";
    if (s.sl && precioActual >= s.sl) return "SL ❌";
  }
  return null;
}

// ─── Estadísticas semanales ──────────────────────────────────

export async function generarEstadisticasSemana() {
  let senales = [];

  if (USA_NOTION) {
    try { senales = await obtenerSenalesSemana(); } catch (e) { console.warn("⚠️  Stats Notion:", e.message); }
  } else {
    const todas = leerSeñalesLocales();
    const hace7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
    senales = todas.filter((s) => new Date(s.fecha).getTime() >= hace7d);
  }

  if (!senales.length) return null;

  const longs = senales.filter((s) => s.op === "LONG").length;
  const shorts = senales.filter((s) => s.op === "SHORT").length;
  const tp1 = senales.filter((s) => s.resultado?.includes("TP1")).length;
  const tp2 = senales.filter((s) => s.resultado?.includes("TP2")).length;
  const sl = senales.filter((s) => s.resultado?.includes("SL")).length;
  const pendientes = senales.filter((s) => s.resultado === "PENDIENTE").length;
  const expiradas = senales.filter((s) => s.resultado === "EXPIRADO").length;

  const total = longs + shorts;
  const wins = tp1 + tp2;
  const losses = sl;
  const winrate = total > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : "—";

  return { total, longs, shorts, tp1, tp2, sl, pendientes, expiradas, winrate, senales };
}

export async function obtenerTodasLasSenales(limite = 50) {
  if (USA_NOTION) {
    try { return await obtenerSenalesSemana(); } catch { return []; }
  }
  const todas = leerSeñalesLocales();
  return [...todas]
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, limite);
}

export function formatearEstadisticas(stats) {
  if (!stats || stats.total === 0) return "";

  const wins = stats.tp1 + stats.tp2;
  const losses = stats.sl;

  return (
    `\n\n─────────────────\n` +
    `📈 <b>Rendimiento de señales — 7 días</b>\n` +
    `${stats.longs} LONG  ·  ${stats.shorts} SHORT  ·  ${stats.total} señales\n` +
    `✅ TP1: ${stats.tp1}  ·  TP2: ${stats.tp2}  ·  ❌ SL: ${stats.sl}\n` +
    `<b>Win rate: ${stats.winrate}%</b>  <i>(${wins}W / ${losses}L)</i>`
  );
}

// ─── Correlaciones BTC / ETH / SOL ──────────────────────────

export function calcularCorrelacion(datos) {
  // datos = array de { nombre, tf4h: { ... } }
  if (datos.length < 2) return null;

  // Usamos el RSI 4H como proxy de correlación (mismo dato disponible para todos)
  const valores = datos.map((d) => ({ nombre: d.nombre, rsi: d.tf4h?.rsi?.v, precio: d.precio }));

  // Correlación simple: ¿cuántos tienen el mismo sesgo RSI?
  const zonas = valores.map((v) => v.rsi > 55 ? "ALCISTA" : v.rsi < 45 ? "BAJISTA" : "NEUTRO");
  const todos_iguales = zonas.every((z) => z === zonas[0]);
  const todos_extremos = zonas.every((z) => z !== "NEUTRO");

  let frase = null;

  if (todos_iguales && zonas[0] === "ALCISTA") {
    frase = `Mercado correlacionado al alza — BTC, ETH y SOL empujan juntos. Risk-on generalizado.`;
  } else if (todos_iguales && zonas[0] === "BAJISTA") {
    frase = `Correlación bajista total — BTC, ETH y SOL bajo presión simultánea. Evitar longs aislados.`;
  } else {
    // Buscar divergencia
    const divergentes = valores.filter((v, i) => zonas[i] !== zonas[0]);
    if (divergentes.length > 0) {
      const nombres = divergentes.map((d) => d.nombre).join(" y ");
      const dirBase = zonas[0] === "ALCISTA" ? "sube" : "cae";
      frase = `Divergencia: ${datos[0].nombre} ${dirBase} pero ${nombres} no acompaña — posible rotación de capital o setup débil.`;
    }
  }

  return frase;
}
