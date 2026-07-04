// ============================================================
// weekly.js - Resumen semanal (domingos)
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { getPrices, getFearGreed, getGlobalMarket, getNews, getGainersLosers } from "./coindesk.js";
import { INSTRUCCIONES_RESUMEN_SEMANAL, VOZ_CRIPTOSCOPE } from "./prompts.js";
import { generarEstadisticasSemana, formatearEstadisticas } from "./tracker.js";
import { getVelas } from "./signals.js";
import { generarChartLinea, aplicarLogo } from "./media.js";
import { guardarSemanalEnNotion } from "./notion.js";

const client = new Anthropic();

async function generarGraficoSemanal() {
  const specs = [
    { symbol: "BTCUSDT", label: "BTC", color: "#F7931A" },
    { symbol: "ETHUSDT", label: "ETH", color: "#627EEA" },
    { symbol: "SOLUSDT", label: "SOL", color: "#9945FF" },
  ];

  const resultados = await Promise.all(
    specs.map(async ({ symbol, label, color }) => {
      try {
        const velas = await getVelas(symbol, "1d", 8);
        if (!velas?.length) return null;
        const base = velas[0].close;
        const data  = velas.map((v) => parseFloat(((v.close - base) / base * 100).toFixed(2)));
        const etiquetas = velas.map((v) =>
          new Date(v.time).toLocaleDateString("es-ES", { weekday: "short", day: "numeric" })
        );
        return { label, data, color, etiquetas };
      } catch { return null; }
    })
  );

  const validos = resultados.filter(Boolean);
  if (!validos.length) return null;

  const labels = validos[0].etiquetas;
  const buf = await generarChartLinea(validos, labels);
  return buf ? aplicarLogo(buf) : null;
}

export async function ejecutarResumenSemanal() {
  console.log("📅 Generando resumen semanal CriptoScope...");

  const [precios, fearGreed, globalMarket, noticias, gainersLosers, chartBuffer] = await Promise.all([
    getPrices(),
    getFearGreed(),
    getGlobalMarket(),
    getNews(30),
    getGainersLosers(),
    generarGraficoSemanal().catch((e) => { console.warn("⚠️ Gráfico semanal no generado:", e.message); return null; }),
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
  const inicio = txt.indexOf("{");
  const fin = txt.lastIndexOf("}");
  const limpio = inicio !== -1 && fin !== -1 ? txt.slice(inicio, fin + 1) : txt.replace(/```json|```/g, "").trim();
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
      guion_video: extraer("guion_video"),
      pregunta_comunidad: extraer("pregunta_comunidad"),
    };
  }

  // Si ni el JSON.parse ni el rescate por regex encontraron un resumen, algo fue muy mal
  // (respuesta vacía o con formato inesperado) — avisar al owner en vez de publicar vacío
  if (!paquete.resumen && process.env.TELEGRAM_OWNER_ID) {
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_OWNER_ID,
        text: "⚠️ <b>Resumen semanal:</b> Claude no devolvió un resumen parseable. Revisa antes de confiar en el mensaje generado.",
        parse_mode: "HTML",
      }),
    }).catch(() => {});
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

  const xLink = process.env.X_PROFILE_URL ? `\n\n🐦 <a href="${process.env.X_PROFILE_URL}">Síguenos en X</a>` : "";
  const mensaje =
    `<b>📊 CRIPTOSCOPE | Resumen Semanal</b>\n<b>${paquete.titular}</b>\n\n` +
    paquete.resumen +
    bloqueGainers +
    bloqueStats +
    pie +
    xLink;

  if (process.env.NOTION_TOKEN) {
    try {
      await guardarSemanalEnNotion(paquete);
      console.log("   ✓ Resumen semanal guardado en Notion");
    } catch (e) {
      console.warn("   ⚠️ Notion semanal falló:", e.message);
    }
  }

  // Guion de vídeo al owner (privado, para grabar)
  if (paquete.guion_video && process.env.TELEGRAM_OWNER_ID) {
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_OWNER_ID,
        text: `🎬 <b>Guion semanal — ${paquete.titular}</b>\n\n${paquete.guion_video}`,
        parse_mode: "HTML",
      }),
    }).catch((e) => console.warn("⚠️ Guion de vídeo semanal no se pudo enviar al owner:", e.message));
  }

  console.log(`   ✓ Resumen semanal generado: ${paquete.titular}${chartBuffer ? " + gráfico" : ""}`);
  return { mensaje, paquete, chartBuffer };
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
