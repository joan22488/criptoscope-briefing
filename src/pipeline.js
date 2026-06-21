// ============================================================
// pipeline.js - El flujo completo del briefing matinal
// ============================================================

import { getMarketContext } from "./coindesk.js";
import { getTweetsRelevantes } from "./twitter.js";
import { getRedditSignals } from "./reddit.js";
import { generarPaqueteDiario } from "./claude.js";
import { enviarTelegram, enviarTelegramConFoto, enviarTelegramConFotoId } from "./telegram.js";
import { guardarPaquete } from "./output.js";
import { getEventosMacro } from "./calendar.js";
import { guardarBriefingEnNotion, guardarPublicacionEnNotion } from "./notion.js";
import { publicarTweetUnico } from "./twitter-post.js";
import { generarChartBarras, aplicarLogo } from "./media.js";
import { getPortadaFija } from "./portadas_fijas.js";

async function generarPortadaBriefing(contexto) {
  try {
    const gl = contexto.gainersLosers;
    const precios = contexto.precios || {};

    let coins = [];
    if (gl) {
      coins = [
        ...gl.ganadores.map((g) => ({ label: `$${g.simbolo}`, value: parseFloat(g.cambio) })),
        ...gl.perdedores.map((p) => ({ label: `$${p.simbolo}`, value: parseFloat(p.cambio) })),
      ];
    }

    // Añadir BTC/ETH/SOL si no están ya presentes
    const existentes = new Set(coins.map((c) => c.label));
    for (const [id, d] of Object.entries(precios)) {
      const label = `$${id.replace("-USD", "")}`;
      if (!existentes.has(label) && d.cambio24h_pct != null) {
        coins.push({ label, value: parseFloat(d.cambio24h_pct.toFixed(2)) });
      }
    }

    if (!coins.length) return null;

    // Top 6 ganadores + top 6 perdedores (máx 12 barras)
    const sorted  = [...coins].sort((a, b) => b.value - a.value);
    const top     = sorted.slice(0, 6);
    const bottom  = sorted.slice(-Math.min(6, Math.max(0, sorted.length - top.length)));
    const seleccion = [...new Map([...top, ...bottom].map((c) => [c.label, c])).values()];

    const buf = await generarChartBarras(seleccion);
    return buf ? aplicarLogo(buf) : null;
  } catch (e) {
    console.warn("⚠️ Portada briefing no generada:", e.message);
    return null;
  }
}

// Genera el briefing completo (datos + Claude + texto + portada) sin publicar.
// Devuelve { texto, portadaBuffer, paquete, contexto } para publicar o previsualizar.
export async function generarBriefing() {
  const inicio = Date.now();
  console.log("🚀 Iniciando briefing CriptoScope...");

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

  console.log("🧠 Generando briefing + guion + thread con Claude...");
  const paquete = await generarPaqueteDiario(contexto);
  console.log(`   ✓ Titular: ${paquete.titular}`);

  const cabecera = `<b>☕ CRIPTOSCOPE | Briefing Matinal</b>\n<b>${paquete.titular}</b>\n\n`;

  const gl  = contexto.gainersLosers;
  const fg  = contexto.sentimiento?.fearGreed;
  const gm  = contexto.mercadoGlobal;
  const liq = contexto.sentimiento?.liquidaciones;
  const fgEmoji = fg ? (fg.valor >= 75 ? "🟢" : fg.valor >= 55 ? "🟡" : fg.valor >= 35 ? "🟠" : "🔴") : "";

  let liqLinea = "";
  if (liq && liq.total_usd > 0) {
    const totalM  = (liq.total_usd / 1e6).toFixed(1);
    const longsM  = (liq.longs_liq_usd / 1e6).toFixed(1);
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

  let bloqueMacro = "";
  if (eventosMacro.hoy?.length || eventosMacro.manana?.length) {
    bloqueMacro = `\n\n─────────────────\n⚠️ <b>Macro a vigilar</b>\n`;
    for (const e of [...(eventosMacro.hoy || []), ...(eventosMacro.manana || [])]) {
      const cuando = eventosMacro.hoy?.includes(e) ? "HOY" : "MAÑANA";
      bloqueMacro += `• <b>${e.title}</b> — ${cuando} ${e.time || "?"} ET\n`;
    }
  }

  const bloquePalabra = paquete.palabra_del_dia
    ? `\n\n─────────────────\n📚 <b>Concepto del día</b>\n${paquete.palabra_del_dia}`
    : "";

  const pie   = paquete.pregunta_comunidad ? `\n\n💬 <b>Pregunta del día:</b> ${paquete.pregunta_comunidad}` : "";
  const xLink = process.env.X_PROFILE_URL ? `\n\n🐦 <a href="${process.env.X_PROFILE_URL}">Síguenos en X</a>` : "";

  const texto = cabecera + paquete.briefing + bloqueSentimiento + bloqueGainers + bloqueMacro + bloquePalabra + pie + xLink;
  const portadaBuffer = await generarPortadaBriefing(contexto);

  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`   ✓ Briefing generado en ${seg}s${portadaBuffer ? " + portada" : ""}`);
  return { texto, portadaBuffer, paquete, contexto };
}

export async function ejecutarBriefing() {
  const inicio = Date.now();
  const { texto, portadaBuffer, paquete, contexto } = await generarBriefing();

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

  // PASO 3c: Publicar en X (si configurado)
  let xPublicado = false;
  if (process.env.X_API_KEY && paquete.tweet_x) {
    console.log("🐦 Publicando en X...");
    try {
      await publicarTweetUnico(paquete.tweet_x);
      xPublicado = true;
      console.log("   ✓ Tweet publicado en X");
    } catch (e) {
      console.warn("⚠️ Error publicando en X:", e.message);
      if (e.data) console.warn("   Detalle X:", JSON.stringify(e.data));
      if (process.env.TELEGRAM_OWNER_ID) {
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_OWNER_ID,
            text: `⚠️ <b>Briefing: error al publicar en X</b>\n${e.message}`,
            parse_mode: "HTML",
          }),
        }).catch(() => {});
      }
    }
  }

  // PASO 3d: Publicar briefing en Telegram
  console.log("📤 Enviando a Telegram...");
  const portadaFijaId = getPortadaFija("briefing");
  if (portadaFijaId) {
    await enviarTelegramConFotoId(texto, portadaFijaId);
  } else if (portadaBuffer) {
    await enviarTelegramConFoto(texto, portadaBuffer);
  } else {
    await enviarTelegram(texto);
  }

  guardarPublicacionEnNotion({
    tipo: "Briefing",
    titulo: paquete.titular || "Briefing matinal",
    texto: paquete.briefing,
    plataforma: xPublicado ? "Canal+X" : "Canal",
    conPortada: !!portadaBuffer,
    estado: "Publicado",
  }).catch(() => {});

  const seg = ((Date.now() - inicio) / 1000).toFixed(1);
  console.log(`✅ Briefing completado en ${seg}s`);
  return paquete;
}
