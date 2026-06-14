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

// ──────────────────────────────────────────────
// ROUTER DE COMANDOS
// ──────────────────────────────────────────────

async function procesarMensaje(msg) {
  const chatId = msg.chat.id;
  const texto = msg.text || "";
  if (!texto.startsWith("/")) {
    await reply(chatId, "👋 Hola. Comandos disponibles:\n\n<b>Publicar en canal + X:</b>\n/flash · /hilo · /analiza · /opinion\n\n<b>Consulta privada:</b>\n/precio · /quepasa · /senal · /calendario\n\n<b>Sistema:</b>\n/estado · /pausa · /activa");
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
      ],
    }),
  }).catch(() => {});

  while (true) {
    try {
      const res = await fetch(`${API()}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["message"]`);
      const data = await res.json();
      if (data.ok && data.result.length) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message) {
            procesarMensaje(update.message).catch((e) => console.error("❌ procesarMensaje:", e.message));
          }
        }
      }
    } catch (e) {
      console.warn("⚠️  Bot polling error:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
