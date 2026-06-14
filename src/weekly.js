// ============================================================
// weekly.js - Resumen semanal (domingos)
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { getPrices, getFearGreed, getGlobalMarket, getNews, getGainersLosers } from "./coindesk.js";
import { INSTRUCCIONES_RESUMEN_SEMANAL, VOZ_CRIPTOSCOPE } from "./prompts.js";
import { generarEstadisticasSemana, formatearEstadisticas } from "./tracker.js";

const client = new Anthropic();

export async function ejecutarResumenSemanal() {
  console.log("📅 Generando resumen semanal CriptoScope...");

  const [precios, fearGreed, globalMarket, noticias, gainersLosers] = await Promise.all([
    getPrices(),
    getFearGreed(),
    getGlobalMarket(),
    getNews(30),
    getGainersLosers(),
  ]);

  const contexto = { precios, fearGreed, globalMarket, noticias: noticias.slice(0, 15), gainersLosers };

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 3000,
    system: VOZ_CRIPTOSCOPE,
    messages: [{
      role: "user",
      content: `Semana del ${obtenerRangoSemana()}

CONTEXTO DEL MERCADO ESTA SEMANA:
${JSON.stringify(contexto, null, 1)}

${INSTRUCCIONES_RESUMEN_SEMANAL}`,
    }],
  });

  const txt = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const inicio = txt.indexOf("{"); const fin = txt.lastIndexOf("}");
  const limpio = txt.slice(inicio, fin + 1);
  let paquete;
  try {
    paquete = JSON.parse(limpio);
  } catch (e) {
    // Rescue: extraer campos individualmente
    const extraer = (campo) => {
      const m = limpio.match(new RegExp(`"${campo}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
    };
    paquete = {
      titular: extraer("titular") || "Resumen Semanal CriptoScope",
      resumen: extraer("resumen"),
      pregunta_comunidad: extraer("pregunta_comunidad"),
    };
  }

  const gl = gainersLosers;
  const bloqueGainers = gl
    ? `\n\n─────────────────\n` +
      `<b>📈 Mejores de la semana</b>\n` +
      `${gl.ganadores.map((g) => `$${g.simbolo} <b>+${g.cambio}%</b>`).join("  ·  ")}\n` +
      `<b>📉 Peores de la semana</b>\n` +
      `${gl.perdedores.map((p) => `$${p.simbolo} <b>${p.cambio}%</b>`).join("  ·  ")}`
    : "";

  // Añadir estadísticas de señales de la semana
  const statsSignals = await generarEstadisticasSemana().catch(() => null);
  const bloqueStats = statsSignals ? formatearEstadisticas(statsSignals) : "";

  const pie = paquete.pregunta_comunidad
    ? `\n\n💬 <b>Reflexión de la semana:</b> ${paquete.pregunta_comunidad}`
    : "";

  const mensaje =
    `<b>📊 CRIPTOSCOPE | Resumen Semanal</b>\n<b>${paquete.titular}</b>\n\n` +
    paquete.resumen +
    bloqueGainers +
    bloqueStats +
    pie;

  console.log(`   ✓ Resumen semanal generado: ${paquete.titular}`);
  return { mensaje, paquete };
}

function obtenerRangoSemana() {
  const hoy = new Date();
  const lunes = new Date(hoy);
  lunes.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));
  const domingo = new Date(lunes);
  domingo.setDate(lunes.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString("es-ES", { day: "numeric", month: "long" });
  return `${fmt(lunes)} al ${fmt(domingo)}`;
}
