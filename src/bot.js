// ============================================================
// bot.js - Bot de Telegram con comandos bajo demanda
// Escucha mensajes directos al bot y ejecuta acciones
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { getMarketContext, getPrices, getFearGreed, getGlobalMarket } from "./coindesk.js";
import { analizarSymbol, generarSenal } from "./signals.js";
import { getEventosMacro, formatearAlertaMacro } from "./calendar.js";
import { publicarThread } from "./twitter-post.js";
import { enviarTelegram } from "./telegram.js";

const client = new Anthropic();
const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const CANAL = process.env.TELEGRAM_CHAT_ID;

// Estado global
export let pausado = false;
export const setPausado = (v) => { pausado = v; };
export const isPausado = () => pausado;

// Almacén temporal para mensajes pendientes de publicar (callback de botones)
const pendingPublish = new Map();

let offset = 0;

// ──────────────────────────────────────────────
// HELPERS TELEGRAM
// ──────────────────────────────────────────────

async function reply(chatId, texto) {
  const chunks = trocear(texto, 4000);
  for (const chunk of chunks) {
    await fetch(`${API()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  }
}

function trocear(texto, max) {
  if (texto.length <= max) return [texto];
  const trozos = [];
  let actual = "";
  for (const p of texto.split("\n\n")) {
    const sep = actual ? "\n\n" : "";
    if ((actual + sep + p).length > max) {
      if (actual) trozos.push(actual.trim());
      actual = p;
    } else {
      actual = actual + sep + p;
    }
  }
  if (actual.trim()) trozos.push(actual.trim());
  return trozos.filter(Boolean);
}

async function publicarCanal(texto) {
  await enviarTelegram(texto);
}

// ──────────────────────────────────────────────
// COMANDOS
// ──────────────────────────────────────────────

// /flash <tema> — alerta urgente al canal + X
async function cmdFlash(chatId, tema) {
  if (!tema) return reply(chatId, "❓ Uso: /flash <tema o noticia>");
  await reply(chatId, "⚡ Generando flash...");

  const [precios, fearGreed] = await Promise.all([getPrices().catch(() => ({})), getFearGreed().catch(() => null)]);

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 600,
    system: `Eres CriptoScope. Voz directa de trader, sin hype ni promesas. Genera una alerta flash sobre el tema. Máx 3 párrafos cortos. Usa HTML de Telegram (<b>, <i>). Sin emojis excesivos — solo 1-2 relevantes.`,
    messages: [{
      role: "user",
      content: `TEMA: ${tema}\nBTC: $${precios["BTC-USD"]?.precio?.toFixed(0) || "?"} · ETH: $${precios["ETH-USD"]?.precio?.toFixed(0) || "?"}\nFear&Greed: ${fearGreed?.valor || "?"} (${fearGreed?.clasificacion || "?"})`,
    }],
  });

  const cuerpo = response.content[0].text.trim();
  const msg = `🚨 <b>FLASH | CriptoScope</b>\n\n${cuerpo}\n\n<i>Análisis educativo · no es consejo financiero</i>`;

  await publicarCanal(msg);

  // Publicar en X también
  try {
    const limpio = msg.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
    await publicarThread([limpio.slice(0, 270)]);
  } catch {}

  await reply(chatId, "✅ Flash publicado en el canal y en X");
}

// /hilo <tema> — thread educativo completo en canal + X
async function cmdHilo(chatId, tema) {
  if (!tema) return reply(chatId, "❓ Uso: /hilo <tema a explicar>");
  await reply(chatId, "📝 Generando hilo educativo...");

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 1500,
    system: `Eres CriptoScope. Genera un hilo educativo de 5 tweets sobre el tema. Cada tweet máx 260 chars, numerado (1/5, 2/5...). Voz directa, sin hype. Devuelve SOLO JSON: {"tweets": ["tweet1", "tweet2", ...]}`,
    messages: [{ role: "user", content: `TEMA: ${tema}` }],
  });

  const txt = response.content[0].text;
  let tweets;
  try {
    const json = txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1);
    tweets = JSON.parse(json).tweets;
  } catch {
    tweets = txt.split("\n").filter((l) => l.trim().match(/^\d+\//)).slice(0, 6);
  }

  if (!tweets?.length) return reply(chatId, "❌ No pude generar el hilo. Inténtalo de nuevo.");

  // Publicar en canal como mensaje único
  const msgCanal = `📚 <b>HILO | ${tema}</b>\n\n` + tweets.map((t) => t.trim()).join("\n\n") + `\n\n<i>Análisis educativo · no es consejo financiero</i>`;
  await publicarCanal(msgCanal);

  // Publicar en X como thread real
  try {
    await publicarThread(tweets);
  } catch {}

  await reply(chatId, `✅ Hilo de ${tweets.length} tweets publicado en canal y en X`);
}

// /analiza <SYMBOL> — análisis técnico on-demand de cualquier par
async function cmdAnaliza(chatId, symbolRaw) {
  if (!symbolRaw) return reply(chatId, "❓ Uso: /analiza BTC · /analiza ETH · /analiza SOL · /analiza AVAX");
  const symbol = symbolRaw.toUpperCase().replace("USDT", "").replace("/USDT", "").replace("/USD", "") + "USDT";
  await reply(chatId, `📊 Analizando ${symbol.replace("USDT", "")}...`);

  try {
    const datos = await analizarSymbol(symbol);
    const senales = await generarSenal([datos]);
    const hora = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: process.env.TIMEZONE || "Europe/Madrid" });

    // Construir mensaje con el formateador existente
    const msg = buildMsgAnalisis(senales, [datos], hora);
    await publicarCanal(msg);
    await reply(chatId, `✅ Análisis de ${symbol.replace("USDT", "")} publicado en el canal`);
  } catch (e) {
    await reply(chatId, `❌ No pude analizar ${symbol.replace("USDT", "")}: ${e.message}`);
  }
}

function buildMsgAnalisis(senales, datos, hora) {
  const iconOp = { LONG: "🟢 LONG", SHORT: "🔴 SHORT", ESPERAR: "⏸ ESPERAR" };
  const fecha = new Date().toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: process.env.TIMEZONE || "Europe/Madrid" });
  let msg = `<b>📊 CRIPTOSCOPE | Análisis On-Demand</b>\n<b>${fecha} · ${hora}</b>\n\n`;
  for (const [sym, d] of Object.entries(senales)) {
    const info = datos.find((x) => x.nombre === sym);
    const precio = info ? `$${info.precio.toFixed(0)}` : "";
    const funding = info?.funding ? `  ·  Funding ${info.funding.funding_pct}` : "";
    msg += `──────────────\n<b>${sym} ${precio}</b>${funding}\n\n`;
    msg += `${d.sesgo}\n\n${iconOp[d.op] || "⏸ ESPERAR"}\n${d.por_que}\n`;
    if (d.op !== "ESPERAR" && d.entrada) {
      msg += `\nEntrada  <b>${d.entrada}</b>\nTP1  ${d.tp1}  ·  TP2  ${d.tp2}\nSL  ${d.sl}  ·  R:R  ${d.rr}\n`;
      if (d.tamano === "REDUCIDO") msg += `⚠️ Posición reducida\n`;
      msg += `\n✅ Activar si: ${d.cuando}\n`;
    } else {
      msg += `\n🎯 Vigilar: ${d.cuando}\n`;
    }
    if (d.alerta) msg += `\n⚠️ ${d.alerta}\n`;
    msg += "\n";
  }
  msg += `──────────────\n<i>Análisis educativo · no es consejo financiero</i>`;
  return msg;
}

// /opinion <noticia> — CriptoScope opina sobre algo
async function cmdOpinion(chatId, noticia) {
  if (!noticia) return reply(chatId, "❓ Uso: /opinion <noticia o hecho concreto>");
  await reply(chatId, "🧠 Procesando...");

  const precios = await getPrices().catch(() => ({}));

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 700,
    system: `Eres CriptoScope. Opina sobre la noticia con perspectiva de trader — qué significa para el mercado, qué haría el precio, qué vigilarías. Directo, sin rodeos. 2-3 párrafos. HTML Telegram.`,
    messages: [{
      role: "user",
      content: `NOTICIA: ${noticia}\nContexto mercado: BTC $${precios["BTC-USD"]?.precio?.toFixed(0) || "?"} (${precios["BTC-USD"]?.cambio24h_pct?.toFixed(2) || "?"}%)`,
    }],
  });

  const cuerpo = response.content[0].text.trim();
  const msg = `🧠 <b>OPINIÓN | CriptoScope</b>\n\n<i>"${noticia}"</i>\n\n${cuerpo}\n\n<i>Análisis educativo · no es consejo financiero</i>`;
  await publicarCanal(msg);
  try {
    await publicarThread([msg.replace(/<[^>]+>/g, "").slice(0, 270)]);
  } catch {}
  await reply(chatId, "✅ Opinión publicada en el canal y en X");
}

// /precio <coin> — consulta privada de precio (no publica)
async function cmdPrecio(chatId, coin) {
  if (!coin) return reply(chatId, "❓ Uso: /precio BTC · /precio ETH · /precio SOL");
  const precios = await getPrices().catch(() => ({}));
  const key = coin.toUpperCase().replace("USDT", "").replace("USD", "");
  const entry = precios[`${key}-USD`];
  if (!entry) {
    return reply(chatId, `❓ No tengo precio de ${key}. Prueba: BTC, ETH, SOL`);
  }
  const emoji = entry.cambio24h_pct >= 0 ? "🟢" : "🔴";
  await reply(chatId,
    `<b>${key}/USD</b>\n\n${emoji} <b>$${entry.precio.toLocaleString("es-ES")}</b>\n` +
    `Cambio 24h: ${entry.cambio24h_pct >= 0 ? "+" : ""}${entry.cambio24h_pct.toFixed(2)}%\n` +
    `Máx 24h: $${entry.maximo24h.toLocaleString("es-ES")}\n` +
    `Mín 24h: $${entry.minimo24h.toLocaleString("es-ES")}\n` +
    `Vol 24h: $${(entry.volumen24h / 1e9).toFixed(2)}B`
  );
}

// /quepasa — resumen del mercado ahora mismo (privado)
async function cmdQuePasa(chatId) {
  await reply(chatId, "🔍 Revisando el mercado...");
  const [precios, fearGreed, globalMarket] = await Promise.all([
    getPrices().catch(() => ({})),
    getFearGreed().catch(() => null),
    getGlobalMarket().catch(() => null),
  ]);

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 500,
    system: `Eres CriptoScope. Resume el estado del mercado ahora mismo en 3-4 frases directas. Qué domina, qué vigilar, si hay oportunidad o no. Sin rodeos.`,
    messages: [{
      role: "user",
      content: `BTC: $${precios["BTC-USD"]?.precio?.toFixed(0)} (${precios["BTC-USD"]?.cambio24h_pct?.toFixed(2)}%)\nETH: $${precios["ETH-USD"]?.precio?.toFixed(0)} (${precios["ETH-USD"]?.cambio24h_pct?.toFixed(2)}%)\nSOL: $${precios["SOL-USD"]?.precio?.toFixed(0)} (${precios["SOL-USD"]?.cambio24h_pct?.toFixed(2)}%)\nFear&Greed: ${fearGreed?.valor} (${fearGreed?.clasificacion})\nDominancia BTC: ${globalMarket?.dominancia_btc}%`,
    }],
  });

  await reply(chatId, `📡 <b>Mercado ahora</b>\n\n${response.content[0].text.trim()}`);
}

// /senal <SYMBOL> — señal técnica privada sin publicar
async function cmdSenal(chatId, symbolRaw) {
  if (!symbolRaw) return reply(chatId, "❓ Uso: /senal BTC · /senal ETH · /senal SOL");
  const symbol = symbolRaw.toUpperCase().replace("USDT", "").replace("/", "") + "USDT";
  await reply(chatId, `📊 Calculando señal de ${symbol.replace("USDT", "")}...`);
  try {
    const datos = await analizarSymbol(symbol);
    const senales = await generarSenal([datos]);
    const hora = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: process.env.TIMEZONE || "Europe/Madrid" });
    const msg = buildMsgAnalisis(senales, [datos], hora).replace("On-Demand", "Privado 🔒").replace("publicado en el canal", "");
    await reply(chatId, msg);
  } catch (e) {
    await reply(chatId, `❌ Error: ${e.message}`);
  }
}

// /calendario — eventos macro próximos (privado)
async function cmdCalendario(chatId) {
  try {
    const eventos = await getEventosMacro();
    const msg = formatearAlertaMacro(eventos);
    await reply(chatId, msg || "📅 No hay eventos macro importantes esta semana");
  } catch (e) {
    await reply(chatId, `❌ Error obteniendo calendario: ${e.message}`);
  }
}

// /estado — estado del sistema
async function cmdEstado(chatId) {
  const ahora = new Date();
  const madridHora = ahora.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
  const msg =
    `⚙️ <b>Estado CriptoScope</b>\n\n` +
    `🕐 Hora Madrid: ${madridHora}\n` +
    `${pausado ? "⏸ Publicaciones: <b>PAUSADAS</b>" : "▶️ Publicaciones: <b>ACTIVAS</b>"}\n\n` +
    `<b>Próximas ejecuciones:</b>\n` +
    `☕ Briefing: mañana 07:00\n` +
    `📊 Señales: próxima hora en punto (7/11/15/19h)\n` +
    `🚨 Alertas: cada 30 min\n` +
    `📅 Semanal: domingo 09:00\n\n` +
    `<b>Comandos disponibles:</b>\n` +
    `/flash · /hilo · /analiza · /opinion\n` +
    `/precio · /quepasa · /senal · /calendario\n` +
    `/pausa · /activa · /estado`;
  await reply(chatId, msg);
}

// /pausa y /activa
async function cmdPausa(chatId) {
  pausado = true;
  await reply(chatId, "⏸ Publicaciones automáticas <b>pausadas</b>. Usa /activa para reanudar.");
}

async function cmdActiva(chatId) {
  pausado = false;
  await reply(chatId, "▶️ Publicaciones automáticas <b>activadas</b>.");
}

// Foto con noticia → Claude la lee y genera opinión
async function cmdFoto(chatId, photo, caption) {
  await reply(chatId, "👁 Leyendo la imagen...");

  try {
    // Obtener URL de descarga de Telegram
    const fileId = photo[photo.length - 1].file_id;
    const fileInfo = await fetch(`${API()}/getFile?file_id=${fileId}`).then((r) => r.json());
    const filePath = fileInfo.result?.file_path;
    if (!filePath) throw new Error("No se pudo obtener el archivo de Telegram");

    // Descargar imagen y convertir a base64
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
    const imgRes = await fetch(fileUrl);
    const imgBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString("base64");

    await reply(chatId, "🧠 Analizando con Claude...");

    // Obtener precio actual para contexto
    const precios = await getPrices().catch(() => ({}));
    const ctxPrecio = `BTC $${precios["BTC-USD"]?.precio?.toFixed(0) || "?"} · ETH $${precios["ETH-USD"]?.precio?.toFixed(0) || "?"}`;

    // Enviar imagen a Claude con visión
    const response = await client.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 900,
      system: `Eres CriptoScope. Te llega una imagen con una noticia cripto o macro. Primero extrae el titular/contenido de la imagen, luego genera una opinión directa de trader: qué significa, cómo afecta al mercado, qué haría el precio a corto plazo y qué vigilarías. Voz directa, sin hype, sin frases de IA. 2-3 párrafos. HTML Telegram (<b>, <i>).`,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: base64 },
          },
          {
            type: "text",
            text: `Contexto mercado ahora: ${ctxPrecio}${caption ? `\nNota del usuario: ${caption}` : ""}`,
          },
        ],
      }],
    });

    const opinion = response.content[0].text.trim();
    const msg = `🧠 <b>ANÁLISIS | CriptoScope</b>\n\n${opinion}\n\n<i>Análisis educativo · no es consejo financiero</i>`;

    // Guardar en memoria para el callback de publicar
    const pid = Date.now().toString(36);
    pendingPublish.set(pid, msg);
    setTimeout(() => pendingPublish.delete(pid), 30 * 60 * 1000); // expira en 30 min

    // Mostrar opinión con botones de acción
    await fetch(`${API()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg + "\n\n──────────────\n<i>¿Publico esto en el canal y en X?</i>",
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Publicar en canal + X", callback_data: `pub:${pid}` },
            { text: "❌ Solo para mí", callback_data: "nopub" },
          ]],
        },
      }),
    });
  } catch (e) {
    await reply(chatId, `❌ Error analizando la imagen: ${e.message}`);
  }
}

