// ============================================================
// bot.js - Bot de Telegram con comandos bajo demanda
// Escucha mensajes directos al bot y ejecuta acciones
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { getMarketContext, getPrices, getFearGreed, getGlobalMarket, puntuarNoticia } from "./coindesk.js";
import { analizarSymbol, generarSenal, getVelas, calcEMA, getContextoDerivadosBTC } from "./signals.js";
import { getEventosMacro, formatearAlertaMacro, formatearResumenSemana } from "./calendar.js";
import { publicarThread, publicarTweetUnico, subirImagenX } from "./twitter-post.js";
import { enviarTelegram, enviarTelegramConFoto } from "./telegram.js";
import { ejecutarResumenSemanal } from "./weekly.js";
import { guardarPublicacionEnNotion } from "./notion.js";
import { generarEstadisticasSemana } from "./tracker.js";
import { aplicarLogo, fetchGraficoBuffer, generarBannerX } from "./media.js";
import { ejecutarBriefing, generarBriefing } from "./pipeline.js";
import { getPortadaFija, setPortadaFija, clearPortadaFija } from "./portadas_fijas.js";
import { cancelarEditorial } from "./editorial.js";

const client = new Anthropic();
const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const OWNER = () => process.env.TELEGRAM_OWNER_ID;

// Elimina guiones medios/largos que cuela Claude — delatan texto de IA
const limpiarDashes = (s) => typeof s === "string"
  ? s.replace(/ [–—] /g, ": ").replace(/[–—]/g, ".").replace(/ - /g, ": ")
  : s;

// Estado global
export let pausado = false;
export const setPausado = (v) => { pausado = v; };
export const isPausado = () => pausado;

// Almacén temporal para mensajes pendientes de publicar (callback de botones)
const pendingPublish = new Map();
// Publicaciones manuales pendientes de confirmación (/publicar)
const pendingManual = new Map(); // chatId → { texto, fotoBuffer? }

// ── Rate limiting — evita spam de comandos costosos ──
const cooldowns = new Map(); // `${chatId}:${cmd}` → timestamp
function checkCooldown(chatId, cmd, segundos) {
  const key = `${chatId}:${cmd}`;
  const ultimo = cooldowns.get(key) || 0;
  const restante = Math.ceil((ultimo + segundos * 1000 - Date.now()) / 1000);
  if (restante > 0) return restante;
  cooldowns.set(key, Date.now());
  return 0;
}

// ── Publicaciones programadas ──────────────────
const programadas = new Map(); // id → { descripcion, timer }
let progContador = 1;

// ── Portadas pendientes ────────────────────────
const portadas = new Map();         // pid → fileId de la foto portada
const waitingCover = new Map();     // chatId → pid (esperando foto de portada)
const waitingPortadaFija = new Map(); // chatId → tipo "briefing"|"semanal" (esperando foto para portada fija)

// ── Hilos pendientes (array de tweets para publicar en X como thread real) ──
const hilosPendientes = new Map(); // pid → string[]

// ── Señales pendientes de revisión (owner aprueba antes de publicar al canal) ──
const senalesPendientes = new Map(); // pid → mensaje

// Expuestas para la Mini App API
export const getSenalesPendientesReview = () =>
  [...senalesPendientes.entries()].map(([pid, mensaje]) => ({ pid, mensaje }));

// Genera un tweet adaptado para X desde el texto de una señal técnica
async function generarTweetDeSenal(msgSenal) {
  const limpio = msgSenal.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  try {
    const res = await client.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `Eres el redactor de X de CriptoScope (análisis cripto en español).

Señal técnica completa (incluye datos de derivados Binance si aparecen: OI, Top L/S, Taker):
${limpio.slice(0, 2000)}

Escribe UN tweet de 210-240 caracteres. Resalta el dato más potente: dirección, nivel clave y razón técnica concisa.
Si hay datos de OI, Top L/S ratio o Taker y REFUERZAN la dirección, inclúyelos brevemente de forma natural (ej: "OI +2% + top traders largos confirman"). Si contradicen la dirección, no los menciones.

Ejemplo de formato:
🟢 BTC LONG. Entrada $104.500. TP $107K / SL $103K. R:R 1.8x.
RSI 1H saliendo de sobreventa con MACD cruzando. OI creciendo + top traders largos confirman.

PROHIBIDO: guiones medios o largos (– o —), HTML, links, menciones.
Devuelve SOLO el tweet, sin comillas ni etiquetas.`,
      }],
    });
    return limpiarDashes(res.content[0].text.trim());
  } catch {
    const lineas = limpio.split("\n").filter((l) => l.trim().length > 15 && !l.includes("──"));
    return lineas.slice(0, 3).join(" ").slice(0, 230);
  }
}

export async function publicarSenalPendiente(pid) {
  const msg = senalesPendientes.get(pid);
  if (!msg) return false;
  senalesPendientes.delete(pid);
  await enviarTelegram(msg);

  let xPublicado = false;
  if (process.env.X_API_KEY) {
    try {
      const tweet = await generarTweetDeSenal(msg);
      await publicarTweetUnico(tweet);
      xPublicado = true;
    } catch (e) {
      console.warn("⚠️ Error publicando señal en X:", e.message);
    }
  }

  guardarPublicacionEnNotion({ tipo: "Señal", titulo: "Señal técnica automática", texto: msg, plataforma: xPublicado ? "Canal+X" : "Canal", estado: "Publicado" }).catch(() => {});
  return true;
}

export function descartarSenalPendiente(pid) {
  const ok = senalesPendientes.has(pid);
  senalesPendientes.delete(pid);
  return ok;
}

// ── Alertas de precio (persistentes) ──────────
const ALERTAS_FILE = "./data/alertas.json";
function cargarAlertas() {
  try {
    if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
    if (existsSync(ALERTAS_FILE)) return JSON.parse(readFileSync(ALERTAS_FILE, "utf8"));
  } catch {}
  return [];
}
function guardarAlertas(arr) {
  try {
    if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
    writeFileSync(ALERTAS_FILE, JSON.stringify(arr, null, 2));
  } catch {}
}
// [{coin, precio, direccion, chatId}]  direccion: "sube"|"baja"
let alertasPrecios = cargarAlertas();

// ── Monitor de noticias (guid → timestamp) ──
const noticiasVistas = new Map();
function limpiarNoticiasViejas() {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  for (const [guid, ts] of noticiasVistas) {
    if (ts < limite) noticiasVistas.delete(guid);
  }
}
// Caché de títulos de noticias — evita superar el límite de 64 bytes de callback_data
const noticiasCache = new Map(); // nid → { titulo, link }
const cachearNoticia = (titulo, link) => {
  const nid = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  noticiasCache.set(nid, { titulo, link });
  setTimeout(() => noticiasCache.delete(nid), 2 * 60 * 60 * 1000); // expira en 2h
  return nid;
};

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

// Muestra preview con botones de publicación (canal/X/portada)
async function mostrarBotonesPublicacion(chatId, pid, previewTexto) {
  const tienePortada = portadas.has(pid);
  await fetch(`${API()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: previewTexto + `\n\n──────────────\n<i>¿Dónde publico esto?${tienePortada ? " 📸 Portada lista." : ""}</i>`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📢 Canal + X", callback_data: `pub_ambos:${pid}` },
            { text: "📣 Solo canal", callback_data: `pub_canal:${pid}` },
          ],
          [
            { text: "🐦 Solo X", callback_data: `pub_x:${pid}` },
            { text: tienePortada ? "🖼 Cambiar portada" : "📸 Añadir portada", callback_data: `add_portada:${pid}` },
          ],
          [
            { text: "🟡 Binance Square", callback_data: `pub_bs:${pid}` },
            { text: "📊 CMC Community", callback_data: `pub_cmc:${pid}` },
          ],
          [
            { text: "❌ Descartar", callback_data: "nopub" },
          ],
        ],
      },
    }),
  });
}

const xFooter = () => process.env.X_PROFILE_URL
  ? `\n\n🐦 <a href="${process.env.X_PROFILE_URL}">Síguenos en X</a>`
  : "";

// Trunca texto para encajar en el límite de caption de Telegram (1024 chars).
// Corta en el último párrafo o frase completa; añade footer al final.
function truncarCaption(texto, footer = "") {
  const MAX = 1020; // margen respecto al límite oficial de 1024
  if ((texto + footer).length <= MAX) return texto + footer;
  const SUFIJO = " [...]";
  const disponible = MAX - footer.length - SUFIJO.length;
  const recorte = texto.slice(0, disponible);
  const umbral = disponible * 0.55;
  const pos = Math.max(
    recorte.lastIndexOf("\n\n") > umbral ? recorte.lastIndexOf("\n\n") : -1,
    recorte.lastIndexOf(". ")  > umbral ? recorte.lastIndexOf(". ") + 1 : -1,
    recorte.lastIndexOf("\n")  > umbral ? recorte.lastIndexOf("\n")  : -1,
  );
  return (pos > 0 ? recorte.slice(0, pos) : recorte).trimEnd() + SUFIJO + footer;
}

async function publicarCanal(texto, portadaFileId = null) {
  const footer   = xFooter();
  // Evitar duplicar el link de X si el texto ya lo incluye (viene de generarBriefing/semanal)
  const xUrl     = process.env.X_PROFILE_URL;
  const completo = (xUrl && texto.includes(xUrl)) ? texto : texto + footer;
  const CAPTION_MAX = 1020;
  const cabe = completo.length <= CAPTION_MAX;

  if (portadaFileId) {
    // Si cabe: foto + texto completo en caption. Si no: foto sola + texto completo aparte.
    const caption    = cabe ? completo : "";
    const restoTexto = cabe ? null : completo;

    try {
      const fileInfoRes = await fetch(`${API()}/getFile?file_id=${encodeURIComponent(portadaFileId)}`, { signal: AbortSignal.timeout(10000) });
      const fileInfo = await fileInfoRes.json();
      if (!fileInfo.ok) throw new Error(fileInfo.description || "getFile falló");
      const imgRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`, { signal: AbortSignal.timeout(20000) });
      if (!imgRes.ok) throw new Error(`Descarga imagen HTTP ${imgRes.status}`);
      const imgLogo = await aplicarLogo(Buffer.from(await imgRes.arrayBuffer()));
      const form = new FormData();
      form.append("chat_id", process.env.TELEGRAM_CHAT_ID);
      form.append("photo", new Blob([imgLogo], { type: "image/png" }), "portada.png");
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
      const res  = await fetch(`${API()}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(25000) });
      const json = await res.json();
      if (!json.ok) throw new Error(json.description || JSON.stringify(json));
    } catch (e) {
      console.warn("⚠️ Portada con logo fallida, usando file_id original:", e.message);
      const res  = await fetch(`${API()}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, photo: portadaFileId, caption, parse_mode: "HTML" }),
      });
      const json = await res.json();
      if (!json.ok) {
        console.warn("⚠️ sendPhoto fallback también falló, enviando solo texto");
        await enviarTelegram(completo);
        return;
      }
    }

    // Enviar solo el resto del texto (sin repetir el encabezado que ya fue caption)
    if (restoTexto) await enviarTelegram(restoTexto);
    return;
  }

  await enviarTelegram(completo);
}

// ──────────────────────────────────────────────
// COMANDOS
// ──────────────────────────────────────────────

// /flash <tema> — alerta urgente al canal + X
async function cmdFlash(chatId, tema, portadaFileId = null) {
  if (!tema) return reply(chatId, "❓ Uso: /flash <tema o noticia>\n\nTip: manda una foto con <code>/flash tema</code> en el pie para publicarla como portada.");
  await reply(chatId, "⚡ Generando flash...");

  const derivados = await getContextoDerivadosBTC().catch(() => null);
  const ctxDerivados = derivados?.resumen
    ? `\n\nCONTEXTO DERIVADOS LIVE (úsalo si es relevante al tema, no lo cites literalmente):\n${derivados.resumen}`
    : "";

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 700,
    system: `Eres CriptoScope. Analista senior, voz directa y fría.

Genera el flash en este formato EXACTO (responde SOLO el contenido, sin etiquetas ni explicaciones):

GANCHO: [1 frase impactante sobre el tema. Puede ser una afirmación rotunda, la conclusión clave o la pregunta que deja el hecho sobre la mesa.]
CUERPO: [2 párrafos de análisis con implicaciones, contexto y qué vigilar. HTML Telegram: <b>, <i>. 1-2 emojis funcionales máx: 📊🔴🟢⚠️🎯]

REGLA CRÍTICA: NUNCA menciones un precio específico de BTC, ETH u otra moneda si ese precio no aparece textualmente en el TEMA. No lo inventes, no lo estimes, no lo deduzcas. Si el tema no tiene precio concreto, el análisis no lo tiene. Usa "el precio actual" si necesitas referirte a él.
Voz activa. Frases cortas. PROHIBIDO: guiones (– o —), 🚀💎🙌, clickbait, consejos financieros.${ctxDerivados}`,
    messages: [{
      role: "user",
      content: `TEMA: ${tema}`,
    }],
  });

  const raw = response.content[0].text.trim();

  // Extraer GANCHO y CUERPO del formato estructurado
  const ganchoMatch = raw.match(/GANCHO:\s*(.+?)(?:\n|$)/s);
  const cuerpoMatch = raw.match(/CUERPO:\s*([\s\S]+)/s);
  let gancho = limpiarDashes(ganchoMatch ? ganchoMatch[1].trim() : raw.split("\n")[0]);
  const cuerpo = limpiarDashes(cuerpoMatch ? cuerpoMatch[1].trim() : raw.split("\n").slice(1).join("\n").trim());

  // Red de seguridad: si el GANCHO empieza con precio/coin inventado, usar primera frase del CUERPO
  const tienePrecionInventado = /^(BTC|ETH|SOL|bitcoin|ethereum|el precio|la cotización)\s/i.test(gancho)
    || /^\$[\d.,]+/.test(gancho);
  if (tienePrecionInventado) {
    const primeraFrase = cuerpo.replace(/<[^>]+>/g, "").split(/(?<=[.!?])\s/)[0]?.trim();
    if (primeraFrase && primeraFrase.length > 20) gancho = primeraFrase;
  }

  const msg = `🚨 <b>FLASH | CriptoScope</b>\n\n<b>${gancho}</b>\n\n${cuerpo}\n\n<i>Análisis educativo · no es consejo financiero</i>`;

  const pid = Date.now().toString(36);
  pendingPublish.set(pid, msg);
  if (portadaFileId) portadas.set(pid, portadaFileId);
  setTimeout(() => { pendingPublish.delete(pid); portadas.delete(pid); }, 30 * 60 * 1000);

  await mostrarBotonesPublicacion(chatId, pid, msg);
}

