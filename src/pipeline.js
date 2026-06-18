// ============================================================
// pipeline.js - El flujo completo del briefing matinal
// ============================================================

import { getMarketContext } from "./coindesk.js";
import { getTweetsRelevantes } from "./twitter.js";
import { getRedditSignals } from "./reddit.js";
import { generarPaqueteDiario } from "./claude.js";
import { enviarTelegram } from "./telegram.js";
import { guardarPaquete } from "./output.js";
import { getEventosMacro } from "./calendar.js";
import { guardarBriefingEnNotion, guardarPublicacionEnNotion } from "./notion.js";
import { publicarThread } from "./twitter-post.js";

export async function ejecutarBriefing() {
  const inicio = Date.now();
  console.log("🚀 Iniciando briefing CriptoScope...");

  // PASO 1: Recopilar todo en paralelo
  console.log("📡 Obteniendo datos de mercado, tweets y Reddit...");
  const [contexto, tweets, reddit, eventosMacro] = await Promise.all([
    getMarketContext(),
    getTweetsRelevantes(),
    getRedditSignals(),
    getEventosMacro(),
  ]);
  console.log(`   ✓ ${contexto.noticias.length} noticias | BTC/ETH + derivados OK`);
  console.log(`   ✓ ${tweets.length} tweets de alto impacto`);
  console.log(`   ✓ ${reddit.length} posts de Reddit`);
  console.log(`   ✓ ${eventosMacro.semana.length} eventos macro esta semana`);
  contexto.tweets = tweets;
  contexto.reddit = reddit;
  contexto.eventosMacro = eventosMacro;

  // PASO 2: Claude genera el paquete del día
  console.log("🧠 Generando briefing + guion + thread con Claude...");
  const paquete = await generarPaqueteDiario(contexto);
  console.log(`   ✓ Titular: ${paquete.titular}`);

  // PASO 3a: Guardar archivos locales
  await guardarPaquete(paquete);

  // PASO 3b: Guardar en Notion (si configurado)
  if (process.env.NOTION_TOKEN) {
    try {
      await guardarBriefingEnNotion(paquete, contexto);
      console.log("   ✓ Guardado en Notion");
    } catch (e) {
      console.warn("   ⚠️ Notion falló:", e.message);
    }
  }

  // PASO 3c: Publicar thread en X (si configurado)
  if (process.env.X_API_KEY && paquete.thread?.length) {
    console.log("🐦 Publicando thread en X...");
    try {
      await publicarThread(paquete.thread);
    } catch (e) {
      console.warn("⚠️ Error publicando thread en X:", e.message);
      if (e.data) console.warn("   Detalle X:", JSON.stringify(e.data));
    }
  }

  // PASO 3d: Publicar briefing en Telegram
  console.log("📤 Enviando a Telegram...");
  const cabecera = `<b>☕ CRIPTOSCOPE | Briefing Matinal</b>\n<b>${paquete.titular}</b>\n\n`;

  const gl = contexto.gainersLosers;
  const fg = contexto.sentimiento?.fearGreed;
  const gm = contexto.mercadoGlobal;
  const liq = contexto.sentimiento?.liquidaciones;

  const fgEmoji = fg ? (fg.valor >= 75 ? "🟢" : fg.valor >= 55 ? "🟡" : fg.valor >= 35 ? "🟠" : "🔴") : "";

  let liqLinea = "";
  if (liq && liq.total_usd > 0) {
    const totalM = (liq.total_usd / 1e6).toFixed(1);
    const longsM = (liq.longs_liq_usd / 1e6).toFixed(1);
    const shortsM = (liq.shorts_liq_usd / 1e6).toFixed(1);
    const liqEmoji = liq.sesgo === "caza de longs" ? "🔴" : liq.sesgo === "caza de shorts" ? "🟢" : "⚪";
    liqLinea = `${liqEmoji} <b>Liquidaciones 24h:</b> $${totalM}M  ·  Longs $${longsM}M  ·  Shorts $${shortsM}M  <i>(${liq.sesgo})</i>\n`;
  }

  const bloqueSentimiento = (fg || gm || liq)
    ? `\n\n─────────────────\n` +
      (fg ? `${fgEmoji} <b>Fear & Greed:</b> ${fg.valor} — ${fg.clasificacion}` + (fg.ayer ? ` (ayer ${fg.ayer})` : "") + "\n" : "") +
      (gm ? `<b>Dominancia BTC:</b> ${gm.dominancia_btc}%  ·  ETH ${gm.dominancia_eth}%\n` : "") +
      liqLinea
    : "";

  const bloqueGainers = gl
    ? `\n\n─────────────────\n` +
      `<b>📈 Ganadores 24h</b>\n` +
      `${gl.ganadores.map((g) => `$${g.simbolo} <b>+${g.cambio}%</b>`).join("  ·  ")}\n` +
      `<b>📉 Perdedores 24h</b>\n` +
      `${gl.perdedores.map((p) => `$${p.simbolo} <b>${p.cambio}%</b>`).join("  ·  ")}`
    : "";

  // Bloque macro: alertar si hay eventos hoy o mañana
  let bloqueMacro = "";
  if (eventosMacro.hoy?.length || eventosMacro.manana?.length) {
    bloqueMacro = `\n\n─────────────────\n⚠️ <b>Macro a vigilar</b>\n`;
    for (const e of [...(eventosMacro.hoy || []), ...(eventosMacro.manana || [])]) {
      const cuando = eventosMacro.hoy?.includes(e) ? "HOY" : "MAÑANA";
      bloqueMacro += `• <b>${e.titulo}</b> — ${cuando} ${e.hora} ET\n`;
    }
  }

  const bloquePalabra = paquete.palabra_del_dia
    ? `\n\n─────────────────\n📚 <b>Concepto del día</b>\n${paquete.palabra_del_dia}`
    : "";

  const pie = paquete.pregunta_comunidad
    ? `\n\n💬 <b>Pregunta del día:</b> ${paquete.pregunta_comunidad}`
    : "";

  await enviarTelegram(cabecera + paquete.briefing + bloqueSentimiento + bloqueGainers + bloqueMacro + bloquePalabra + pie);

  guardarPublicacionEnNotion({
    tipo: "Briefing",
    titulo: paquete.titular || "Briefing matinal",
    texto: paquete.briefing,
    plataforma: paquete.thread?.length ? "Canal+X" : "Canal",
    conPortada: false,
    estado: "Publicado",
  }).catch(() => {});

  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`✅ Briefing completado en ${seg}s`);
  return paquete;
}