// Manejar respuesta de botones inline
async function procesarCallback(callback) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const data = callback.data;

  // Responder al callback para quitar el "reloj" de Telegram
  await fetch(`${API()}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callback.id }),
  });

  if (data === "nopub") {
    await fetch(`${API()}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
    await reply(chatId, "✅ Guardado solo para ti.");
    return;
  }

  if (data.startsWith("pub:")) {
    const pid = data.slice(4);
    const msg = pendingPublish.get(pid);
    if (!msg) return reply(chatId, "❌ La opinión ya expiró (>30 min). Vuelve a enviar la foto.");

    // Quitar botones
    await fetch(`${API()}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });

    await enviarTelegram(msg);
    try {
      const limpio = msg.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").slice(0, 270);
      await publicarThread([limpio]);
    } catch {}

    pendingPublish.delete(pid);
    await reply(chatId, "✅ Publicado en el canal y en X.");
  }
}

// /ayuda — guía detallada de comandos
async function cmdAyuda(chatId, cmd) {
  const ayudas = {
    flash: {
      titulo: "⚡ /flash — Alerta urgente",
      uso: "/flash <tema o noticia>",
      ejemplo: "/flash BlackRock compra 10.000 BTC · /flash SEC demanda a Coinbase",
      detalle:
        "Genera una alerta de alto impacto sobre lo que le indiques. Claude analiza el tema, lo cruza con el precio actual de BTC/ETH y el Fear&Greed Index, y redacta un mensaje de alerta en la voz de CriptoScope.\n\n" +
        "Se publica inmediatamente en el canal de Telegram y en X como tweet. Ideal para noticias que rompen mientras estás fuera o que quieres comentar en caliente.",
    },
    hilo: {
      titulo: "📝 /hilo — Thread educativo",
      uso: "/hilo <tema a explicar>",
      ejemplo: "/hilo qué es el halving · /hilo cómo funciona el funding rate · /hilo qué son las liquidaciones",
      detalle:
        "Genera un hilo educativo de 5 tweets sobre el tema que indiques. Claude lo estructura de forma didáctica: gancho en el primer tweet, desarrollo en los siguientes, conclusión en el último.\n\n" +
        "Se publica en el canal de Telegram como mensaje único y en X como thread real encadenado. Perfecto para explicar conceptos a tu comunidad de forma clara y con tu voz.",
    },
    analiza: {
      titulo: "📊 /analiza — Análisis técnico on-demand",
      uso: "/analiza <símbolo>",
      ejemplo: "/analiza AVAX · /analiza DOGE · /analiza LINK · /analiza BTC",
      detalle:
        "Ejecuta un análisis técnico completo top-down sobre cualquier coin, no solo BTC/ETH/SOL. Descarga velas reales de 1D + 4H + 1H + 15m desde OKX, calcula RSI 14, MACD 12/26/9, EMA 20/50 y niveles pivot, y genera una señal con Claude.\n\n" +
        "Devuelve: sesgo de mercado, operación (LONG/SHORT/ESPERAR), entrada, TP1, TP2, SL y ratio R:R. Se publica en el canal. Si el setup no es limpio, dice ESPERAR con nivel a vigilar.",
    },
    opinion: {
      titulo: "🧠 /opinion — CriptoScope opina",
      uso: "/opinion <noticia o hecho>",
      ejemplo: "/opinion Ethereum ETF aprobado en Europa · /opinion China legaliza Bitcoin",
      detalle:
        "Le das una noticia y CriptoScope la analiza como trader: qué significa para el mercado, qué haría el precio a corto y medio plazo, y qué vigilarías. Sin hype, sin titulares vacíos.\n\n" +
        "Se publica en el canal y en X. Útil cuando pasa algo importante y quieres dar una lectura rápida pero fundamentada a tu comunidad.",
    },
    precio: {
      titulo: "💰 /precio — Precio actual",
      uso: "/precio <coin>",
      ejemplo: "/precio BTC · /precio ETH · /precio SOL",
      detalle:
        "Consulta privada: te muestra el precio actual de la coin, el cambio en las últimas 24h, el máximo y mínimo del día, y el volumen. Solo te responde a ti — no publica nada en el canal.\n\n" +
        "Útil para consultar rápido antes de tomar una decisión sin salir del chat.",
    },
    quepasa: {
      titulo: "📡 /quepasa — Mercado ahora mismo",
      uso: "/quepasa",
      ejemplo: "/quepasa",
      detalle:
        "Claude revisa BTC, ETH, SOL, Fear&Greed Index y dominancia BTC en tiempo real y te da un resumen de 3-4 frases: qué domina el mercado, si hay momentum o no, y qué vigilar ahora mismo.\n\n" +
        "Consulta privada — no publica en el canal. Perfecto para cuando llevas horas sin mirar el mercado y quieres ponerte al día en segundos.",
    },
    senal: {
      titulo: "🔒 /senal — Señal técnica privada",
      uso: "/senal <coin>",
      ejemplo: "/senal ETH · /senal BTC · /senal SOL",
      detalle:
        "Igual que /analiza pero solo para ti — no publica nada en el canal. Descarga datos reales, calcula todos los indicadores y te devuelve la señal en privado.\n\n" +
        "Ideal para cuando quieres ver el setup antes de decidir si publicarlo o no, o simplemente para tu propia operativa sin molestar a la comunidad.",
    },
    calendario: {
      titulo: "📅 /calendario — Eventos macro",
      uso: "/calendario",
      ejemplo: "/calendario",
      detalle:
        "Muestra los eventos macroeconómicos de alto impacto de la semana: Fed, CPI, NFP, FOMC, datos de empleo... con fecha y hora exacta en Madrid.\n\n" +
        "El sistema ya los incluye automáticamente en el briefing matinal, pero puedes consultarlos aquí en cualquier momento. Útil antes de abrir posiciones para saber si hay riesgo de volatilidad macro.",
    },
    estado: {
      titulo: "⚙️ /estado — Estado del sistema",
      uso: "/estado",
      ejemplo: "/estado",
      detalle:
        "Te muestra un resumen del estado actual: hora de Madrid, si las publicaciones están activas o pausadas, y cuándo son las próximas ejecuciones automáticas (briefing, señales, semanal).\n\n" +
        "También lista todos los comandos disponibles. Útil para comprobar que todo funciona o para saber cuándo llegará el próximo mensaje al canal.",
    },
    pausa: {
      titulo: "⏸ /pausa y /activa — Control de publicaciones",
      uso: "/pausa · /activa",
      ejemplo: "/pausa (para detener) · /activa (para reanudar)",
      detalle:
        "Con /pausa detienes todas las publicaciones automáticas del canal: briefing matinal, señales técnicas, resumen semanal y alertas de evento. El bot sigue respondiendo tus comandos privados con normalidad.\n\n" +
        "Con /activa las reanudas. Útil si vas a publicar contenido manual durante un evento especial y no quieres que el bot interfiera, o si estás de vacaciones.",
    },
  };

  // Si pide ayuda de un comando concreto
  if (cmd) {
    const key = cmd.toLowerCase().replace("/", "").replace("señal", "senal").replace("ayuda", "");
    const info = ayudas[key];
    if (!info) return reply(chatId, `❓ No conozco el comando /${key}. Escribe /ayuda para ver todos.`);
    return reply(chatId,
      `${info.titulo}\n\n` +
      `<b>Uso:</b> <code>${info.uso}</code>\n` +
      `<b>Ejemplos:</b> <code>${info.ejemplo}</code>\n\n` +
      `${info.detalle}`
    );
  }

  // Menú general
  const menu =
    `<b>🤖 CriptoScope Bot — Guía de comandos</b>\n\n` +
    `Escribe <code>/ayuda [comando]</code> para explicación detallada de cualquiera.\n` +
    `Ejemplo: <code>/ayuda flash</code>\n\n` +
    `──────────────\n` +
    `<b>📢 Publican en canal + X</b>\n\n` +
    `<code>/flash</code> &lt;tema&gt;\n` +
    `Alerta urgente sobre una noticia. La genera y publica al instante.\n\n` +
    `<code>/hilo</code> &lt;tema&gt;\n` +
    `Thread educativo de 5 tweets. Publica en canal y en X encadenado.\n\n` +
    `<code>/analiza</code> &lt;coin&gt;\n` +
    `Análisis técnico completo de cualquier coin. Con entrada, TP, SL y R:R.\n\n` +
    `<code>/opinion</code> &lt;noticia&gt;\n` +
    `CriptoScope opina sobre un hecho con perspectiva de trader.\n\n` +
    `──────────────\n` +
    `<b>🔒 Solo te responden a ti</b>\n\n` +
    `<code>/precio</code> &lt;coin&gt;\n` +
    `Precio actual con máx/mín 24h y volumen.\n\n` +
    `<code>/quepasa</code>\n` +
    `Resumen del mercado ahora mismo en 3-4 frases.\n\n` +
    `<code>/senal</code> &lt;coin&gt;\n` +
    `Señal técnica privada sin publicar en el canal.\n\n` +
    `<code>/calendario</code>\n` +
    `Eventos macro de la semana con hora exacta.\n\n` +
    `──────────────\n` +
    `<b>⚙️ Sistema</b>\n\n` +
    `<code>/estado</code> — Estado y próximas ejecuciones\n` +
    `<code>/pausa</code> — Parar publicaciones automáticas\n` +
    `<code>/activa</code> — Reanudar publicaciones\n` +
    `<code>/ayuda</code> — Esta guía`;

  await reply(chatId, menu);
}

// ──────────────────────────────────────────────
// ROUTER DE COMANDOS
// ──────────────────────────────────────────────

async function procesarMensaje(msg) {
  const chatId = msg.chat.id;

  // Si manda una foto → analizarla con visión
  if (msg.photo) {
    await cmdFoto(chatId, msg.photo, msg.caption || "");
    return;
  }

  const texto = msg.text || "";
  if (!texto.startsWith("/")) {
    await reply(chatId, "👋 Hola. Escribe <code>/ayuda</code> para ver todos los comandos.\n\nTambién puedes <b>enviarme una foto</b> de cualquier noticia y la analizo al estilo CriptoScope.");
    return;
  }

  const [cmd, ...args] = texto.split(" ");
  const argStr = args.join(" ").trim();

  console.log(`🤖 Bot: ${cmd} ${argStr ? `"${argStr}"` : ""} (chat ${chatId})`);

  try {
    switch (cmd.toLowerCase().split("@")[0]) {
      case "/flash":      await cmdFlash(chatId, argStr); break;
      case "/hilo":       await cmdHilo(chatId, argStr); break;
      case "/analiza":    await cmdAnaliza(chatId, argStr); break;
      case "/opinion":    await cmdOpinion(chatId, argStr); break;
      case "/precio":     await cmdPrecio(chatId, argStr); break;
      case "/quepasa":    await cmdQuePasa(chatId); break;
      case "/senal":
      case "/señal":      await cmdSenal(chatId, argStr); break;
      case "/calendario": await cmdCalendario(chatId); break;
      case "/estado":     await cmdEstado(chatId); break;
      case "/pausa":      await cmdPausa(chatId); break;
      case "/activa":     await cmdActiva(chatId); break;
      case "/ayuda":
      case "/help":       await cmdAyuda(chatId, argStr); break;
      default:
        await reply(chatId, `❓ Comando no reconocido: ${cmd}\n\nEscribe /estado para ver todos los comandos.`);
    }
  } catch (e) {
    console.error(`❌ Bot error en ${cmd}:`, e.message);
    await reply(chatId, `❌ Error ejecutando ${cmd}: ${e.message}`);
  }
}

// ──────────────────────────────────────────────
// LOOP PRINCIPAL (long-polling)
// ──────────────────────────────────────────────

export async function iniciarBot() {
  console.log("🤖 Bot de comandos iniciado (long-polling)");

  // Registrar comandos en Telegram para el autocompletado
  await fetch(`${API()}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "flash",      description: "Alerta urgente al canal + X" },
        { command: "hilo",       description: "Thread educativo al canal + X" },
        { command: "analiza",    description: "Análisis técnico on-demand" },
        { command: "opinion",    description: "Opinión sobre una noticia" },
        { command: "precio",     description: "Precio actual de una coin (privado)" },
        { command: "quepasa",    description: "Resumen del mercado ahora (privado)" },
        { command: "senal",      description: "Señal técnica privada sin publicar" },
        { command: "calendario", description: "Próximos eventos macro" },
        { command: "estado",     description: "Estado del sistema" },
        { command: "pausa",      description: "Pausar publicaciones automáticas" },
        { command: "activa",     description: "Reanudar publicaciones automáticas" },
        { command: "ayuda",      description: "Guía detallada de todos los comandos" },
      ],
    }),
  }).catch(() => {});

  while (true) {
    try {
      const res = await fetch(`${API()}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["message","callback_query"]`);
      const data = await res.json();
      if (data.ok && data.result.length) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            procesarMensaje(update.message).catch((e) => console.error("❌ procesarMensaje:", e.message));
          } else if (update.callback_query) {
            procesarCallback(update.callback_query).catch((e) => console.error("❌ procesarCallback:", e.message));
          }
        }
      }
    } catch (e) {
      console.warn("⚠️  Bot polling error:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