// /hilo <tema|URL> — thread educativo completo en canal + X
async function cmdHilo(chatId, tema, portadaFileId = null) {
  if (!tema) return reply(chatId, "❓ Uso: /hilo <tema a explicar>\n\nTambién puedes pasar una URL de artículo:\n<code>/hilo https://coindesk.com/...</code>\n\nO manda una foto con <code>/hilo tema</code> en el pie para publicarla como portada.");

  // Si el argumento es una URL, leer el artículo primero
  let contextoExtra = "";
  if (/^https?:\/\//i.test(tema)) {
    await reply(chatId, "🔗 Leyendo el artículo...");
    try {
      const htmlRes = await fetch(tema, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
      if (!htmlRes.ok) throw new Error(`HTTP ${htmlRes.status}`);
      const html = await htmlRes.text();
      // Extraer texto: quitar scripts, estilos y tags HTML
      const texto = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 4000);
      contextoExtra = `\n\nCONTENIDO DEL ARTÍCULO:\n${texto}`;
      tema = `artículo de ${new URL(tema).hostname}`;
    } catch (e) {
      await reply(chatId, `⚠️ No pude leer la URL (${e.message}). Generando hilo solo con el título...`);
    }
  }

  await reply(chatId, "📝 Generando hilo educativo...");

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 1500,
    system: `Eres CriptoScope. Genera un hilo educativo de 5 tweets sobre el tema. Cada tweet es autónomo: funciona aunque el lector entre por el tweet 3. Numerados (1/5, 2/5...). Máx 260 chars cada uno.\nVoz directa y fría. Tweet 1: la tesis en una frase, sin contexto. Tweets 2-4: un punto concreto por tweet con datos o niveles exactos. Tweet 5: conclusión o regla práctica aplicable.\nPROHIBIDO: guiones medios o largos (– o —), 🚀💎🙌WAGMI, clickbait, consejos financieros directos, predicciones sin datos.\nDevuelve SOLO JSON: {"tweets": ["tweet1", "tweet2", ...]}`,
    messages: [{ role: "user", content: `TEMA: ${tema}${contextoExtra}` }],
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

  tweets = tweets.map((t) => limpiarDashes(t.trim()));

  // Canal: elimina numeración "1/5", "2/5"... y une como texto cohesionado
  const tweetsCanal = tweets.map((t) => t.replace(/^\d+\/\d+[\s:·\-–—]*/u, "").trim());
  const msgCanal = `📚 <b>HILO | ${tema.toUpperCase()}</b>\n\n` + tweetsCanal.join("\n\n") + `\n\n<i>Análisis educativo · no es consejo financiero</i>`;
  const pid = Date.now().toString(36);
  pendingPublish.set(pid, msgCanal);
  hilosPendientes.set(pid, tweets); // guardar tweets separados para publicar como thread real en X
  if (portadaFileId) portadas.set(pid, portadaFileId);
  setTimeout(() => { pendingPublish.delete(pid); portadas.delete(pid); hilosPendientes.delete(pid); }, 30 * 60 * 1000);
  await mostrarBotonesPublicacion(chatId, pid, msgCanal);
}

// /analiza <SYMBOL> — análisis técnico on-demand de cualquier par
async function cmdAnaliza(chatId, symbolRaw, portadaFileId = null) {
  if (!symbolRaw) return reply(chatId, "❓ Uso: /analiza BTC · /analiza ETH · /analiza SOL · /analiza AVAX");
  const coin = symbolRaw.trim().split(/\s+/)[0]; // ignorar argumentos extra como timeframe
  const symbol = coin.toUpperCase().replace("USDT", "").replace("/USDT", "").replace("/USD", "") + "USDT";
  await reply(chatId, `📊 Analizando ${symbol.replace("USDT", "")}...`);

  try {
    const datos = await analizarSymbol(symbol);
    const senales = await generarSenal([datos]);
    const hora = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: process.env.TIMEZONE || "Europe/Madrid" });

    const msg = buildMsgAnalisis(senales, [datos], hora);
    const pid = Date.now().toString(36);
    pendingPublish.set(pid, msg);
    if (portadaFileId) portadas.set(pid, portadaFileId);
    setTimeout(() => { pendingPublish.delete(pid); portadas.delete(pid); }, 30 * 60 * 1000);

    // Gráfico de velas 4H con EMA20/EMA50/volumen via quickchart.io
    if (datos.velas4h?.length) {
      try {
        const chartConfig = buildChartConfig(datos);
        const buf = await fetchGraficoBuffer(chartConfig).then((b) => b ? aplicarLogo(b) : null);
        if (buf) {
          const form = new FormData();
          form.append("chat_id", chatId.toString());
          form.append("photo", new Blob([buf], { type: "image/png" }), "chart.png");
          form.append("caption", `📊 ${datos.nombre}/USDT 4H · EMA20 · EMA50 · OKX`);
          const photoRes = await fetch(`${API()}/sendPhoto`, { method: "POST", body: form });
          const photoJson = await photoRes.json();
          if (photoJson.ok) portadas.set(pid, photoJson.result.photo.at(-1).file_id);
        }
      } catch (e) {
        console.warn("⚠️ Gráfico no generado:", e.message);
      }
    }

    await mostrarBotonesPublicacion(chatId, pid, msg);
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

// Construye config de gráfico de velas para quickchart.io
// Acepta (nombre, velas[], ema20[], ema50[], tfLabel) o (datos) para compatibilidad con /analiza
function buildChartConfig(nombreOrDatos, velas, ema20arr, ema50arr, tfLabel = "4H") {
  let nombre, velasData, tf;
  if (typeof nombreOrDatos === "object" && nombreOrDatos.velas4h) {
    nombre    = nombreOrDatos.nombre;
    velasData = nombreOrDatos.velas4h;
    ema20arr  = nombreOrDatos.ema20_4h || [];
    ema50arr  = nombreOrDatos.ema50_4h || [];
    tf = "4H";
  } else {
    nombre    = nombreOrDatos;
    velasData = velas;
    tf        = tfLabel;
  }
  if (!velasData?.length) return null;
  const ts       = velasData.map((v) => new Date(v.time).getTime());
  const candles  = velasData.map((v, i) => ({
    x: ts[i],
    o: +v.open.toFixed(2), h: +v.high.toFixed(2),
    l: +v.low.toFixed(2),  c: +v.close.toFixed(2),
  }));
  const ema20Data = (ema20arr || []).map((y, i) => ({ x: ts[i], y: +y.toFixed(2) }));
  const ema50Data = (ema50arr || []).map((y, i) => ({ x: ts[i], y: +y.toFixed(2) }));
  const volData   = velasData.map((v, i) => ({ x: ts[i], y: v.volume }));
  const volColors = velasData.map((v) => v.close >= v.open ? "rgba(38,166,154,0.35)" : "rgba(239,83,80,0.35)");
  const maxVol    = Math.max(...velasData.map((v) => v.volume));
  return {
    type: "candlestick",
    data: {
      datasets: [
        { label: `${nombre}/USDT ${tf}`, data: candles,
          color: { up: "rgba(38,166,154,0.9)", down: "rgba(239,83,80,0.9)", unchanged: "#888" } },
        { type: "bar",  label: "Vol",   data: volData,   backgroundColor: volColors, yAxisID: "vol", order: 3 },
        { type: "line", label: "EMA20", data: ema20Data, borderColor: "#ffc107", borderWidth: 1.5, pointRadius: 0, fill: false, order: 1 },
        { type: "line", label: "EMA50", data: ema50Data, borderColor: "#2196f3", borderWidth: 1.5, pointRadius: 0, fill: false, order: 1 },
      ],
    },
    options: {
      scales: {
        x:   { ticks: { maxTicksLimit: 8, color: "#aaa" } },
        y:   { position: "right", ticks: { color: "#aaa" } },
        vol: { position: "left", display: false, max: maxVol * 5 },
      },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: "CriptoScope · x.com/joan22488",
          position: "bottom",
          color: "rgba(255,255,255,0.35)",
          font: { size: 11 },
        },
      },
    },
  };
}

// Compatibilidad: wrapper GET para /analiza (30 velas — URL corta, sigue funcionando)
function generarGraficoUrl(nombreOrDatos, velas, ema20arr, ema50arr, tfLabel = "4H") {
  const chart = buildChartConfig(nombreOrDatos, velas, ema20arr, ema50arr, tfLabel);
  if (!chart) return null;
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chart))}&w=800&h=420&bkg=%231e1e2e&f=png`;
}

// /grafico <coin> [timeframe] — gráfico de velas + análisis del TF + preview + botones
async function cmdGrafico(chatId, args) {
  const partes = (args || "").trim().split(/\s+/);
  const symbolRaw = partes[0];
  if (!symbolRaw) return reply(chatId, "❓ Uso: /grafico BTC · /grafico ETH 1H · /grafico SOL 1D\n\nTimeframes: 15m · 1H · 4H · 1D");

  const symbol  = symbolRaw.toUpperCase().replace("USDT", "").replace(/\/.*/, "") + "USDT";
  const nombre  = symbol.replace("USDT", "");

  const tfInput = (partes[1] || "4H").toUpperCase();
  const TF_MAP  = { "15M": "15m", "1H": "1h", "4H": "4h", "1D": "1d" };
  const tf      = TF_MAP[tfInput] || "4h";
  const tfLabel = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" }[tf];

  const limitMap = { "15m": 30, "1h": 30, "4h": 30, "1d": 30 };
  const limit    = limitMap[tf] || 30;

  await reply(chatId, `📊 Generando gráfico y análisis ${nombre} ${tfLabel}...`);

  try {
    // Fetch velas del TF pedido + datos completos en paralelo
    const [velas, datos] = await Promise.all([
      getVelas(symbol, tf, limit),
      analizarSymbol(symbol),
    ]);
    const slice  = velas.slice(-Math.min(limit, velas.length));
    const ema20s = calcEMA(slice, 20);
    const ema50s = calcEMA(slice, 50);

    // Generar PNG via POST (sin límite de URL) y subir a Telegram
    let chartFileId = null;
    try {
      const chartConfig = buildChartConfig(nombre, slice, ema20s, ema50s, tfLabel);
      const buf = await fetchGraficoBuffer(chartConfig);
      if (buf) {
        const form = new FormData();
        form.append("chat_id", chatId.toString());
        form.append("photo", new Blob([buf], { type: "image/png" }), "chart.png");
        form.append("caption", `📊 ${nombre}/USDT ${tfLabel} · EMA20 · EMA50 · OKX`);
        const photoRes  = await fetch(`${API()}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
        const photoJson = await photoRes.json();
        if (photoJson.ok) {
          chartFileId = photoJson.result.photo.at(-1).file_id;
        } else {
          throw new Error(`Telegram: ${photoJson.description}`);
        }
      }
    } catch (chartErr) {
      console.warn("Grafico fallido:", chartErr.message);
      // plain text para evitar fallo de HTML parse en errores externos
      await fetch(`${API()}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: `Sin grafico: ${chartErr.message}` }),
      });
    }

    // Extraer datos técnicos del TF solicitado
    const tfKey = { "1D": "tf1d", "4H": "tf4h", "1H": "tf1h", "15m": "tf15m" }[tfLabel] || "tf4h";
    const td = datos[tfKey];

    // Generar análisis profundo + setup de trade si las condiciones lo justifican
    const res = await client.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 700,
      system: `Eres CriptoScope. Analiza ${nombre}/USDT en ${tfLabel} con los datos técnicos.
Estructura (HTML Telegram, <b> e <i>):

1. <b>Sesgo ${tfLabel}:</b> posición respecto a EMA20/EMA50 + qué dice la estructura de velas
2. <b>Indicadores:</b> RSI zona y tendencia, MACD cruce y dirección del histograma, divergencias si las hay
3. <b>Niveles clave:</b> soporte y resistencia principales del ${tfLabel}

Si hay setup válido (RR mínimo 1.5), añade bloque de trade:
<b>Setup:</b> LONG/SHORT
Entrada: X · TP1: X · TP2: X · SL: X · R:R X
<i>Activar si: condición concreta de confirmación</i>

Si no hay setup, una frase explicando por qué esperar.

Voz directa, sin relleno. PROHIBIDO: guiones medios o largos (– o —), emojis no funcionales, predicciones sin base.`,
      messages: [{
        role: "user",
        content: `${nombre}/USDT ${tfLabel}
Precio: ${td.precio} · EMA20: ${td.ema20} · EMA50: ${td.ema50}
RSI(14): ${td.rsi.v} (${td.rsi.zona})${td.rsi.div ? ` · ${td.rsi.div}` : ""}
MACD: ${td.macd.cruce} · histograma ${td.macd.hist_dir === "^" ? "subiendo" : "bajando"} · sobre cero: ${td.macd.cero === "+" ? "sí" : "no"}${td.macd.div ? ` · ${td.macd.div}` : ""}
Resistencia: ${td.res} · Soporte: ${td.sop}
Funding: ${datos.funding?.funding_pct || "N/A"} · OI: ${datos.funding?.open_interest ? (datos.funding.open_interest / 1e6).toFixed(2) + "M" : "N/A"}
Pivots — R1: ${datos.pivots?.r1 || "?"} · S1: ${datos.pivots?.s1 || "?"}`,
      }],
    });

    const analisis = limpiarDashes(res.content[0].text.trim());
    const msg = `📊 <b>ANÁLISIS | ${nombre}/USDT ${tfLabel}</b>\n\n${analisis}\n\n<i>Análisis educativo · no es consejo financiero</i>`;

    const pid = Date.now().toString(36);
    pendingPublish.set(pid, msg);
    if (chartFileId) portadas.set(pid, chartFileId); // gráfico adjunto en la publicación
    setTimeout(() => { pendingPublish.delete(pid); portadas.delete(pid); }, 30 * 60 * 1000);
    await mostrarBotonesPublicacion(chatId, pid, msg);

  } catch (e) {
    await reply(chatId, `❌ Error: ${e.message}`);
  }
}

// /opinion <noticia> — CriptoScope opina sobre algo
async function cmdOpinion(chatId, noticia, portadaFileId = null) {
  if (!noticia) return reply(chatId, "❓ Uso: /opinion <noticia o hecho concreto>");
  await reply(chatId, "🧠 Procesando...");

  const precios = await getPrices().catch(() => ({}));

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 700,
    system: `Eres CriptoScope. Analiza esta noticia con perspectiva de trader: qué significa para el mercado, cómo puede mover el precio, qué nivel vigilarías.

REGLA DE APERTURA: Abre con la conclusión de la noticia, no con el precio de BTC. El precio de mercado es contexto de fondo. Si la noticia no tiene relación directa con BTC, no lo menciones en la apertura.
Voz directa y fría. Distingue entre lo que dice la noticia y lo que podría implicar para el precio. Si hay incertidumbre, nómbrala. 2-3 párrafos. HTML Telegram (<b>, <i>).
PROHIBIDO: guiones medios o largos (– o —), 🚀💎🙌, clickbait, consejos financieros directos, predicciones sin datos.`,
    messages: [{
      role: "user",
      content: `NOTICIA: ${noticia}\n\nCONTEXTO (úsalo si es relevante): BTC $${precios["BTC-USD"]?.precio?.toFixed(0) || "?"} (${precios["BTC-USD"]?.cambio24h_pct?.toFixed(2) || "?"}% 24h)`,
    }],
  });

  const cuerpo = limpiarDashes(response.content[0].text.trim());
  const msg = `🧠 <b>OPINIÓN | CriptoScope</b>\n\n<i>"${noticia}"</i>\n\n${cuerpo}\n\n<i>Análisis educativo · no es consejo financiero</i>`;

  const pid = Date.now().toString(36);
  pendingPublish.set(pid, msg);
  if (portadaFileId) portadas.set(pid, portadaFileId);
  setTimeout(() => { pendingPublish.delete(pid); portadas.delete(pid); }, 30 * 60 * 1000);

  await mostrarBotonesPublicacion(chatId, pid, msg);
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

// /quepasa — resumen del mercado ahora mismo + botones de publicación
async function cmdQuePasa(chatId, portadaFileId = null) {
  await reply(chatId, "🔍 Revisando el mercado...");
  const [precios, fearGreed, globalMarket] = await Promise.all([
    getPrices().catch(() => ({})),
    getFearGreed().catch(() => null),
    getGlobalMarket().catch(() => null),
  ]);

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 500,
    system: `Eres CriptoScope. Resume el estado del mercado ahora mismo en 3-4 frases directas. Abre con el dato más relevante, no con contexto. Qué domina, qué vigilar, si hay oportunidad o no. Niveles exactos cuando los haya. Voz activa. PROHIBIDO: guiones medios o largos (– o —), rodeos, emojis decorativos, consejos de compra/venta.`,
    messages: [{
      role: "user",
      content: `BTC: $${precios["BTC-USD"]?.precio?.toFixed(0)} (${precios["BTC-USD"]?.cambio24h_pct?.toFixed(2)}%)\nETH: $${precios["ETH-USD"]?.precio?.toFixed(0)} (${precios["ETH-USD"]?.cambio24h_pct?.toFixed(2)}%)\nSOL: $${precios["SOL-USD"]?.precio?.toFixed(0)} (${precios["SOL-USD"]?.cambio24h_pct?.toFixed(2)}%)\nFear&Greed: ${fearGreed?.valor} (${fearGreed?.clasificacion})\nDominancia BTC: ${globalMarket?.dominancia_btc}%`,
    }],
  });

  const msg = `📡 <b>MERCADO AHORA | CriptoScope</b>\n\n${limpiarDashes(response.content[0].text.trim())}\n\n<i>Análisis educativo · no es consejo financiero</i>`;
  const pid = Date.now().toString(36);
  pendingPublish.set(pid, msg);
  if (portadaFileId) portadas.set(pid, portadaFileId);
  setTimeout(() => { pendingPublish.delete(pid); portadas.delete(pid); }, 30 * 60 * 1000);

  await mostrarBotonesPublicacion(chatId, pid, msg);
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

// /calendario — resumen macro de toda la semana (privado)
async function cmdCalendario(chatId) {
  try {
    const eventos = await getEventosMacro();
    const msg = formatearResumenSemana(eventos);
    await reply(chatId, msg || "📅 No hay eventos macro relevantes esta semana");
  } catch (e) {
    await reply(chatId, `❌ Error obteniendo calendario: ${e.message}`);
  }
}

// /publicar <texto> — publica en X y amplifica al canal de Telegram
// También se activa enviando una foto con caption "/publicar <texto>"
async function cmdPublicar(chatId, texto, photoArray = null) {
  if (!texto?.trim()) {
    return reply(chatId,
      "❓ <b>Uso:</b>\n" +
      "• Escribe <code>/publicar</code> seguido del texto del tweet\n" +
      "• O envía una foto con caption <code>/publicar texto aquí</code>"
    );
  }

  await reply(chatId, "⏳ Preparando publicación...");

  let fotoBuffer = null;
  if (photoArray) {
    try {
      const base64 = await descargarFoto(photoArray);
      fotoBuffer = Buffer.from(base64, "base64");
    } catch (e) {
      console.warn("⚠️ Foto no descargada:", e.message);
    }
  }

  const textoFinal = limpiarDashes(texto.trim());

  pendingManual.set(chatId, { texto: textoFinal, fotoBuffer });
  setTimeout(() => pendingManual.delete(chatId), 30 * 60 * 1000);

  const preview =
    `📝 <b>BORRADOR</b>\n\n${textoFinal}\n\n` +
    (fotoBuffer ? "📎 Con imagen adjunta\n\n" : "") +
    `<i>Se publicará en X y se amplificará al canal de Telegram.</i>`;

  await fetch(`${API()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: preview,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🐦 Solo X",    callback_data: "pub_solo_x" },
            { text: "📢 Solo Canal", callback_data: "pub_solo_canal" },
          ],
          [
            { text: "🔄 X + Canal", callback_data: "pub_ambos" },
            { text: "❌ Cancelar",   callback_data: "pub_manual_no" },
          ],
        ],
      },
    }),
  });
}

