// ============================================================
// pipeline.js - El flujo completo del briefing matinal
// 1) Datos CoinDesk → 2) Claude genera → 3) Telegram + archivos
// ============================================================

import { getMarketContext } from "./coindesk.js";
import { getTweetsRelevantes } from "./twitter.js";
import { getRedditSignals } from "./reddit.js";
import { generarPaqueteDiario } from "./claude.js";
import { enviarTelegram } from "./telegram.js";
import { guardarPaquete } from "./output.js";

export async function ejecutarBriefing() {
  const inicio = Date.now();
  console.log("🚀 Iniciando briefing CriptoScope...");

  // PASO 1: Recopilar todo en paralelo
  console.log("📡 Obteniendo datos de mercado, tweets y Reddit...");
  const [contexto, tweets, reddit] = await Promise.all([
    getMarketContext(),
    getTweetsRelevantes(),
    getRedditSignals(),
  ]);
  console.log(`   ✓ ${contexto.noticias.length} noticias | BTC/ETH + derivados OK`);
  console.log(`   ✓ ${tweets.length} tweets de alto impacto`);
  console.log(`   ✓ ${reddit.length} posts de Reddit`);
  contexto.tweets = tweets;
  contexto.reddit = reddit;

  // PASO 2: Claude relaciona todo y genera el paquete del día
  console.log("🧠 Generando briefing + guion + thread con Claude...");
  const paquete = await generarPaqueteDiario(contexto);
  console.log(`   ✓ Titular: ${paquete.titular}`);

  // PASO 3a: Guardar archivos locales (tu material de trabajo del día)
  await guardarPaquete(paquete);

  // PASO 3b: Publicar briefing en Telegram
  console.log("📤 Enviando a Telegram...");
  const cabecera = `<b>☕ CRIPTOSCOPE | Briefing Matinal</b>\n<b>${paquete.titular}</b>\n\n`;

  const gl = contexto.gainersLosers;
  const fg = contexto.sentimiento?.fearGreed;
  const gm = contexto.mercadoGlobal;
  const liq = contexto.sentimiento?.liquidaciones;

  // Bloque Fear & Greed + dominancia BTC
  const fgEmoji = fg ? (fg.valor >= 75 ? "🟢" : fg.valor >= 55 ? "🟡" : fg.valor >= 35 ? "🟠" : "🔴") : "";
  const bloqueSentimiento = (fg || gm)
    ? `\n\n─────────────────\n` +
      (fg ? `${fgEmoji} <b>Fear & Greed:</b> ${fg.valor} — ${fg.clasificacion}` + (fg.ayer ? ` (ayer ${fg.ayer})` : "") + "\n" : "") +
      (gm ? `<b>Dominancia BTC:</b> ${gm.dominancia_btc}%  ·  ETH ${gm.dominancia_eth}%\n` : "") +
      (liq ? `<b>Liquidaciones 24h:</b> $${(liq.total_usd / 1e6).toFixed(0)}M  ·  Longs $${(liq.longs_liq_usd / 1e6).toFixed(0)}M  ·  Shorts $${(liq.shorts_liq_usd / 1e6).toFixed(0)}M` : "")
    : "";

  const bloqueGainers = gl
    ? `\n\n─────────────────\n` +
      `<b>📈 Ganadores 24h</b>\n` +
      `${gl.ganadores.map((g) => `$${g.simbolo} <b>+${g.cambio}%</b>`).join("  ·  ")}\n` +
      `<b>📉 Perdedores 24h</b>\n` +
      `${gl.perdedores.map((p) => `$${p.simbolo} <b>${p.cambio}%</b>`).join("  ·  ")}`
    : "";

  const bloquePalabra = paquete.palabra_del_dia
    ? `\n\n─────────────────\n📚 <b>Concepto del día</b>\n${paquete.palabra_del_dia}`
    : "";

  const pie = paquete.pregunta_comunidad
    ? `\n\n💬 <b>Pregunta del día:</b> ${paquete.pregunta_comunidad}`
    : "";

  await enviarTelegram(cabecera + paquete.briefing + bloqueSentimiento + bloqueGainers + bloquePalabra + pie);

  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`✅ Briefing completado en ${seg}s`);
  return paquete;
}