// /banner — genera portada para X (1500×500) con datos del día
async function cmdBanner(chatId) {
  await reply(chatId, "🖼 Generando banner para X (1500×500)...");
  try {
    const contexto = await getMarketContext();
    const btc = contexto.precios?.["BTC-USD"];
    const eth = contexto.precios?.["ETH-USD"];
    const fg  = contexto.sentimiento?.fearGreed;
    const gm  = contexto.mercadoGlobal;
    const gl  = contexto.gainersLosers;

    let coins = gl
      ? [
          ...gl.ganadores.map((g) => ({ label: `$${g.simbolo}`, value: parseFloat(g.cambio) })),
          ...gl.perdedores.map((p) => ({ label: `$${p.simbolo}`, value: parseFloat(p.cambio) })),
        ]
      : [];
    const existentes = new Set(coins.map((c) => c.label));
    for (const [id, d] of Object.entries(contexto.precios || {})) {
      const label = `$${id.replace("-USD", "")}`;
      if (!existentes.has(label) && d.cambio24h_pct != null)
        coins.push({ label, value: parseFloat(d.cambio24h_pct.toFixed(2)) });
    }
    const sorted = [...coins].sort((a, b) => b.value - a.value);
    const top    = sorted.slice(0, 4);
    const bottom = sorted.slice(-Math.min(4, Math.max(0, sorted.length - top.length)));
    coins = [...new Map([...top, ...bottom].map((c) => [c.label, c])).values()];

    const buffer = await generarBannerX({ btc, eth, fg, dominancia: gm?.dominancia_btc, coins });

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([buffer], { type: "image/png" }), "banner_x.png");
    form.append(
      "caption",
      "📎 Banner listo (1500×500 px).\n\n" +
      "Para subirlo: X → tu perfil → Editar perfil → icono de cámara en el banner → subir imagen.\n\n" +
      "Actualízalo con /banner cuando los datos del mercado cambien mucho."
    );
    await fetch(`${API()}/sendDocument`, { method: "POST", body: form });
  } catch (e) {
    await reply(chatId, `❌ Error generando banner: ${e.message}`);
  }
}

// /estado — estado del sistema
const BOT_START_TS = Date.now();
async function cmdEstado(chatId) {
  const ahora = new Date();
  const madridHora = ahora.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });

  const nAlertas     = alertasPrecios.filter((a) => a.chatId === chatId).length;
  const nProgramadas = [...programadas.values()].filter((p) => p.chatId === chatId).length;
  const nSenalesPend = senalesPendientes.size;

  // Uptime
  const uptimeSec  = Math.floor((Date.now() - BOT_START_TS) / 1000);
  const uptimeHoras = Math.floor(uptimeSec / 3600);
  const uptimeMin   = Math.floor((uptimeSec % 3600) / 60);
  const uptimeStr   = uptimeHoras > 0 ? `${uptimeHoras}h ${uptimeMin}m` : `${uptimeMin}m`;

  // Próxima señal automática (07/11/15/19)
  const horaNum = parseInt(ahora.toLocaleTimeString("es-ES", { hour: "2-digit", timeZone: "Europe/Madrid" }));
  const slots = [7, 11, 15, 19];
  const proxSlot = slots.find((h) => h > horaNum) ?? slots[0];
  const esMañana = proxSlot <= horaNum;

  // Stats semana (rápido, sin bloquear)
  const stats = await generarEstadisticasSemana().catch(() => null);
  const statsStr = stats?.total
    ? `📊 Señales semana: ${stats.total}  ·  Win rate <b>${stats.winrate}%</b>  ·  Pendientes: ${stats.pendientes}`
    : `📊 Sin señales registradas esta semana.`;

  const msg =
    `⚙️ <b>Estado CriptoScope</b>\n\n` +
    `🕐 Madrid: <b>${madridHora}</b>  ·  Uptime: <b>${uptimeStr}</b>\n` +
    `${pausado ? "⏸ Publicaciones: <b>PAUSADAS</b>" : "▶️ Publicaciones: <b>ACTIVAS</b>"}\n` +
    `🔔 Alertas precio activas: <b>${nAlertas}</b>\n` +
    `⏰ Publicaciones programadas: <b>${nProgramadas}</b>\n` +
    `📡 Señales en revisión: <b>${nSenalesPend}</b>\n\n` +
    statsStr + `\n\n` +
    `<b>Automático:</b>\n` +
    `☕ Briefing: 07:00 diario → Telegram + X\n` +
    `📅 Macro semana: lunes 08:00 → canal\n` +
    `📊 Señales (7 monedas) → privado para revisión:\n` +
    `   🌅 07:00  📈 11:00  ⚡ 15:00  🌙 19:00\n` +
    `   Próxima: <b>${proxSlot}:00${esMañana ? " (mañana)" : ""}</b>\n` +
    `📅 Resumen semanal: domingos 09:00\n` +
    `🚨 Monitor eventos: cada 30 min\n` +
    `🔔 Alertas precio: cada 5 min\n` +
    `📰 Monitor RSS: cada 15 min\n` +
    `📝 Editorial: lun 16:30 · mar 10:00 · mié 12:00 · sáb 11:00 · dom 18:00\n` +
    `🌙 Recap diario: 22:00\n\n` +
    `<b>Publicación manual:</b>\n` +
    `<code>/flash</code> · <code>/hilo</code> · <code>/analiza</code> · <code>/opinion</code>\n` +
    `<code>/encuesta</code> · <code>/semanal</code> · <code>/publicar</code> · <code>/banner</code>\n\n` +
    `<b>Consulta privada:</b>\n` +
    `<code>/precio</code> · <code>/quepasa</code> · <code>/senal</code> · <code>/calendario</code>\n` +
    `<code>/stats</code> · <code>/historial</code>\n\n` +
    `<b>Alertas y programadas:</b>\n` +
    `<code>/alerta</code> · <code>/alertas</code> · <code>/borralalerta</code>\n` +
    `<code>/programar</code> · <code>/programadas</code> · <code>/cancelar</code>\n\n` +
    `<b>Sistema:</b>\n` +
    `<code>/pausa</code> · <code>/activa</code> · <code>/cancelar_editorial</code>\n` +
    `<code>/estado</code> · <code>/ayuda</code>\n\n` +
    `<i>📒 Notion: Publicaciones · Señales · Briefings</i>\n` +
    `🔗 Webhook TradingView: activo\n` +
    (process.env.X_PROFILE_URL ? `🐦 <a href="${process.env.X_PROFILE_URL}">${process.env.X_PROFILE_URL.replace("https://x.com/", "@")}</a>` : "");
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

// Descarga imagen de Telegram y devuelve base64
async function descargarFoto(photo) {
  const fileId = photo[photo.length - 1].file_id;
  const fileInfo = await fetch(`${API()}/getFile?file_id=${fileId}`).then((r) => r.json());
  const filePath = fileInfo.result?.file_path;
  if (!filePath) throw new Error("No se pudo obtener el archivo de Telegram");
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const imgRes = await fetch(fileUrl);
  const imgBuffer = await imgRes.arrayBuffer();
  return Buffer.from(imgBuffer).toString("base64");
}

// Detectar si el caption indica modo "responder comentario"
function esModoRespuesta(caption) {
  const palabras = ["responde", "respóndeme", "replica", "contesta", "reply", "contestar", "respuesta"];
  const c = (caption || "").toLowerCase();
  return palabras.some((p) => c.includes(p));
}

// Foto con noticia → verificar credibilidad y generar opinión
async function cmdFoto(chatId, photo, caption) {

  // MODO PUBLICAR MANUAL — foto + caption "/publicar texto"
  if ((caption || "").trimStart().toLowerCase().startsWith("/publicar")) {
    const texto = caption.replace(/^\/publicar\s*/i, "").trim();
    await cmdPublicar(chatId, texto, photo);
    return;
  }

  // MODO RESPUESTA A COMENTARIO
  if (esModoRespuesta(caption)) {
    await cmdRespondeComentario(chatId, photo, caption);
    return;
  }

  await reply(chatId, "👁 Leyendo la imagen...");

  try {
    const base64 = await descargarFoto(photo);
    await reply(chatId, "🔍 Verificando credibilidad...");

    const precios = await getPrices().catch(() => ({}));
    const ctxPrecio = `BTC $${precios["BTC-USD"]?.precio?.toFixed(0) || "?"} · ETH $${precios["ETH-USD"]?.precio?.toFixed(0) || "?"}`;

    // PASO 1: Claude verifica credibilidad
    const verificacion = await client.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 600,
      system: `Eres un fact-checker experto en cripto y mercados. Analiza la imagen y evalúa la credibilidad de la noticia. Devuelve SOLO este JSON sin markdown:
{"titular":"titular exacto de la imagen","fuente":"fuente visible o 'desconocida'","veredicto":"VERIFICADA|PROBABLE|DUDOSA|FALSA","confianza":0-100,"razon":"1 frase explicando el veredicto","señales_alarma":["lista","de","señales"] o []}`,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: "Evalúa la credibilidad de esta noticia." },
        ],
      }],
    });

    let check;
    try {
      const txt = verificacion.content[0].text;
      check = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    } catch {
      check = { titular: "Sin titular", fuente: "desconocida", veredicto: "DUDOSA", confianza: 50, razon: "No se pudo verificar", señales_alarma: [] };
    }

    // Emoji y color según veredicto
    const veredictoEmoji = { VERIFICADA: "✅", PROBABLE: "🟡", DUDOSA: "⚠️", FALSA: "🚫" }[check.veredicto] || "⚠️";
    const bloqueCheck =
      `${veredictoEmoji} <b>Verificación: ${check.veredicto}</b> (confianza ${check.confianza}%)\n` +
      `Fuente: ${check.fuente}\n` +
      `${check.razon}` +
      (check.señales_alarma?.length ? `\n⚠️ Señales: ${check.señales_alarma.join(" · ")}` : "");

    // Si es FALSA, avisar y no ofrecer publicar
    if (check.veredicto === "FALSA") {
      await reply(chatId,
        `🚫 <b>Noticia probablemente FALSA</b>\n\n${bloqueCheck}\n\n` +
        `<i>No se recomienda publicar esta información.</i>`
      );
      return;
    }

    await reply(chatId, "🧠 Generando análisis...");

    // PASO 2: Claude genera opinión
    const respuesta = await client.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 900,
      system: `Eres CriptoScope. Analiza la noticia de la imagen con perspectiva de trader: qué significa para el mercado, cómo puede mover el precio, qué nivel vigilarías.

REGLA DE APERTURA: Abre con la conclusión de la noticia de la imagen, no con el precio de BTC. El precio de mercado es contexto de fondo, no el gancho de apertura.
Voz directa y fría. 2-3 párrafos. HTML Telegram (<b>, <i>). Distingue entre lo que dice la noticia y lo que podría implicar. Si hay incertidumbre, nómbrala.
PROHIBIDO: guiones medios o largos (– o —), 🚀💎🙌, clickbait, consejos financieros directos.`,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: `Contexto mercado: ${ctxPrecio}${caption ? `\nNota: ${caption}` : ""}` },
        ],
      }],
    });

    const opinion = limpiarDashes(respuesta.content[0].text.trim());

    // Fuente: usar la detectada por Claude, o "desconocida"
    const fuenteConocida = check.fuente && check.fuente.toLowerCase() !== "desconocida";
    const lineaFuente = fuenteConocida
      ? `\n\n📌 <i>Fuente: ${check.fuente}</i>`
      : "";

    // Mensaje limpio para publicar — SIN el bloque de verificación interna, CON fuente
    const msgPublicar = `🧠 <b>ANÁLISIS | CriptoScope</b>\n\n${opinion}${lineaFuente}\n\n<i>Análisis educativo · no es consejo financiero</i>`;

    // Mensaje completo para mostrarte a ti — CON verificación (solo para tu revisión)
    const msgPreview = `🧠 <b>ANÁLISIS | CriptoScope</b>\n\n${bloqueCheck}\n\n──────────────\n${opinion}${lineaFuente}\n\n<i>Análisis educativo · no es consejo financiero</i>`;

    // Guardar solo el mensaje limpio para publicar
    const pid = Date.now().toString(36);
    pendingPublish.set(pid, msgPublicar);
    setTimeout(() => pendingPublish.delete(pid), 30 * 60 * 1000);

    let advertencia = check.veredicto === "DUDOSA"
      ? "\n\n⚠️ <i>Credibilidad dudosa — revisa la fuente antes de publicar.</i>"
      : "";
    if (!fuenteConocida) {
      advertencia += "\n\n📌 <i>Fuente no detectada — se publicará sin atribución. Puedes añadirla respondiendo al mensaje si quieres.</i>";
    }

    await mostrarBotonesPublicacion(chatId, pid, msgPreview + advertencia);
  } catch (e) {
    await reply(chatId, `❌ Error analizando la imagen: ${e.message}`);
  }
}

// Foto con comentario → Claude redacta una respuesta en privado
async function cmdRespondeComentario(chatId, photo, caption) {
  await reply(chatId, "💬 Leyendo el comentario...");

  try {
    const base64 = await descargarFoto(photo);
    await reply(chatId, "🧠 Redactando respuesta...");

    const respuesta = await client.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 600,
      system: `Eres CriptoScope. Te mandan una captura de un comentario o mensaje de redes sociales. Redacta una respuesta en la voz de CriptoScope: directa, educada pero firme, con conocimiento de mercados. Sin hype, sin insultos, argumentada. Máx 3 frases. Solo texto plano, sin HTML.`,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: caption?.replace(/responde|respóndeme|replica|contesta|reply|contestar|respuesta/gi, "").trim() || "Redacta una respuesta a este comentario." },
        ],
      }],
    });

    const respuestaTexto = respuesta.content[0].text.trim();
    await reply(chatId,
      `💬 <b>Propuesta de respuesta</b>\n\n<i>${respuestaTexto}</i>\n\n` +
      `<i>Solo para ti · cópiala y pégala donde quieras</i>`
    );
  } catch (e) {
    await reply(chatId, `❌ Error: ${e.message}`);
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

  if (data === "pub_manual_no") {
    pendingManual.delete(chatId);
    await fetch(`${API()}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
    await reply(chatId, "❌ Publicación cancelada.");
    return;
  }

  if (data === "pub_solo_x" || data === "pub_solo_canal" || data === "pub_ambos") {
    const pending = pendingManual.get(chatId);
    pendingManual.delete(chatId);
    await fetch(`${API()}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
    if (!pending) return reply(chatId, "⚠️ La publicación expiró. Vuelve a usar /publicar.");
    await reply(chatId, "📤 Publicando...");
    try {
      const enX      = data === "pub_solo_x"    || data === "pub_ambos";
      const enCanal  = data === "pub_solo_canal" || data === "pub_ambos";
      const resultados = [];

      if (enX) {
        let mediaId = null;
        if (pending.fotoBuffer) mediaId = await subirImagenX(pending.fotoBuffer).catch(() => null);
        await publicarTweetUnico(pending.texto, mediaId ? { mediaId } : {});
        resultados.push("🐦 X");
      }
      if (enCanal) {
        if (pending.fotoBuffer) {
          await enviarTelegramConFoto(pending.texto, pending.fotoBuffer);
        } else {
          await enviarTelegram(pending.texto);
        }
        resultados.push("📢 Canal Telegram");
      }
      await reply(chatId, `✅ Publicado en ${resultados.join(" + ")}.`);
    } catch (e) {
      await reply(chatId, `❌ Error publicando: ${e.message}`);
    }
    return;
  }

  // Helper para quitar botones del mensaje
  const quitarBotones = () => fetch(`${API()}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  });

  // Añadir portada → pedir foto al usuario
  if (data.startsWith("add_portada:")) {
    const pid = data.slice(12);
    if (!pendingPublish.has(pid)) return reply(chatId, "❌ El contenido ya expiró. Vuelve a generarlo.");
    await quitarBotones();
    waitingCover.set(chatId, pid);
    await reply(chatId, "📸 Mándame la foto que quieres usar como portada.");
    return;
  }

  // Genera hashtags relevantes para el post (máx 5, siempre en español primero)
  const extraerHashtags = (texto) => {
    const base = ["#Bitcoin", "#Cripto"]; // siempre presentes

    const monedas = [
      ["#BTC",      ["BTC", "Bitcoin"]],
      ["#Ethereum", ["ETH", "Ethereum"]],
      ["#Solana",   ["SOL", "Solana"]],
      ["#XRP",      ["XRP", "Ripple"]],
      ["#BNB",      ["BNB", "Binance"]],
      ["#DOGE",     ["DOGE", "Dogecoin"]],
      ["#AVAX",     ["AVAX", "Avalanche"]],
      ["#SUI",      ["SUI"]],
      ["#TON",      ["TON", "Toncoin"]],
      ["#Cardano",  ["ADA", "Cardano"]],
    ];
    const macro = [
      ["#Fed",      ["Fed ", "FOMC", "Powell", "Federal Reserve"]],
      ["#CPI",      ["CPI", "IPC", "inflación", "inflacion"]],
      ["#ETF",      ["ETF", "spot ETF"]],
      ["#Macro",    ["macro", "NFP", "empleo", "PIB", "GDP"]],
    ];

    const tags = [...base];
    for (const [tag, keywords] of [...monedas, ...macro]) {
      if (tags.length >= 5) break;
      if (keywords.some((k) => texto.includes(k)) && !tags.includes(tag)) tags.push(tag);
    }
    return tags.join(" ");
  };

  // Descarga portada de Telegram y la sube a X; devuelve mediaId o null
  const subirPortadaAX = async (fileId) => {
    try {
      const fileRes = await fetch(`${API()}/getFile?file_id=${fileId}`);
      const fileJson = await fileRes.json();
      if (!fileJson.ok) return null;
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileJson.result.file_path}`;
      const imgRes = await fetch(fileUrl);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const bufferConLogo = await aplicarLogo(buffer);
      return await subirImagenX(bufferConLogo, "image/png");
    } catch (e) {
      console.warn("⚠️ No se pudo subir portada a X:", e.message);
      return null;
    }
  };

  // Genera UN tweet para X — aprovecha los 270-280 chars al máximo con el ángulo más potente
  // Si el input es un titular corto (<160 chars), usa prompt de interpretación de noticia
  const generarTweetX = async (texto) => {
    const limpio = texto.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    const esTitulo = limpio.length < 160;
    const derivados = await getContextoDerivadosBTC().catch(() => null);
    const ctxDerivados = derivados?.resumen
      ? `\n\nContexto de derivados live: ${derivados.resumen}\nSi es relevante al contenido, úsalo para enriquecer el tweet (no lo cites literalmente).`
      : "";
    const prompt = esTitulo
      ? `Eres analista de X de CriptoScope (cripto en español).

Titular de noticia: "${limpio}"

Escribe UN tweet de 230-255 caracteres. NO resumas la noticia: interpreta qué SIGNIFICA para el mercado. Qué puede mover el precio, qué paradoja hay, o qué riesgo oculto implica. Si hay un número concreto en el titular, úsalo.

1 emoji relevante al inicio (🚨⚠️🔴🟢💥🎯). Termina con una pregunta directa a la comunidad o una afirmación que invite al debate.

Sin HTML. Sin guiones largos (– o —). Sin links. Sin hashtags. Sin mencionar "canal de Telegram".
Devuelve SOLO el tweet. Sin comillas ni etiquetas.${ctxDerivados}`
      : `Eres el redactor de X/Twitter de CriptoScope, análisis cripto en español.

Contenido del análisis:
${limpio.slice(0, 2000)}

Escribe UN único tweet de 260-278 caracteres. No es un resumen: elige el ángulo MÁS POTENTE del análisis y desarróllalo completamente. Aprovecha cada carácter.

Estructura (todo en un bloque continuo con salto de línea en el medio):
— GANCHO (90-110 chars): el dato más impactante, la paradoja o el hecho que crea tensión. Para el scroll. NO empieces con "Hoy", "El mercado", el nombre de la coin ni "CriptoScope". 1 emoji si refuerza (🚨📊⚠️🔴🟢).
— DESARROLLO (160-170 chars): qué implica ese dato para el precio, qué patrón hay detrás, nivel clave a vigilar. Datos concretos. Termina con una pregunta corta a la comunidad O con una afirmación que invite a debatir.

Sin HTML. Sin guiones largos (– o —). Sin links. Sin hashtags. Sin mencionar "canal de Telegram".

Devuelve SOLO el tweet. Sin comillas, sin etiquetas, sin explicaciones.${ctxDerivados}`;
    try {
      const res = await client.messages.create({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      });
      const tweet = limpiarDashes(res.content[0].text.trim());
      return tweet.length <= 280 ? tweet : tweet.slice(0, 277).replace(/\s+\S*$/, "...");
    } catch {
      const lineas = limpio.split("\n").filter((l) => l.length > 30 && /[a-záéíóúñ]/.test(l) && !["CriptoScope", "consejo financiero", "FLASH", "ALERTA"].some((e) => l.toUpperCase().includes(e)));
      const fb = lineas[0] || limpio;
      return fb.length <= 280 ? fb : fb.slice(0, 277).replace(/\s+\S*$/, "...");
    }
  };

  // Helper para publicar según destino
  const publicarPorDestino = async (pid, destino) => {
    const msg = pendingPublish.get(pid);
    if (!msg) return reply(chatId, "❌ El contenido ya expiró (>30 min). Vuelve a generarlo.");
    await quitarBotones();
    const fileId = portadas.get(pid) || null;

    let errorX = null;
    let errorCanal = null;

    if (destino === "canal" || destino === "ambos") {
      try {
        await publicarCanal(msg, fileId);
      } catch (e) {
        errorCanal = e.message;
        console.warn("⚠️ Error publicando en canal:", e.message);
        await reply(chatId, `⚠️ Error al publicar en canal: <code>${e.message}</code>`);
        return;
      }
    }
    if (destino === "x" || destino === "ambos") {
      const mediaId = fileId ? await subirPortadaAX(fileId) : null;
      const hashtags = extraerHashtags(msg);
      try {
        if (hilosPendientes.has(pid)) {
          // /hilo: thread educativo real en X
          const tweetsX = hilosPendientes.get(pid).map((t) => t.trim());
          tweetsX[tweetsX.length - 1] += `\n\n${hashtags}`;
          await publicarThread(tweetsX, { mediaId });
        } else {
          // Flash, opinión, analiza, quepasa: un único tweet maximizado
          const contenido = await generarTweetX(msg);
          await publicarTweetUnico(contenido, { mediaId });
        }
      } catch (e) {
        const detalle = e?.data ? ` (${JSON.stringify(e.data)})` : "";
        errorX = `${e.message}${detalle}`;
        console.warn("⚠️ Error X desde bot:", errorX);
      }
    }

    pendingPublish.delete(pid);
    portadas.delete(pid);
    hilosPendientes.delete(pid);

    // Registrar en Notion
    const detectarTipo = (t) => {
      if (/FLASH/i.test(t))   return "Flash";
      if (/HILO/i.test(t))    return "Hilo";
      if (/ANÁLISIS|ANALISIS|On-Demand/i.test(t)) return "Análisis";
      if (/OPINIÓN|OPINION/i.test(t)) return "Opinión";
      if (/SEMANAL/i.test(t)) return "Semanal";
      return "Otro";
    };
    const extraerTitulo = (t) => t.replace(/<[^>]+>/g, "").split("\n").find((l) => l.trim().length > 5) || "Sin título";
    const plataformaNotion = errorX && destino === "x" ? "X" : errorX && destino === "ambos" ? "Canal" : destino === "ambos" ? "Canal+X" : destino === "canal" ? "Canal" : "X";
    const estadoNotion = errorCanal ? "Error canal" : errorX ? "Error X" : "Publicado";
    guardarPublicacionEnNotion({
      tipo:       detectarTipo(msg),
      titulo:     extraerTitulo(msg),
      texto:      msg,
      plataforma: plataformaNotion,
      conPortada: !!portadas.get(pid) || false,
      estado:     estadoNotion,
    }).catch(() => {});

    const donde = destino === "ambos" ? "en el canal y en X" : destino === "canal" ? "en el canal" : "en X";
    if (errorX) {
      const canalParte = (destino === "ambos") ? "✅ Publicado en el canal.\n" : "";
      let consejo = "";
      if (/401|unauthorized|credentials/i.test(errorX)) {
        consejo = "\n\n<b>Solución:</b> En developer.twitter.com → tu app → permisos deben ser <b>Read and Write</b>. Luego regenera Access Token + Secret y actualiza las variables en Railway.";
      } else if (/403|forbidden/i.test(errorX)) {
        consejo = "\n\n<b>Solución:</b> La app no tiene permiso de escritura. Ve a developer.twitter.com → tu app → User authentication settings → activa Read and Write.";
      } else if (/429|rate/i.test(errorX)) {
        consejo = "\n\n<b>Solución:</b> Límite de la API alcanzado. Espera unos minutos antes de intentarlo.";
      }
      await reply(chatId, `${canalParte}⚠️ X falló: <code>${errorX}</code>${consejo}`);
    } else {
      await reply(chatId, `✅ Publicado ${donde}.`);
    }
  };

  if (data.startsWith("pub_ambos:") || data.startsWith("pub:")) {
    const pid = data.startsWith("pub:") ? data.slice(4) : data.slice(10);
    await publicarPorDestino(pid, "ambos");
  }

  if (data.startsWith("pub_canal:")) {
    await publicarPorDestino(data.slice(10), "canal");
  }

  if (data.startsWith("pub_x:")) {
    await publicarPorDestino(data.slice(6), "x");
  }

  if (data.startsWith("enc:")) {
    const pid = data.slice(4);
    const enc = pendingPublish.get(pid);
    if (!enc) return reply(chatId, "❌ La encuesta ya expiró (>30 min). Vuelve a ejecutar /encuesta.");

    await fetch(`${API()}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });

    const pollRes = await fetch(`${API()}/sendPoll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        question: enc.pregunta,
        options: enc.opciones.map((text) => ({ text })),
        is_anonymous: true,
      }),
    });
    const pollData = await pollRes.json();
    pendingPublish.delete(pid);

    if (pollData.ok) {
      await reply(chatId, "✅ Encuesta enviada al canal.");
    } else {
      await reply(chatId, `❌ Error al enviar encuesta: ${pollData.description}`);
    }
  }

  if (data.startsWith("news_flash:")) {
    const nid = data.slice(11);
    const cached = noticiasCache.get(nid);
    const titulo = cached?.titulo || nid;
    await fetch(`${API()}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
    await cmdFlash(chatId, titulo);
  }

  if (data.startsWith("news_hilo:")) {
    const nid = data.slice(10);
    const cached = noticiasCache.get(nid);
    const titulo = cached?.titulo || nid;
    await fetch(`${API()}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
    await cmdHilo(chatId, titulo);
  }

  if (data.startsWith("news_tweet:")) {
    const nid = data.slice(11);
    const cached = noticiasCache.get(nid);
    const titulo = cached?.titulo || nid;
    await quitarBotones();

    if (!process.env.X_API_KEY) {
      return reply(chatId, "❌ X no configurado. Añade X_API_KEY en Railway.");
    }

    await reply(chatId, "🐦 Generando tweet para X...");

    // Auto-imagen: gráfico BTC 4H como contexto visual para el tweet de noticia
    let mediaId = null;
    try {
      const velas = await getVelas("BTCUSDT", "4h", 30);
      const slice = velas.slice(-30);
      const ema20s = calcEMA(slice, 20);
      const ema50s = calcEMA(slice, 50);
      const chartConfig = buildChartConfig("BTC", slice, ema20s, ema50s, "4H");
      const buf = await fetchGraficoBuffer(chartConfig);
      if (buf) mediaId = await subirImagenX(await aplicarLogo(buf), "image/png");
    } catch (e) { console.warn("⚠️ Auto-imagen BTC en news_tweet:", e.message); }

    const tweetFinal = await generarTweetX(titulo);

    try {
      await publicarTweetUnico(tweetFinal, { mediaId });
      guardarPublicacionEnNotion({
        tipo: "Flash",
        titulo,
        texto: tweetFinal,
        plataforma: "X",
        conPortada: !!mediaId,
        estado: "Publicado",
      }).catch(() => {});
      await reply(chatId, `✅ Tweet publicado en X${mediaId ? " (con gráfico BTC 4H)" : ""}:\n\n<code>${tweetFinal.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`);
    } catch (e) {
      guardarPublicacionEnNotion({
        tipo: "Flash",
        titulo,
        texto: tweetFinal,
        plataforma: "X",
        conPortada: false,
        estado: "Error X",
      }).catch(() => {});
      await reply(chatId, `❌ Error al publicar en X: ${e.message}\n\nTweet generado:\n<code>${tweetFinal.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`);
    }
  }

  if (data.startsWith("enc_re:")) {
    const tema = data.slice(7);
    await fetch(`${API()}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
    await cmdEncuesta(chatId, tema || "");
  }

  if (data.startsWith("pub_bs:") || data.startsWith("pub_cmc:")) {
    const isCmc = data.startsWith("pub_cmc:");
    const pid = isCmc ? data.slice(8) : data.slice(7);
    const msg = pendingPublish.get(pid);
    if (!msg) return reply(chatId, "❌ El contenido ya expiró (>30 min). Vuelve a generarlo.");

    const limpio = msg
      .replace(/<b>(.*?)<\/b>/gs, "**$1**")
      .replace(/<i>(.*?)<\/i>/gs, "_$1_")
      .replace(/<code>(.*?)<\/code>/gs, "`$1`")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();

    const plataforma = isCmc ? "CMC Community" : "Binance Square";
    const icono = isCmc ? "📊" : "🟡";
    const tipo = /FLASH/i.test(msg) ? "Flash" : /HILO/i.test(msg) ? "Hilo" : /ANÁLISIS|ANALISIS|On-Demand/i.test(msg) ? "Análisis" : "Otro";
    const titulo = msg.replace(/<[^>]+>/g, "").split("\n").find((l) => l.trim().length > 5) || "Sin título";

    await reply(chatId,
      `${icono} <b>Texto listo para ${plataforma}</b>\n\nCópialo y pégalo directamente:\n\n` +
      `<code>${limpio.replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 3500)}</code>`
    );

    guardarPublicacionEnNotion({ tipo, titulo, texto: msg, plataforma, conPortada: !!portadas.get(pid), estado: "Formateado" }).catch(() => {});
  }

  if (data.startsWith("pub_senal:")) {
    const pid = data.slice(10);
    const msg = senalesPendientes.get(pid);
    if (!msg) return reply(chatId, "❌ La señal ya expiró (>90 min) o ya fue publicada.");
    await quitarBotones();
    senalesPendientes.delete(pid);
    await enviarTelegram(msg);

    let xPublicado = false;
    if (process.env.X_API_KEY) {
      try {
        const tweet = await generarTweetDeSenal(msg);
        await publicarTweetUnico(tweet);
        xPublicado = true;
      } catch (e) {
        console.warn("⚠️ Error publicando señal en X:", e.message);
      }
    }

    await reply(chatId, xPublicado ? "✅ Señal publicada en el canal y en X." : "✅ Señal publicada en el canal.");
    guardarPublicacionEnNotion({ tipo: "Señal", titulo: "Señal técnica automática", texto: msg, plataforma: xPublicado ? "Canal+X" : "Canal", estado: "Publicado" }).catch(() => {});
  }

  if (data.startsWith("del_senal:")) {
    const pid = data.slice(10);
    senalesPendientes.delete(pid);
    await quitarBotones();
    await reply(chatId, "🗑 Señal descartada.");
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
        "Genera una alerta de alto impacto sobre lo que le indiques. Claude analiza el tema, lo cruza con el precio actual de BTC/ETH y el Fear&Greed Index, y redacta un mensaje en la voz de CriptoScope.\n\n" +
        "Antes de publicar, te muestra una preview con cuatro botones:\n" +
        "📢 <b>Canal + X</b> — publica en Telegram y en X con hashtags automáticos\n" +
        "📣 <b>Solo canal</b> — solo Telegram\n" +
        "🐦 <b>Solo X</b> — solo Twitter/X\n" +
        "📸 <b>Añadir portada</b> — manda una foto y se adjunta integrada en la publicación\n" +
        "❌ <b>Descartar</b> — lo borra sin publicar\n\n" +
        "También puedes mandar la foto junto con el comando como adjunto: la foto queda guardada automáticamente como portada.",
    },
    hilo: {
      titulo: "📝 /hilo — Thread educativo",
      uso: "/hilo <tema o URL>",
      ejemplo: "/hilo qué es el halving · /hilo cómo funciona el funding rate · /hilo https://coindesk.com/...",
      detalle:
        "Genera un hilo educativo de 5 tweets sobre el tema que indiques. Si le pasas una URL, descarga el artículo real y basa el hilo en su contenido.\n\n" +
        "Cada tweet es autónomo: funciona aunque el lector entre por el tweet 3. Gancho en el primero, un punto concreto por tweet, regla práctica en el último.\n\n" +
        "En el canal se publica el hilo completo como un solo mensaje. En X se publica como thread real encadenado (5 tweets + CTA). Los hashtags de monedas mencionadas se añaden al último tweet automáticamente. Admite portada.",
    },
    analiza: {
      titulo: "📊 /analiza — Análisis técnico on-demand",
      uso: "/analiza <símbolo>",
      ejemplo: "/analiza AVAX · /analiza DOGE · /analiza LINK · /analiza BTC",
      detalle:
        "Ejecuta un análisis técnico completo top-down sobre cualquier coin. Descarga velas reales de 1D + 4H + 1H + 15m desde OKX, calcula RSI 14, MACD 12/26/9, EMA 20/50 y niveles pivot, y genera una señal con Claude.\n\n" +
        "Devuelve: sesgo de mercado, operación (LONG/SHORT/ESPERAR), entrada, TP1, TP2, SL y ratio R:R.\n\n" +
        "Adjunta automáticamente un <b>gráfico de velas 4H con EMA20 y EMA50</b> (últimas 30 velas, 5 días) antes de la preview.\n\n" +
        "Botones de publicación: Canal / X / ambos / Binance Square / CMC Community. El tweet de X lo genera Claude con formato nativo.",
    },
    opinion: {
      titulo: "🧠 /opinion — CriptoScope opina",
      uso: "/opinion <noticia o hecho>",
      ejemplo: "/opinion Ethereum ETF aprobado en Europa · /opinion China legaliza Bitcoin",
      detalle:
        "Le das una noticia y CriptoScope la analiza como trader: qué significa para el mercado, qué haría el precio a corto y medio plazo, y qué vigilarías. Sin hype, sin titulares vacíos.\n\n" +
        "Igual que /flash, te muestra una preview con botones para elegir dónde publicar (canal, X o ambos) y añadir portada antes de confirmar.",
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
        "Muestra botones para publicar en canal o en X, igual que /flash o /hilo. También puedes añadir portada.\n\n" +
        "📸 <b>Con portada:</b> manda una foto con <code>/quepasa</code> en el pie.",
    },
    senal: {
      titulo: "🔒 /senal — Señal técnica privada",
      uso: "/senal <coin>",
      ejemplo: "/senal ETH · /senal BTC · /senal SOL",
      detalle:
        "Igual que /analiza pero solo para ti — no publica nada en el canal. Descarga datos reales, calcula todos los indicadores y te devuelve la señal en privado.\n\n" +
        "El sistema automático publica 4 análisis al día con ángulos distintos:\n" +
        "🌅 07:00 Radar de apertura — sesgo del día y nivel clave en 4H\n" +
        "📈 11:00 Pulso técnico — momentum 1H, RSI y MACD actualizados\n" +
        "⚡ 15:00 On-chain y derivados — funding rate, OI y posicionamiento\n" +
        "🌙 19:00 Cierre europeo — balance del día y nivel asiático a vigilar\n\n" +
        "/senal te da la misma profundidad en cualquier momento bajo demanda.",
    },
    calendario: {
      titulo: "📅 /calendario — Eventos macro",
      uso: "/calendario",
      ejemplo: "/calendario",
      detalle:
        "Muestra los eventos macroeconómicos de alto impacto de <b>toda la semana</b>: Fed, CPI, NFP, FOMC, datos de empleo... agrupados por día, con hora exacta en ET.\n\n" +
        "Datos de ForexFactory JSON (alta precisión). El bot incluye los eventos del día en el briefing matinal, y cada <b>lunes a las 08:00</b> publica automáticamente el resumen completo de la semana en el canal.\n\n" +
        "Útil antes de abrir posiciones para saber si hay riesgo de volatilidad macro.",
    },
    estado: {
      titulo: "⚙️ /estado — Estado del sistema",
      uso: "/estado",
      ejemplo: "/estado",
      detalle:
        "Te muestra el estado completo: hora de Madrid, publicaciones activas/pausadas, alertas activas, publicaciones programadas y próximos automáticos.\n\n" +
        "Automáticos diarios:\n" +
        "☕ 07:00 Briefing matinal → canal + X\n" +
        "📅 Lunes 08:00 Macro semana → canal\n" +
        "🌅 07:00 Radar de apertura — sesgo del día (4H)\n" +
        "📈 11:00 Pulso técnico — momentum 1H\n" +
        "⚡ 15:00 On-chain y derivados — funding y OI\n" +
        "🌙 19:00 Cierre europeo — balance + sesión asiática\n" +
        "📅 Domingos 09:00 Resumen semanal\n\n" +
        "Todo queda registrado automáticamente en Notion (Publicaciones · Señales · Briefings).",
    },
    pausa: {
      titulo: "⏸ /pausa y /activa — Control de publicaciones",
      uso: "/pausa · /activa",
      ejemplo: "/pausa (para detener) · /activa (para reanudar)",
      detalle:
        "Con /pausa detienes todas las publicaciones automáticas del canal: briefing matinal, señales técnicas, resumen semanal y alertas de evento. El bot sigue respondiendo tus comandos privados con normalidad.\n\n" +
        "Con /activa las reanudas. Útil si vas a publicar contenido manual durante un evento especial y no quieres que el bot interfiera, o si estás de vacaciones.",
    },
    alerta: {
      titulo: "🔔 /alerta — Alerta de precio",
      uso: "/alerta <coin> <precio>",
      ejemplo: "/alerta BTC 70000 · /alerta ETH <1800 · /alerta SOL >200",
      detalle:
        "Te avisa en privado cuando una coin llega a un nivel de precio.\n\n" +
        "Sin símbolo de dirección: el bot detecta si el precio está por encima o por debajo y pone la alerta en el sentido correcto.\n" +
        "Con <code>&lt;</code>: avisa cuando baje de ese nivel. Con <code>&gt;</code>: avisa cuando suba.\n\n" +
        "Las alertas se guardan en disco — sobreviven reinicios del servidor. Solo suenan una vez y se eliminan automáticamente.\n\n" +
        "Comandos relacionados:\n" +
        "<code>/alertas</code> — ver tus alertas activas\n" +
        "<code>/borralalerta 1</code> — eliminar la alerta número 1",
    },
    programar: {
      titulo: "⏰ /programar — Programar publicación",
      uso: "/programar <tipo> <HH:MM> <contenido>",
      ejemplo: "/programar flash 18:00 BlackRock compra BTC · /programar hilo 09:30 qué es el halving",
      detalle:
        "Programa un flash, hilo u opinión para que se publique automáticamente a una hora concreta (horario Madrid).\n\n" +
        "Si la hora ya pasó hoy, se programa para mañana a esa misma hora.\n\n" +
        "Tipos válidos: <code>flash</code> · <code>hilo</code> · <code>opinion</code>\n\n" +
        "Comandos relacionados:\n" +
        "<code>/programadas</code> — lista de publicaciones pendientes\n" +
        "<code>/cancelar 1</code> — cancela la publicación con ID 1\n\n" +
        "⚠️ Las programadas viven en memoria — si el servidor se reinicia se pierden.",
    },
    semanal: {
      titulo: "📊 /semanal — Resumen semanal bajo demanda",
      uso: "/semanal",
      ejemplo: "/semanal",
      detalle:
        "Genera el resumen semanal ahora mismo, sin esperar al domingo. Analiza los movimientos de la semana, los mejores y peores activos, el Fear&Greed y las estadísticas de señales.\n\n" +
        "Te muestra una preview con botones para publicar en canal, en X o en ambos. Puedes añadir portada antes de publicar.\n\n" +
        "Útil si quieres publicar el resumen en un momento concreto (por ejemplo, el viernes por la tarde o tras un evento importante de la semana).",
    },
    encuesta: {
      titulo: "🗳 /encuesta — Encuesta para el canal",
      uso: "/encuesta [tema opcional]",
      ejemplo: "/encuesta · /encuesta ¿Dónde estará BTC el viernes? · /encuesta altcoins",
      detalle:
        "Claude revisa el precio actual, el Fear&Greed Index y el contexto del mercado, y genera una encuesta relevante para publicar en el canal.\n\n" +
        "Puedes usarlo sin argumentos para que elija el tema del día, o pasarle un tema concreto: '/encuesta ETH merge aniversario', '/encuesta próximo halving'.\n\n" +
        "El bot te muestra una preview con la pregunta y las opciones. Tienes tres botones:\n" +
        "✅ <b>Enviar al canal</b> — publica la encuesta nativa de Telegram\n" +
        "🔄 <b>Regenerar</b> — genera otra diferente sobre el mismo tema\n" +
        "❌ <b>Cancelar</b> — descártala sin publicar\n\n" +
        "Las encuestas son anónimas por defecto. La comunidad vota directamente en el canal.",
    },
    foto: {
      titulo: "📸 Foto de noticia — Análisis con verificación",
      uso: "Manda una foto directamente al bot (sin comando)",
      ejemplo: "Captura de pantalla de CoinDesk, Twitter, Telegram... cualquier noticia",
      detalle:
        "Manda una captura de pantalla de una noticia al bot sin ningún comando. Claude hace dos cosas:\n\n" +
        "1. Verifica la credibilidad: analiza la fuente, el titular y el contenido. Te devuelve un veredicto: ✅ VERIFICADA · 🟡 PROBABLE · ⚠️ DUDOSA · 🚫 FALSA. Si es falsa, para ahí.\n\n" +
        "2. Genera la opinión al estilo CriptoScope: qué significa para el mercado, cómo afectaría al precio, qué vigilarías. Añade la fuente si la detecta.\n\n" +
        "Te aparecen botones para publicar en canal, en X, en ambos, añadir portada o descartar. Si publicas con la propia foto como portada, se adjunta integrada en el mensaje del canal.\n\n" +
        "También puedes mandar una foto con pie de foto como comando: <code>/flash tema</code>, <code>/opinion tema</code>, etc. La foto se convierte automáticamente en portada.",
    },
    responde: {
      titulo: "💬 Foto de comentario — Redactar respuesta",
      uso: "Manda una foto con el pie de foto: 'responde'",
      ejemplo: "Foto del comentario + escribe 'responde' o 'replica' o 'contesta'",
      detalle:
        "Manda una captura de pantalla de un comentario (de X, Telegram, YouTube, donde sea) y escribe en el pie de foto: responde, replica, contesta o reply.\n\n" +
        "Claude lee el comentario de la imagen y te redacta una respuesta en la voz de CriptoScope: directa, educada pero firme, bien argumentada. Solo para ti — no publica nada.\n\n" +
        "Cópiala y pégala donde quieras. Útil para responder críticas, preguntas técnicas o debate en redes sin perder tiempo.",
    },
    monitor: {
      titulo: "📰 Monitor de noticias — Botones de acción rápida",
      uso: "Automático — llega solo cuando detecta keywords",
      ejemplo: "(no tiene comando — llega en privado cuando hay noticia relevante)",
      detalle:
        "El bot revisa 4 fuentes RSS cada 15 min: CoinDesk, Cointelegraph, The Block y Decrypt. Cuando detecta una noticia con tus keywords (MONITOR_KEYWORDS), te la manda en privado con cuatro botones:\n\n" +
        "⚡ <b>Flash</b> — genera un flash al estilo CriptoScope con preview y botones de destino\n" +
        "📝 <b>Hilo</b> — genera un hilo educativo de 5 tweets con preview y botones\n" +
        "🐦 <b>Tweet X</b> — genera un tweet nativo y lo publica directamente en X sin pasos intermedios. Se registra en Notion automáticamente.\n" +
        "🙈 <b>Ignorar</b> — descarta la noticia sin hacer nada\n\n" +
        "Cada noticia lleva una puntuación editorial: 🔥🔥🔥 Viral para X · 🔥🔥 Buena para X · 🔥 Canal Telegram · ⬜ Omitir.\n\n" +
        "Configura tus keywords en MONITOR_KEYWORDS en Railway (separadas por comas).",
    },
    publicar: {
      titulo: "📤 /publicar — Publica tu propio contenido en X y Telegram",
      uso: "/publicar <texto> (con foto adjunta opcional)",
      ejemplo: "/publicar BTC rompe el ATH. Clave: 74.000 ya era soporte.",
      detalle:
        "Publica tu propio texto (y foto opcional) directamente en X y/o el canal sin que Claude lo modifique.\n\n" +
        "Manda el texto como argumento — puedes adjuntar una foto al mismo mensaje. Verás una preview con cuatro botones:\n" +
        "🐦 <b>Solo X</b> — publica solo en Twitter/X\n" +
        "📢 <b>Solo Canal</b> — publica solo en Telegram\n" +
        "🔄 <b>X + Canal</b> — publica en ambos\n" +
        "❌ <b>Cancelar</b> — descarta sin publicar\n\n" +
        "La publicación caduca si no confirmas en 30 minutos.",
    },
    banner: {
      titulo: "🖼 /banner — Genera portada para X (1500x500)",
      uso: "/banner",
      ejemplo: "/banner",
      detalle:
        "Genera una imagen de portada profesional de 1500x500 px lista para subir al perfil de X.\n\n" +
        "El banner incluye precio de BTC y ETH, Fear & Greed Index, dominancia BTC y un mini gráfico de barras con los mejores y peores activos del dia.\n\n" +
        "Se envía como archivo (sin compresión) para que la subas directamente en Configuración de X. Actualízalo cuando el mercado tenga datos que merezcan mostrarse.",
    },
    cancelar_editorial: {
      titulo: "🚫 /cancelar_editorial — Cancela el tweet editorial pendiente",
      uso: "/cancelar_editorial",
      ejemplo: "/cancelar_editorial",
      detalle:
        "Si el pipeline editorial acaba de generar un tweet y está esperando antes de publicar en X, este comando lo cancela.\n\n" +
        "El pipeline editorial genera tweets automáticamente segun el guion semanal de crecimiento:\n" +
        "📅 Lunes 16:30 — Flujo ETF\n" +
        "📅 Martes 10:00 — Angulo institucional\n" +
        "📅 Miercoles 12:00 — Concepto educativo\n" +
        "📅 Sábado 11:00 — Patron historico\n" +
        "📅 Domingo 18:00 — Tweet principal de la semana\n\n" +
        "Cuando el pipeline genera un borrador, recibes el texto en privado y tienes EDITORIAL_DELAY_MIN minutos para cancelarlo antes de que se publique en X.",
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

  // Menú general — compacto para que entre en un solo mensaje
  const menu =
    `<b>🤖 CriptoScope Bot</b>\n` +
    `<code>/ayuda &lt;comando&gt;</code> para detalle · ej: <code>/ayuda flash</code>\n\n` +
    `──────────────\n` +
    `<b>📢 Publican en canal / X (preview + botones)</b>\n` +
    `<code>/flash</code> &lt;tema&gt; — Alerta urgente\n` +
    `<code>/hilo</code> &lt;tema o URL&gt; — Thread de 5 tweets\n` +
    `<code>/opinion</code> &lt;noticia&gt; — Análisis al estilo CriptoScope\n` +
    `<code>/analiza</code> &lt;coin&gt; — Análisis técnico con entrada, TP y SL\n` +
    `<code>/encuesta</code> [tema] — Poll nativo para el canal\n` +
    `<code>/semanal</code> — Resumen semanal bajo demanda\n` +
    `<code>/publicar</code> &lt;texto&gt; — Publica tu propio texto en X y/o canal\n` +
    `<code>/banner</code> — Genera portada para X (1500x500)\n` +
    `<i>📸 Todos admiten portada — /ayuda flash para más detalle</i>\n\n` +
    `──────────────\n` +
    `<b>🔒 Solo para ti (privado)</b>\n` +
    `<code>/precio</code> &lt;coin&gt; — Precio actual con máx/mín\n` +
    `<code>/quepasa</code> — Resumen del mercado ahora mismo\n` +
    `<code>/senal</code> &lt;coin&gt; — Señal técnica sin publicar\n` +
    `<code>/calendario</code> — Eventos macro de la semana\n` +
    `<code>/alerta</code> &lt;coin&gt; &lt;precio&gt; — Aviso al llegar al nivel\n` +
    `<code>/alertas</code> · <code>/borralalerta &lt;n&gt;</code>\n\n` +
    `──────────────\n` +
    `<b>⏰ Programadas</b>\n` +
    `<code>/programar</code> &lt;tipo&gt; &lt;HH:MM&gt; &lt;tema&gt;\n` +
    `<code>/programadas</code> · <code>/cancelar &lt;id&gt;</code>\n\n` +
    `──────────────\n` +
    `<b>📸 Fotos sin comando</b>\n` +
    `Foto → verificación + análisis + botones para publicar\n` +
    `Foto + <code>responde</code> → redacta respuesta al comentario\n\n` +
    `──────────────\n` +
    `<b>📰 Monitor RSS (automático)</b>\n` +
    `Noticias con keywords → ⚡ Flash · 📝 Hilo · 🐦 Tweet X · 🙈 Ignorar\n` +
    `<i>/ayuda monitor para detalle</i>\n\n` +
    `──────────────\n` +
    `<b>⚙️ Sistema</b>\n` +
    `<code>/stats</code> — Rendimiento señales 7 días\n` +
    `<code>/cancelar_editorial</code> — Cancela tweet editorial pendiente\n` +
    `<code>/estado</code> · <code>/pausa</code> · <code>/activa</code> · <code>/ayuda</code>\n\n` +
    `──────────────\n` +
    `<b>🖼 Portadas fijas (admin)</b>\n` +
    `<code>/setportada briefing</code> — Fijar portada del briefing diario\n` +
    `<code>/setportada semanal</code> — Fijar portada del resumen semanal\n` +
    `<code>/clearportada briefing</code> — Volver a portada auto-generada\n` +
    `<code>/clearportada semanal</code> — Volver a portada auto-generada\n` +
    `<i>Manda la foto después de ejecutar /setportada</i>`;

  await reply(chatId, menu);
}

// ──────────────────────────────────────────────
// ALERTAS DE PRECIO
// ──────────────────────────────────────────────

// /alerta BTC 70000  →  avisa cuando BTC supere 70000
// /alerta ETH <30000  →  avisa cuando ETH baje de 30000
async function cmdAlerta(chatId, argStr) {
  if (!argStr) return reply(chatId,
    "❓ <b>Uso:</b>\n" +
    "<code>/alerta BTC 70000</code> — avisa si sube a 70000\n" +
    "<code>/alerta ETH &lt;30000</code> — avisa si baja de ese nivel\n" +
    "<code>/alerta SOL &gt;150</code> — avisa si supera ese nivel\n\n" +
    "Sin &lt; ni &gt; se interpreta como 'si llega a ese precio desde donde está ahora'."
  );

  const partes = argStr.trim().split(/\s+/);
  if (partes.length < 2) return reply(chatId, "❓ Uso: /alerta BTC 70000 · /alerta ETH <1800");

  const coin = partes[0].toUpperCase();
  const rawPrecio = partes[1];

  let direccion = null;
  let precio = null;

  if (rawPrecio.startsWith("<")) {
    direccion = "baja";
    precio = parseFloat(rawPrecio.slice(1));
  } else if (rawPrecio.startsWith(">")) {
    direccion = "sube";
    precio = parseFloat(rawPrecio.slice(1));
  } else {
    precio = parseFloat(rawPrecio);
    // Determinar dirección según precio actual
    try {
      const ps = await getPrices();
      const key = `${coin}-USD`;
      const actual = ps[key]?.precio;
      if (!actual) return reply(chatId, `❌ No encontré precio para ${coin}. Prueba BTC, ETH o SOL.`);
      direccion = precio > actual ? "sube" : "baja";
    } catch {
      direccion = "sube"; // fallback
    }
  }

  if (!precio || isNaN(precio)) return reply(chatId, "❌ Precio no válido.");

  alertasPrecios.push({ coin, precio, direccion, chatId });
  guardarAlertas(alertasPrecios);

  const dir = direccion === "sube" ? "suba a" : "baje a";
  await reply(chatId, `✅ Alerta guardada: te aviso cuando <b>${coin}</b> ${dir} <b>$${precio.toLocaleString()}</b>`);
}

// /alertas — lista las alertas activas
async function cmdAlertas(chatId) {
  const mias = alertasPrecios.filter((a) => a.chatId === chatId);
  if (!mias.length) return reply(chatId, "No tienes alertas activas.\n\nUsa <code>/alerta BTC 70000</code> para crear una.");

  const lista = mias.map((a, i) => {
    const dir = a.direccion === "sube" ? "↑ sube a" : "↓ baja a";
    return `${i + 1}. <b>${a.coin}</b> ${dir} <b>$${a.precio.toLocaleString()}</b>`;
  }).join("\n");
  await reply(chatId, `🔔 <b>Tus alertas activas</b>\n\n${lista}\n\nUsa <code>/borralalerta 1</code> para eliminar por número.`);
}

// /borralalerta <número> — elimina una alerta
async function cmdBorrarAlerta(chatId, argStr) {
  const mias = alertasPrecios.filter((a) => a.chatId === chatId);
  const idx = parseInt(argStr) - 1;
  if (isNaN(idx) || idx < 0 || idx >= mias.length)
    return reply(chatId, `❓ Uso: /borralalerta <número>\n\nEscribe /alertas para ver tus alertas con su número.`);

  const alerta = mias[idx];
  alertasPrecios = alertasPrecios.filter((a) => a !== alerta);
  guardarAlertas(alertasPrecios);
  await reply(chatId, `🗑 Alerta eliminada: ${alerta.coin} $${alerta.precio.toLocaleString()}`);
}

// Verifica alertas contra precios actuales — llamada desde index.js cada 5 min
export async function verificarAlertasPrecios() {
  if (!alertasPrecios.length) return;
  let precios;
  try { precios = await getPrices(); } catch { return; }

  const disparadas = [];
  alertasPrecios = alertasPrecios.filter((a) => {
    const key = `${a.coin}-USD`;
    const actual = precios[key]?.precio;
    if (!actual) return true; // no hay dato, mantener

    const tocada =
      (a.direccion === "sube" && actual >= a.precio) ||
      (a.direccion === "baja" && actual <= a.precio);

    if (tocada) { disparadas.push({ ...a, actual }); return false; }
    return true;
  });

  if (disparadas.length) guardarAlertas(alertasPrecios);

  for (const a of disparadas) {
    const dir = a.direccion === "sube" ? "🚀 HA SUBIDO A" : "📉 HA BAJADO A";
    await fetch(`${API()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: a.chatId,
        text: `🔔 <b>ALERTA DE PRECIO</b>\n\n<b>${a.coin}</b> ${dir} <b>$${a.actual.toLocaleString()}</b>\nNivel vigilado: $${a.precio.toLocaleString()}`,
        parse_mode: "HTML",
      }),
    }).catch(() => {});
  }
}

// ──────────────────────────────────────────────
// MONITOR DE NOTICIAS
// ──────────────────────────────────────────────

const KEYWORDS_NOTICIAS = (process.env.MONITOR_KEYWORDS || "ETF,BlackRock,SEC,Fed,FOMC,Bitcoin,halving,Ethereum,crash,pump,liquidaciones,Binance,Coinbase")
  .split(",").map((k) => k.trim().toLowerCase());

const FUENTES_RSS = [
  { nombre: "CoinDesk",      url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { nombre: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { nombre: "The Block",     url: "https://www.theblock.co/rss.xml" },
  { nombre: "Decrypt",       url: "https://decrypt.co/feed" },
  { nombre: "BeInCrypto",    url: "https://beincrypto.com/feed/" },
  { nombre: "The Defiant",   url: "https://thedefiant.io/feed/" },
  ...(process.env.CRYPTOPANIC_TOKEN
    ? [{ nombre: "CryptoPanic", url: `https://cryptopanic.com/news/rss/?auth_token=${process.env.CRYPTOPANIC_TOKEN}&kind=news` }]
    : []),
];

export async function monitorNoticias() {
  if (!OWNER()) return;
  limpiarNoticiasViejas(); // purga GUIDs con más de 24h para evitar memory leak

  const MAX_EDAD_MS  = 60 * 60 * 1000; // ignorar noticias de más de 1 hora
  const MAX_X_FUENTE = 3;               // máx alertas por fuente por ciclo

  for (const fuente of FUENTES_RSS) {
    try {
      const res = await fetch(fuente.url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const xml = await res.text();

      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
        const get = (tag) => m[1].match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, "s"))?.[1]?.trim() || "";
        const guid       = get("guid") || get("link");
        const pubDateStr = get("pubDate") || get("dc:date");
        const pubDate    = pubDateStr ? new Date(pubDateStr) : null;
        return { guid, titulo: get("title"), link: get("link"), fuente: fuente.nombre, pubDate };
      });

      let enviadas = 0;
      for (const item of items) {
        if (enviadas >= MAX_X_FUENTE) break;
        if (!item.guid || noticiasVistas.has(item.guid)) continue;

        // Marcar siempre como vista (antigua o nueva) para no repetir en siguientes ciclos
        noticiasVistas.set(item.guid, Date.now());

        // Descartar si tiene pubDate y lleva más de 1 hora publicada
        if (item.pubDate && !isNaN(item.pubDate) && Date.now() - item.pubDate.getTime() > MAX_EDAD_MS) continue;

        const coincide = KEYWORDS_NOTICIAS.some((k) => item.titulo.toLowerCase().includes(k));
        if (!coincide) continue;

        const nid = cachearNoticia(item.titulo, item.link);
        await fetch(`${API()}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: OWNER(),
            text: `${puntuarNoticia({ titulo: item.titulo, resumen: "" }).emoji} <b>${item.fuente}</b> · <i>${puntuarNoticia({ titulo: item.titulo, resumen: "" }).etiqueta}</i>\n\n<b>${item.titulo}</b>\n\n<a href="${item.link}">Ver artículo</a>`,
            parse_mode: "HTML",
            disable_web_page_preview: false,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "⚡ Flash", callback_data: `news_flash:${nid}` },
                  { text: "📝 Hilo",  callback_data: `news_hilo:${nid}` },
                ],
                [
                  { text: "🐦 Tweet X", callback_data: `news_tweet:${nid}` },
                  { text: "🙈 Ignorar", callback_data: "nopub" },
                ],
              ],
            },
          }),
        });

        enviadas++;
        await new Promise((r) => setTimeout(r, 800));
      }
    } catch (e) {
      console.warn(`⚠️  Monitor RSS ${fuente.nombre}:`, e.message);
    }
  }
}

// ──────────────────────────────────────────────
// PUBLICACIONES PROGRAMADAS
// ──────────────────────────────────────────────

// /programar flash 18:00 BlackRock compra más BTC
// /programar hilo 09:30 qué son los ETFs de Bitcoin
async function cmdProgramar(chatId, argStr) {
  if (!argStr) return reply(chatId,
    "❓ <b>Uso:</b>\n" +
    "<code>/programar flash 18:00 &lt;tema&gt;</code>\n" +
    "<code>/programar hilo 09:30 &lt;tema&gt;</code>\n" +
    "<code>/programar opinion 15:00 &lt;noticia&gt;</code>\n\n" +
    "La hora es en horario de Madrid. Si ya pasó hoy, se programa para mañana."
  );

  const partes = argStr.trim().split(/\s+/);
  if (partes.length < 3) return reply(chatId, "❓ Faltan argumentos. Ejemplo: /programar flash 18:00 BlackRock compra BTC");

  const tipo = partes[0].toLowerCase();
  const horaStr = partes[1];
  const contenido = partes.slice(2).join(" ");

  if (!["flash", "hilo", "opinion"].includes(tipo))
    return reply(chatId, "❌ Tipo no válido. Usa: flash, hilo, u opinion");

  const [hh, mm] = horaStr.split(":").map(Number);
  if (isNaN(hh) || isNaN(mm) || hh > 23 || mm > 59)
    return reply(chatId, "❌ Hora no válida. Formato: HH:MM (ej. 18:00)");

  // Calcular ms hasta la hora objetivo (Madrid)
  const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TIMEZONE || "Europe/Madrid" }));
  const objetivo = new Date(ahora);
  objetivo.setHours(hh, mm, 0, 0);
  if (objetivo <= ahora) objetivo.setDate(objetivo.getDate() + 1);
  const msHasta = objetivo.getTime() - ahora.getTime();

  const id = progContador++;
  const descripcion = `/${tipo} a las ${horaStr} → "${contenido.slice(0, 50)}"`;

  const timer = setTimeout(async () => {
    programadas.delete(id);
    console.log(`⏰ Ejecutando programada #${id}: ${descripcion}`);
    try {
      if (tipo === "flash") await cmdFlash(chatId, contenido);
      else if (tipo === "hilo") await cmdHilo(chatId, contenido);
      else if (tipo === "opinion") await cmdOpinion(chatId, contenido);
    } catch (e) {
      await reply(chatId, `❌ Error en publicación programada #${id}: ${e.message}`).catch(() => {});
    }
  }, msHasta);

  programadas.set(id, { descripcion, timer, horaStr, tipo, contenido, chatId });

  const esMañana = objetivo.getDate() !== ahora.getDate();
  await reply(chatId,
    `✅ Publicación programada (#${id})\n\n` +
    `<b>Tipo:</b> /${tipo}\n` +
    `<b>Hora:</b> ${horaStr} Madrid${esMañana ? " (mañana)" : ""}\n` +
    `<b>Contenido:</b> ${contenido.slice(0, 80)}\n\n` +
    `Usa <code>/programadas</code> para ver todas · <code>/cancelar ${id}</code> para borrar`
  );
}

// /programadas — lista las publicaciones programadas pendientes
async function cmdProgramadas(chatId) {
  if (!programadas.size) return reply(chatId, "No hay publicaciones programadas.\n\nUsa <code>/programar flash 18:00 tema</code> para crear una.");

  const lista = [...programadas.entries()].map(([id, p]) =>
    `<b>#${id}</b> · /${p.tipo} · ${p.horaStr} · "${p.contenido.slice(0, 40)}..."`
  ).join("\n");
  await reply(chatId, `⏰ <b>Publicaciones programadas</b>\n\n${lista}\n\nUsa <code>/cancelar &lt;id&gt;</code> para eliminar una.`);
}

// /cancelar <id> — cancela una publicación programada
async function cmdCancelar(chatId, argStr) {
  const id = parseInt(argStr);
  if (isNaN(id) || !programadas.has(id))
    return reply(chatId, `❓ ID no encontrado. Usa /programadas para ver los IDs activos.`);

  const p = programadas.get(id);
  clearTimeout(p.timer);
  programadas.delete(id);
  await reply(chatId, `🗑 Publicación #${id} cancelada: ${p.descripcion}`);
}

// /setportada [briefing|semanal] — fija una portada permanente (solo owner)
async function cmdSetPortada(chatId, tipo) {
  if (String(chatId) !== String(OWNER())) return reply(chatId, "❌ Solo el owner puede hacer esto.");
  const t = (tipo || "").trim().toLowerCase();
  if (t !== "briefing" && t !== "semanal") {
    return reply(chatId, "❓ Uso: /setportada briefing  o  /setportada semanal\n\nTras ejecutarlo, manda la foto que quieras fijar como portada.");
  }
  waitingPortadaFija.set(chatId, t);
  await reply(chatId, `📸 Mándame la foto que quieres fijar como portada del <b>${t}</b>.\n\nSe le aplicará el logo automáticamente y quedará guardada.`);
}

// /clearportada [briefing|semanal] — elimina la portada fija (vuelve a la auto-generada)
async function cmdClearPortada(chatId, tipo) {
  if (String(chatId) !== String(OWNER())) return reply(chatId, "❌ Solo el owner puede hacer esto.");
  const t = (tipo || "").trim().toLowerCase();
  if (t !== "briefing" && t !== "semanal") {
    return reply(chatId, "❓ Uso: /clearportada briefing  o  /clearportada semanal");
  }
  clearPortadaFija(t);
  await reply(chatId, `🗑 Portada fija del <b>${t}</b> eliminada. Se usará la portada automática.`);
}

// /briefing — genera el briefing con portada auto (o fija) y muestra preview + botones (solo owner)
async function cmdBriefingManual(chatId) {
  if (String(chatId) !== String(OWNER())) return reply(chatId, "❌ Solo el owner puede ejecutar esto.");
  await reply(chatId, "☕ Generando briefing...");
  try {
    const { texto, portadaBuffer } = await generarBriefing();
    const pid = Date.now().toString(36);
    pendingPublish.set(pid, texto);
    setTimeout(() => { pendingPublish.delete(pid); portadas.delete(pid); }, 30 * 60 * 1000);

    const portadaFijaId = getPortadaFija("briefing");

    if (portadaFijaId) {
      // Portada fija configurada → usarla directamente (ya tiene logo)
      portadas.set(pid, portadaFijaId);
      await fetch(`${API()}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId.toString(), photo: portadaFijaId, caption: "📌 Portada fija — puedes cambiarla con /setportada briefing" }),
      });
    } else if (portadaBuffer) {
      // Portada auto-generada
      try {
        const form = new FormData();
        form.append("chat_id", chatId.toString());
        form.append("photo", new Blob([portadaBuffer], { type: "image/png" }), "briefing.png");
        form.append("caption", "📊 Portada generada automáticamente — puedes cambiarla antes de publicar");
        const photoRes  = await fetch(`${API()}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
        const photoJson = await photoRes.json();
        if (photoJson.ok) portadas.set(pid, photoJson.result.photo.at(-1).file_id);
      } catch (e) {
        console.warn("⚠️ No pude enviar portada del briefing:", e.message);
      }
    }

    await mostrarBotonesPublicacion(chatId, pid, texto);
  } catch (e) {
    await reply(chatId, `❌ Error generando el briefing: ${e.message}`);
  }
}

// /semanal — resumen semanal con gráfico auto (o portada fija) + preview + botones
async function cmdSemanal(chatId) {
  await reply(chatId, "📊 Generando resumen semanal...");
  try {
    const { mensaje, chartBuffer } = await ejecutarResumenSemanal();
    const pid = Date.now().toString(36);
    pendingPublish.set(pid, mensaje);
    setTimeout(() => { pendingPublish.delete(pid); portadas.delete(pid); }, 30 * 60 * 1000);

    const portadaFijaId = getPortadaFija("semanal");

    if (portadaFijaId) {
      portadas.set(pid, portadaFijaId);
      await fetch(`${API()}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId.toString(), photo: portadaFijaId, caption: "📌 Portada fija — puedes cambiarla con /setportada semanal" }),
      });
    } else if (chartBuffer) {
      try {
        const form = new FormData();
        form.append("chat_id", chatId.toString());
        form.append("photo", new Blob([chartBuffer], { type: "image/png" }), "semanal.png");
        form.append("caption", "📈 Evolución semanal BTC · ETH · SOL");
        const photoRes  = await fetch(`${API()}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
        const photoJson = await photoRes.json();
        if (photoJson.ok) portadas.set(pid, photoJson.result.photo.at(-1).file_id);
      } catch (e) {
        console.warn("⚠️ No pude enviar gráfico semanal:", e.message);
      }
    }

    await mostrarBotonesPublicacion(chatId, pid, mensaje);
  } catch (e) {
    await reply(chatId, `❌ No pude generar el resumen semanal: ${e.message}`);
  }
}

// /encuesta — genera encuesta para el canal basada en el mercado actual
async function cmdEncuesta(chatId, temaManual) {
  await reply(chatId, "🗳 Generando encuesta...");

  const [precios, fearGreed] = await Promise.all([
    getPrices().catch(() => ({})),
    getFearGreed().catch(() => null),
  ]);

  const ctxMercado =
    `BTC $${precios["BTC-USD"]?.precio?.toFixed(0) || "?"} (${precios["BTC-USD"]?.cambio24h_pct?.toFixed(1) || "?"}%) · ` +
    `ETH $${precios["ETH-USD"]?.precio?.toFixed(0) || "?"} (${precios["ETH-USD"]?.cambio24h_pct?.toFixed(1) || "?"}%) · ` +
    `Fear&Greed ${fearGreed?.valor || "?"} ${fearGreed?.clasificacion || ""}`;

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 400,
    system: `Eres CriptoScope. Genera encuestas para la comunidad cripto en Telegram. Directas, relevantes para lo que pasa hoy. Sin preguntas obvias ni condescendientes. La gente que sigue el canal sabe de mercados.`,
    messages: [{
      role: "user",
      content: `Mercado ahora: ${ctxMercado}\n${temaManual ? `Tema sugerido: ${temaManual}\n` : ""}
Devuelve SOLO este JSON sin markdown:
{"pregunta":"La pregunta (máx 100 chars)","opciones":["Opción A","Opción B","Opción C","Opción D"],"tipo":"opinion|prediccion|educativa"}

Reglas:
- Entre 2 y 4 opciones. Máx 100 chars cada una.
- Si es predicción: opciones con niveles de precio o % concretos, no "sí/no"
- Si es opinión: opciones que reflejen posturas reales de traders
- Si es educativa: conectada a un concepto que esté en el mercado hoy`,
    }],
  });

  let encuesta;
  try {
    const txt = response.content[0].text;
    encuesta = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
  } catch {
    return reply(chatId, "❌ No pude generar la encuesta. Inténtalo de nuevo.");
  }

  // Guardar para el callback
  const pid = Date.now().toString(36);
  pendingPublish.set(pid, { tipo: "encuesta", pregunta: encuesta.pregunta, opciones: encuesta.opciones });
  setTimeout(() => pendingPublish.delete(pid), 30 * 60 * 1000);

  // Mostrar preview con botones
  const preview =
    `🗳 <b>Preview de la encuesta</b>\n\n` +
    `<b>${encuesta.pregunta}</b>\n\n` +
    encuesta.opciones.map((o, i) => `${["🔵","🟡","🟢","🔴"][i]} ${o}`).join("\n") +
    `\n\n<i>Tipo: ${encuesta.tipo}</i>`;

  await fetch(`${API()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: preview,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Enviar al canal", callback_data: `enc:${pid}` },
          { text: "🔄 Regenerar", callback_data: `enc_re:${temaManual || ""}` },
          { text: "❌ Cancelar", callback_data: "nopub" },
        ]],
      },
    }),
  });
}

// ──────────────────────────────────────────────
// ROUTER DE COMANDOS
// ──────────────────────────────────────────────

async function procesarMensaje(msg) {
  const chatId = msg.chat.id;

  // Si manda una foto
  if (msg.photo) {
    const cap = (msg.caption || "").trim();
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    // ¿Estamos esperando una portada FIJA (para briefing o semanal)?
    if (waitingPortadaFija.has(chatId)) {
      const tipo = waitingPortadaFija.get(chatId);
      waitingPortadaFija.delete(chatId);
      await reply(chatId, "⏳ Aplicando logo y guardando portada fija...");
      try {
        const fileInfoRes = await fetch(`${API()}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(10000) });
        const fileInfo    = await fileInfoRes.json();
        const imgRes      = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`, { signal: AbortSignal.timeout(20000) });
        const imgConLogo  = await aplicarLogo(Buffer.from(await imgRes.arrayBuffer()));
        // Re-subir para obtener file_id de la versión con logo
        const form = new FormData();
        form.append("chat_id", chatId.toString());
        form.append("photo", new Blob([imgConLogo], { type: "image/png" }), "portada_fija.png");
        form.append("caption", `✅ Portada fija para <b>${tipo}</b> guardada con logo.\n\n<code>Para Railway (persistencia entre redeploys):\n${tipo === "briefing" ? "BRIEFING" : "SEMANAL"}_PORTADA_FILE_ID = &lt;file_id abajo&gt;</code>`);
        form.append("parse_mode", "HTML");
        const uploadRes  = await fetch(`${API()}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(25000) });
        const uploadJson = await uploadRes.json();
        if (!uploadJson.ok) throw new Error(uploadJson.description);
        const nuevoFileId = uploadJson.result.photo.at(-1).file_id;
        setPortadaFija(tipo, nuevoFileId);
        await reply(chatId, `✅ Portada fija guardada.\n\n<b>File ID</b> (guárdalo en Railway si quieres que persista):\n<code>${nuevoFileId}</code>`);
      } catch (e) {
        await reply(chatId, `❌ No pude guardar la portada fija: ${e.message}`);
      }
      return;
    }

    // ¿Estamos esperando una portada para un contenido pendiente?
    if (waitingCover.has(chatId)) {
      const pid = waitingCover.get(chatId);
      waitingCover.delete(chatId);
      if (!pendingPublish.has(pid)) return reply(chatId, "❌ El contenido ya expiró. Vuelve a generarlo.");
      portadas.set(pid, fileId);
      const msg2 = pendingPublish.get(pid);
      await reply(chatId, "📸 Portada guardada.");
      await mostrarBotonesPublicacion(chatId, pid, msg2);
      return;
    }

    // ¿Foto con comando en el pie → usar como portada del contenido generado?
    const cmdPortada = cap.match(/^\/?(flash|hilo|opinion|analiza|quepasa)\s*(.*)/i);
    if (cmdPortada) {
      const tipo = cmdPortada[1].toLowerCase();
      const argPortada = cmdPortada[2].trim();
      await reply(chatId, `📸 Portada recibida. Generando ${tipo}...`);
      try {
        if (tipo === "flash") await cmdFlash(chatId, argPortada, fileId);
        else if (tipo === "hilo") await cmdHilo(chatId, argPortada, fileId);
        else if (tipo === "opinion") await cmdOpinion(chatId, argPortada, fileId);
        else if (tipo === "analiza") await cmdAnaliza(chatId, argPortada, fileId);
        else if (tipo === "quepasa") await cmdQuePasa(chatId, fileId);
      } catch (e) {
        await reply(chatId, `❌ Error: ${e.message}`);
      }
      return;
    }

    // Foto sin comando → análisis de noticia
    await cmdFoto(chatId, msg.photo, cap);
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
      case "/flash": {
        const cd = checkCooldown(chatId, "flash", 30);
        if (cd) { await reply(chatId, `⏳ Espera ${cd}s antes de lanzar otro flash.`); break; }
        await cmdFlash(chatId, argStr); break;
      }
      case "/hilo": {
        const cd = checkCooldown(chatId, "hilo", 60);
        if (cd) { await reply(chatId, `⏳ Espera ${cd}s antes de generar otro hilo.`); break; }
        await cmdHilo(chatId, argStr); break;
      }
      case "/analiza": {
        const cd = checkCooldown(chatId, "analiza", 45);
        if (cd) { await reply(chatId, `⏳ Espera ${cd}s antes de lanzar otro análisis.`); break; }
        await cmdAnaliza(chatId, argStr); break;
      }
      case "/grafico":
      case "/grafica": {
        const cd = checkCooldown(chatId, "grafico", 20);
        if (cd) { await reply(chatId, `⏳ Espera ${cd}s antes de pedir otro gráfico.`); break; }
        await cmdGrafico(chatId, argStr); break;
      }
      case "/opinion": {
        const cd = checkCooldown(chatId, "opinion", 45);
        if (cd) { await reply(chatId, `⏳ Espera ${cd}s antes de generar otra opinión.`); break; }
        await cmdOpinion(chatId, argStr); break;
      }
      case "/precio":     await cmdPrecio(chatId, argStr); break;
      case "/quepasa":    await cmdQuePasa(chatId); break;
      case "/senal":
      case "/señal": {
        const cd = checkCooldown(chatId, "senal", 30);
        if (cd) { await reply(chatId, `⏳ Espera ${cd}s antes de pedir otra señal.`); break; }
        await cmdSenal(chatId, argStr); break;
      }
      case "/publicar":   await cmdPublicar(chatId, argStr); break;
      case "/calendario": await cmdCalendario(chatId); break;
      case "/banner":     await cmdBanner(chatId); break;
      case "/estado":     await cmdEstado(chatId); break;
      case "/pausa":      await cmdPausa(chatId); break;
      case "/activa":     await cmdActiva(chatId); break;
      case "/alerta":       await cmdAlerta(chatId, argStr); break;
      case "/alertas":      await cmdAlertas(chatId); break;
      case "/borralalerta": await cmdBorrarAlerta(chatId, argStr); break;
      case "/programar":    await cmdProgramar(chatId, argStr); break;
      case "/programadas":  await cmdProgramadas(chatId); break;
      case "/cancelar":            await cmdCancelar(chatId, argStr); break;
      case "/cancelar_editorial": {
        const cancelado = cancelarEditorial();
        await reply(chatId, cancelado
          ? "❌ Tweet editorial cancelado. No se publicará en X."
          : "ℹ️ No hay ningún tweet editorial pendiente de publicar.");
        break;
      }
      case "/encuesta":     await cmdEncuesta(chatId, argStr); break;
      case "/semanal":      await cmdSemanal(chatId); break;
      case "/briefing":     await cmdBriefingManual(chatId); break;
      case "/setportada":   await cmdSetPortada(chatId, argStr); break;
      case "/clearportada": await cmdClearPortada(chatId, argStr); break;
      case "/stats":        await cmdStats(chatId); break;
      case "/historial":    await cmdHistorial(chatId); break;
      case "/ayuda":
      case "/help":         await cmdAyuda(chatId, argStr); break;
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
// /stats — rendimiento de señales últimos 7 días
async function cmdStats(chatId) {
  const stats = await generarEstadisticasSemana().catch(() => null);
  if (!stats || stats.total === 0) return reply(chatId, "📊 Sin señales registradas esta semana.");
  const wins = stats.tp1 + stats.tp2;
  const losses = stats.sl;
  await reply(chatId,
    `📊 <b>STATS | Señales últimos 7 días</b>\n\n` +
    `Total: <b>${stats.total}</b>  ·  LONG: ${stats.longs}  ·  SHORT: ${stats.shorts}\n` +
    `✅ TP1: ${stats.tp1}  ·  TP2: ${stats.tp2}  ·  ❌ SL: ${stats.sl}\n` +
    `⏳ Pendientes: ${stats.pendientes}  ·  Expiradas: ${stats.expiradas}\n\n` +
    `<b>Win rate: ${stats.winrate}%</b>  <i>(${wins}W / ${losses}L)</i>`
  );
}

// Envía señal al owner con botón de revisión antes de publicar al canal
export async function enviarSenalParaRevisar(mensaje) {
  const ownerId = OWNER();
  if (!ownerId) {
    // Sin owner configurado → publicar directamente
    await enviarTelegram(mensaje);
    return;
  }
  const pid = `senal_${Date.now().toString(36)}`;
  senalesPendientes.set(pid, mensaje);
  setTimeout(() => senalesPendientes.delete(pid), 90 * 60 * 1000); // expira en 90 min

  await fetch(`${API()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: ownerId,
      text: mensaje + `\n\n──────────────\n<i>⏳ Revisión previa. ¿Publico esto en el canal?</i>`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: "📢 Publicar en canal", callback_data: `pub_senal:${pid}` },
          { text: "❌ Descartar", callback_data: `del_senal:${pid}` },
        ]],
      },
    }),
  });
}

// /historial — últimas 10 señales con resultado
async function cmdHistorial(chatId) {
  const stats = await generarEstadisticasSemana().catch(() => null);
  if (!stats?.senales?.length) return reply(chatId, "📊 Sin señales registradas esta semana.\n\nUsa /stats para ver el resumen.");

  const ultimas = [...stats.senales]
    .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
    .slice(0, 10);

  let msg = `📋 <b>Historial de señales — últimas ${ultimas.length}</b>\n\n`;
  for (const s of ultimas) {
    const fecha = new Date(s.fecha).toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: process.env.TIMEZONE || "Europe/Madrid" });
    const hora  = new Date(s.fecha).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: process.env.TIMEZONE || "Europe/Madrid" });
    const res   = s.resultado === "PENDIENTE" ? "⏳" : s.resultado === "EXPIRADO" ? "⌛" :
                  s.resultado?.includes("TP2") ? "✅✅ TP2" : s.resultado?.includes("TP1") ? "✅ TP1" :
                  s.resultado?.includes("SL")  ? "❌ SL"   : "❓";
    const op    = s.op === "LONG" ? "🟢 LONG" : s.op === "SHORT" ? "🔴 SHORT" : "⏸";
    msg += `${res}  <b>${s.symbol}</b> ${op}  <i>${fecha} ${hora}</i>\n`;
    if (s.entrada) msg += `   Entrada <b>${s.entrada}</b>  TP1 ${s.tp1 || "?"}  SL ${s.sl || "?"}\n`;
    msg += "\n";
  }

  const wins = stats.tp1 + stats.tp2;
  msg += `──────────────\n📊 Semana: ${stats.total} señales  ·  Win rate <b>${stats.winrate}%</b>  <i>(${wins}W / ${stats.sl}L)</i>`;
  await reply(chatId, msg);
}

// Recap diario privado al owner — llamado desde index.js a las 22:00
export async function ejecutarRecapDiario() {
  const ownerId = OWNER();
  if (!ownerId) return;

  const stats = await generarEstadisticasSemana().catch(() => null);
  const hoy = new Date();
  const hoyStr = hoy.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: process.env.TIMEZONE || "Europe/Madrid" });
  const hoyInicio = new Date(hoy.toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE || "Europe/Madrid" })).getTime();

  let msg = `🌙 <b>Recap del día — ${hoyStr}</b>\n\n`;

  if (stats?.senales?.length) {
    const hoySeñales = stats.senales.filter((s) => new Date(s.fecha).getTime() >= hoyInicio);
    const hoyTp = hoySeñales.filter((s) => s.resultado?.includes("TP")).length;
    const hoySl = hoySeñales.filter((s) => s.resultado?.includes("SL")).length;
    const hoyPend = hoySeñales.filter((s) => s.resultado === "PENDIENTE").length;
    if (hoySeñales.length) {
      msg += `📡 <b>Señales de hoy:</b> ${hoySeñales.length} lanzadas\n`;
      if (hoyTp || hoySl) msg += `✅ TP: ${hoyTp}  ·  ❌ SL: ${hoySl}  ·  ⏳ Pendientes: ${hoyPend}\n`;
    }
    msg += `\n📊 <b>Semana acumulada:</b> ${stats.total} señales · Win rate ${stats.winrate}%\n`;
    msg += `✅ ${stats.tp1 + stats.tp2} aciertos  ·  ❌ ${stats.sl} pérdidas`;
  } else {
    msg += `📡 Sin señales registradas hoy.`;
  }

  await fetch(`${API()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ownerId, text: msg, parse_mode: "HTML" }),
  });
}

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
        { command: "analiza",    description: "Análisis técnico on-demand con gráfico 4H" },
        { command: "grafico",    description: "Gráfico de velas + EMA20/50 en cualquier timeframe" },
        { command: "opinion",    description: "Opinión sobre una noticia" },
        { command: "precio",     description: "Precio actual de una coin (privado)" },
        { command: "quepasa",    description: "Resumen del mercado ahora (privado)" },
        { command: "senal",      description: "Señal técnica privada sin publicar" },
        { command: "calendario", description: "Próximos eventos macro" },
        { command: "estado",     description: "Estado del sistema" },
        { command: "pausa",      description: "Pausar publicaciones automáticas" },
        { command: "activa",     description: "Reanudar publicaciones automáticas" },
        { command: "alerta",       description: "Alerta cuando una coin llegue a un precio" },
        { command: "alertas",      description: "Ver tus alertas de precio activas" },
        { command: "borralalerta", description: "Eliminar una alerta de precio" },
        { command: "programar",    description: "Programar flash/hilo/opinion a una hora" },
        { command: "programadas",  description: "Ver publicaciones programadas pendientes" },
        { command: "cancelar",     description: "Cancelar una publicación programada" },
        { command: "encuesta",   description: "Generar encuesta para el canal basada en el mercado" },
        { command: "semanal",    description: "Resumen semanal con preview + botones" },
        { command: "stats",      description: "Rendimiento de señales últimos 7 días" },
        { command: "historial",  description: "Últimas 10 señales con entrada, TP y resultado" },
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

// ──────────────────────────────────────────────
// WEBHOOK TRADINGVIEW
// Llamado desde webhook.js al recibir una alerta
// ──────────────────────────────────────────────

export async function procesarAlertaTradingView(bodyRaw) {
  const ownerId = process.env.TELEGRAM_OWNER_ID;
  if (!ownerId) { console.warn("⚠️ TV Webhook: TELEGRAM_OWNER_ID no configurado"); return; }

  // Intentar parsear como JSON, si no tratar como texto plano
  let payload;
  try { payload = JSON.parse(bodyRaw); }
  catch { payload = { message: bodyRaw }; }

  // Construir el tema a partir del payload
  const partes = [];
  const ticker = (payload.ticker || payload.symbol || "").replace(/USDT|PERP|USD\.P/gi, "").trim();
  if (ticker)                          partes.push(ticker);
  const tf = payload.timeframe || payload.interval || payload.tf || "";
  if (tf)                              partes.push(`${tf}`);
  const precio = payload.price || payload.close || payload.last || "";
  if (precio)                          partes.push(`$${parseFloat(precio).toLocaleString("es-ES")}`);
  const msg = payload.message || payload.alert || payload.text || "";
  if (msg)                             partes.push(msg);
  else if (payload.action || payload.side) partes.push(payload.action || payload.side);

  const tema = partes.filter(Boolean).join(" · ") || bodyRaw.slice(0, 300).trim();
  if (!tema) return;

  console.log(`🔔 TradingView → ${tema.slice(0, 100)}`);

  // Notificar al owner que llegó una alerta y generar flash con preview + botones
  await reply(parseInt(ownerId),
    `🔔 <b>Alerta TradingView</b>\n\n<i>${tema.slice(0, 300)}</i>\n\nGenerando flash...`
  );
  await cmdFlash(parseInt(ownerId), tema);
}
