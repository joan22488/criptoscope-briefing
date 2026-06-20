// ============================================================
// bot.js - Bot de Telegram con comandos bajo demanda
// Escucha mensajes directos al bot y ejecuta acciones
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { getMarketContext, getPrices, getFearGreed, getGlobalMarket } from "./coindesk.js";
import { analizarSymbol, generarSenal, getVelas, calcEMA } from "./signals.js";
import { getEventosMacro, formatearAlertaMacro } from "./calendar.js";
import { publicarThread, subirImagenX } from "./twitter-post.js";
import { enviarTelegram } from "./telegram.js";
import { ejecutarResumenSemanal } from "./weekly.js";
import { guardarPublicacionEnNotion } from "./notion.js";

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

// ── Publicaciones programadas ──────────────────
const programadas = new Map(); // id → { descripcion, timer }
let progContador = 1;

// ── Portadas pendientes ────────────────────────
const portadas = new Map();    // pid → fileId de la foto portada
const waitingCover = new Map(); // chatId → pid (esperando foto de portada)

// ── Hilos pendientes (array de tweets para publicar en X como thread real) ──
const hilosPendientes = new Map(); // pid → string[]

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

// ── Monitor de noticias (IDs vistos en memoria) ──
const noticiasVistas = new Set();
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

async function publicarCanal(texto, portadaFileId = null) {
  if (portadaFileId) {
    const res = await fetch(`${API()}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        photo: portadaFileId,
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      console.warn("⚠️ sendPhoto falló:", JSON.stringify(json));
      throw new Error(`sendPhoto falló: ${json.description || JSON.stringify(json)}`);
    }
  }
  await enviarTelegram(texto + xFooter());
}

// ──────────────────────────────────────────────
// COMANDOS
// ──────────────────────────────────────────────

// /flash <tema> — alerta urgente al canal + X
async function cmdFlash(chatId, tema, portadaFileId = null) {
  if (!tema) return reply(chatId, "❓ Uso: /flash <tema o noticia>\n\nTip: manda una foto con <code>/flash tema</code> en el pie para publicarla como portada.");
  await reply(chatId, "⚡ Generando flash...");

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 700,
    system: `Eres CriptoScope. Analista senior, voz directa y fría.

Genera el flash en este formato EXACTO (responde SOLO el contenido, sin etiquetas ni explicaciones):

GANCHO: [1 frase impactante sobre el tema. Puede ser una afirmación rotunda, la conclusión clave o la pregunta que deja el hecho sobre la mesa.]
CUERPO: [2 párrafos de análisis con implicaciones, contexto y qué vigilar. HTML Telegram: <b>, <i>. 1-2 emojis funcionales máx: 📊🔴🟢⚠️🎯]

REGLA CRÍTICA: NUNCA menciones un precio específico de BTC, ETH u otra moneda si ese precio no aparece textualmente en el TEMA. No lo inventes, no lo estimes, no lo deduzcas. Si el tema no tiene precio concreto, el análisis no lo tiene. Usa "el precio actual" si necesitas referirte a él.
Voz activa. Frases cortas. PROHIBIDO: guiones (– o —), 🚀💎🙌, clickbait, consejos financieros.`,
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
  const symbol = symbolRaw.toUpperCase().replace("USDT", "").replace("/USDT", "").replace("/USD", "") + "USDT";
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

    // Gráfico de velas 4H con EMA20/EMA50 via quickchart.io
    if (datos.velas4h?.length) {
      try {
        const chartUrl = generarGraficoUrl(datos);
        const imgRes = await fetch(chartUrl, { signal: AbortSignal.timeout(12000) });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const form = new FormData();
          form.append("chat_id", chatId.toString());
          form.append("photo", new Blob([buf], { type: "image/png" }), "chart.png");
          await fetch(`${API()}/sendPhoto`, { method: "POST", body: form });
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
  const labels   = velasData.map((v) => new Date(v.time).getTime());
  const candles  = velasData.map((v) => ({
    x: new Date(v.time).getTime(),
    o: +v.open.toFixed(2), h: +v.high.toFixed(2),
    l: +v.low.toFixed(2),  c: +v.close.toFixed(2),
  }));
  const ema20Data = (ema20arr || []).map((y, i) => ({ x: labels[i], y: +y.toFixed(2) }));
  const ema50Data = (ema50arr || []).map((y, i) => ({ x: labels[i], y: +y.toFixed(2) }));
  return {
    type: "candlestick",
    data: {
      datasets: [
        { label: `${nombre}/USDT ${tf}`, data: candles,
          color: { up: "rgba(38,166,154,0.9)", down: "rgba(239,83,80,0.9)", unchanged: "#888" } },
        { type: "line", label: "EMA20", data: ema20Data, borderColor: "#ffc107", borderWidth: 1.5, pointRadius: 0, fill: false },
        { type: "line", label: "EMA50", data: ema50Data, borderColor: "#2196f3", borderWidth: 1.5, pointRadius: 0, fill: false },
      ],
    },
    options: {
      scales: { x: { type: "time" }, y: { position: "right" } },
      plugins: { legend: { display: true, labels: { color: "#ddd" } } },
    },
  };
}

// Usa POST (sin límite de URL) para obtener la imagen PNG del gráfico
async function fetchGraficoBuffer(chartConfig) {
  if (!chartConfig) return null;
  const res = await fetch("https://quickchart.io/chart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chart: chartConfig, width: 800, height: 420, backgroundColor: "#1e1e2e", format: "png" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`quickchart ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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

  const limitMap = { "15m": 96, "1h": 120, "4h": 60, "1d": 60 };
  const limit    = limitMap[tf] || 60;

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

    // Enviar gráfico via POST (sin límite de URL) — capturar file_id para la publicación
    let chartFileId = null;
    try {
      const chartConfig = buildChartConfig(nombre, slice, ema20s, ema50s, tfLabel);
      const buf = await fetchGraficoBuffer(chartConfig);
      if (buf) {
        const form = new FormData();
        form.append("chat_id", chatId.toString());
        form.append("photo", new Blob([buf], { type: "image/png" }), "chart.png");
        form.append("caption", `📊 <b>${nombre}/USDT ${tfLabel}</b> · EMA20 🟡 EMA50 🔵 · OKX`);
        form.append("parse_mode", "HTML");
        const photoRes  = await fetch(`${API()}/sendPhoto`, { method: "POST", body: form });
        const photoJson = await photoRes.json();
        if (photoJson.ok) {
          chartFileId = photoJson.result.photo.at(-1).file_id;
        } else {
          console.warn("⚠️ sendPhoto falló:", photoJson.description);
        }
      }
    } catch (chartErr) {
      console.warn("⚠️ Gráfico fallido:", chartErr.message);
      await reply(chatId, `⚠️ No pude generar el gráfico (${chartErr.message}), pero el análisis sigue...`);
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
    system: `Eres CriptoScope. Resume el estado del mercado ahora mismo en 3-4 frases directas. Abre con el dato más relevante, no con contexto. Qué domina, qué vigilar, si hay oportunidad o no. Niveles exactos cuando los haya. Voz activa. PROHIBIDO: guiones medios o largos (– o —), rodeos, emojis decorativos, consejos de compra/venta.`,
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

  const nAlertas = alertasPrecios.filter((a) => a.chatId === chatId).length;
  const nProgramadas = [...programadas.values()].filter((p) => p.chatId === chatId).length;

  const msg =
    `⚙️ <b>Estado CriptoScope</b>\n\n` +
    `🕐 Hora Madrid: <b>${madridHora}</b>\n` +
    `${pausado ? "⏸ Publicaciones: <b>PAUSADAS</b>" : "▶️ Publicaciones: <b>ACTIVAS</b>"}\n` +
    `🔔 Alertas de precio activas: <b>${nAlertas}</b>\n` +
    `⏰ Publicaciones programadas: <b>${nProgramadas}</b>\n\n` +
    `<b>Automático:</b>\n` +
    `☕ Briefing: 07:00 diario → Telegram + X\n` +
    `📊 Señales (7 monedas):\n` +
    `   🌅 07:00 Radar de apertura — sesgo del día y nivel clave\n` +
    `   📈 11:00 Pulso técnico — momentum 1H RSI/MACD\n` +
    `   ⚡ 15:00 On-chain y derivados — funding, OI, posicionamiento\n` +
    `   🌙 19:00 Cierre europeo — balance del día + nivel asiático\n` +
    `📅 Resumen semanal: domingos 09:00\n` +
    `🚨 Monitor eventos: cada 30 min\n` +
    `🔔 Check alertas precio: cada 5 min\n` +
    `📰 Monitor RSS: cada 15 min (CoinDesk · CT · The Block · Decrypt · BeInCrypto · The Defiant)\n` +
    `   Botones: ⚡ Flash · 📝 Hilo · 🐦 Tweet X (directo a X) · 🙈 Ignorar\n` +
    `🔔 Señales: alerta privada al owner cuando una señal toca TP1/TP2/SL\n` +
    `🔗 Webhook TradingView: activo en /webhook/tradingview\n\n` +
    `<b>Publicación manual (preview + botones):</b>\n` +
    `<code>/flash</code> · <code>/hilo</code> · <code>/analiza</code> · <code>/opinion</code> · <code>/encuesta</code> · <code>/semanal</code>\n` +
    `<i>Canal / X / Canal+X / 🟡 Binance Square / 📊 CMC Community</i>\n` +
    `<i>/analiza incluye gráfico de velas 4H + EMA20/50</i>\n\n` +
    `<b>Privado (solo te responde a ti):</b>\n` +
    `<code>/precio</code> · <code>/quepasa</code> · <code>/senal</code> · <code>/calendario</code>\n` +
    `<code>/alerta</code> · <code>/alertas</code> · <code>/borralalerta</code>\n` +
    `<code>/programar</code> · <code>/programadas</code> · <code>/cancelar</code>\n\n` +
    `<b>Sistema:</b>\n` +
    `<code>/pausa</code> · <code>/activa</code> · <code>/estado</code> · <code>/ayuda</code>\n\n` +
    `<i>📒 Todo queda registrado en Notion (Publicaciones · Señales · Briefings)</i>\n` +
    (process.env.X_PROFILE_URL ? `🐦 Cuenta X: <a href="${process.env.X_PROFILE_URL}">${process.env.X_PROFILE_URL.replace("https://x.com/", "@")}</a>` : "");
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

  // Detecta monedas en el texto y devuelve hashtags (máx 3)
  const extraerHashtags = (texto) => {
    const monedas = [
      ["#BTC", ["BTC", "Bitcoin", "bitcoin"]],
      ["#ETH", ["ETH", "Ethereum", "ethereum"]],
      ["#SOL", ["SOL", "Solana", "solana"]],
      ["#XRP", ["XRP", "Ripple", "ripple"]],
      ["#BNB", ["BNB", "Binance"]],
      ["#AVAX", ["AVAX", "Avalanche"]],
      ["#DOGE", ["DOGE", "Dogecoin"]],
      ["#ADA", ["ADA", "Cardano"]],
      ["#DOT", ["DOT", "Polkadot"]],
      ["#LINK", ["LINK", "Chainlink"]],
      ["#SUI", ["SUI"]],
      ["#TON", ["TON", "Toncoin"]],
    ];
    const tags = [];
    for (const [tag, keywords] of monedas) {
      if (keywords.some((k) => texto.includes(k))) tags.push(tag);
      if (tags.length >= 3) break;
    }
    tags.push("#Crypto");
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
      return await subirImagenX(buffer, "image/jpeg");
    } catch (e) {
      console.warn("⚠️ No se pudo subir portada a X:", e.message);
      return null;
    }
  };

  // Genera un tweet nativo para X usando Claude — formato y tono propios de Twitter
  const generarTweetX = async (texto) => {
    const limpio = texto.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    try {
      const res = await client.messages.create({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `Eres el redactor de X/Twitter de CriptoScope, cuenta de análisis cripto en español.

Contenido del canal de Telegram:

${limpio.slice(0, 1500)}

Escribe UN tweet con este formato EXACTO (dos bloques separados por salto de línea):

LÍNEA 1 — TÍTULO: frase de gancho (≤100 chars). Dato impactante, pregunta provocadora o afirmación fuerte. 1 emoji al inicio si encaja.
LÍNEA 2 — CUERPO: 1-2 datos o ideas clave del análisis (≤140 chars). Sin repetir el título.

Reglas:
- NO menciones "canal de Telegram" ni pongas links
- PROHIBIDO guiones medios o largos (– o —). Sin etiquetas HTML.
- Total máximo 240 caracteres entre título y cuerpo
- Máximo 2 emojis en todo el tweet

Devuelve SOLO título + salto de línea + cuerpo. Sin comillas, sin etiquetas, sin explicaciones.`,
        }],
      });
      const tweet = res.content[0].text.trim();
      return tweet.length <= 270 ? tweet : tweet.slice(0, 267).replace(/\s+\S*$/, "...");
    } catch {
      // Fallback: primera línea con contenido real
      const lineas = limpio.split("\n").filter((l) => l.length > 30 && /[a-záéíóúñ]/.test(l) && !["CriptoScope", "consejo financiero", "FLASH", "ALERTA"].some((e) => l.toUpperCase().includes(e)));
      const fb = lineas[0] || limpio;
      return fb.length <= 270 ? fb : fb.slice(0, 267).replace(/\s+\S*$/, "...");
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
      let tweetsX;
      if (hilosPendientes.has(pid)) {
        // Hilo: publicar los tweets originales como thread real en X (sin pasar por generarTweetX)
        tweetsX = hilosPendientes.get(pid).map((t) => t.trim());
        // Añadir hashtags al último tweet del hilo
        tweetsX[tweetsX.length - 1] += `\n\n${hashtags}`;
      } else {
        // Flash, opinión, analiza, semanal: generar tweet nativo con título+cuerpo
        const contenido = await generarTweetX(msg);
        tweetsX = [`${contenido}\n\n${hashtags}`];
      }
      try {
        await publicarThread(tweetsX, { mediaId });
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
    const contenido = await generarTweetX(titulo);
    const hashtags = extraerHashtags(titulo);
    const tweetFinal = `${contenido}\n\n${hashtags}`;

    try {
      await publicarThread([tweetFinal]);
      guardarPublicacionEnNotion({
        tipo: "Flash",
        titulo,
        texto: tweetFinal,
        plataforma: "X",
        conPortada: false,
        estado: "Publicado",
      }).catch(() => {});
      await reply(chatId, `✅ Tweet publicado en X:\n\n<code>${tweetFinal.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`);
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
        "Consulta privada — no publica en el canal. Perfecto para cuando llevas horas sin mirar el mercado y quieres ponerte al día en segundos.",
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
        "Muestra los eventos macroeconómicos de alto impacto de la semana: Fed, CPI, NFP, FOMC, datos de empleo... con fecha y hora exacta en Madrid.\n\n" +
        "El sistema ya los incluye automáticamente en el briefing matinal, pero puedes consultarlos aquí en cualquier momento. Útil antes de abrir posiciones para saber si hay riesgo de volatilidad macro.",
    },
    estado: {
      titulo: "⚙️ /estado — Estado del sistema",
      uso: "/estado",
      ejemplo: "/estado",
      detalle:
        "Te muestra el estado completo: hora de Madrid, publicaciones activas/pausadas, alertas activas, publicaciones programadas y próximos automáticos.\n\n" +
        "Automáticos diarios:\n" +
        "☕ 07:00 Briefing matinal → canal + X\n" +
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
        "Configura tus keywords en MONITOR_KEYWORDS en Railway (separadas por comas).",
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
    `<code>/estado</code> · <code>/pausa</code> · <code>/activa</code> · <code>/ayuda</code>`;

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
        const guid = get("guid") || get("link");
        return { guid, titulo: get("title"), link: get("link"), fuente: fuente.nombre };
      });

      for (const item of items) {
        if (!item.guid || noticiasVistas.has(item.guid)) continue;
        noticiasVistas.add(item.guid);

        const coincide = KEYWORDS_NOTICIAS.some((k) => item.titulo.toLowerCase().includes(k));
        if (!coincide) continue;

        const nid = cachearNoticia(item.titulo, item.link);
        await fetch(`${API()}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: OWNER(),
            text: `📰 <b>${item.fuente}</b>\n\n<b>${item.titulo}</b>\n\n<a href="${item.link}">Ver artículo</a>`,
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

// /semanal — resumen semanal bajo demanda con preview + botones
async function cmdSemanal(chatId) {
  await reply(chatId, "📊 Generando resumen semanal...");
  try {
    const { mensaje } = await ejecutarResumenSemanal();
    const pid = Date.now().toString(36);
    pendingPublish.set(pid, mensaje);
    setTimeout(() => pendingPublish.delete(pid), 30 * 60 * 1000);
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
    const cmdPortada = cap.match(/^\/?(flash|hilo|opinion|analiza)\s+(.+)/i);
    if (cmdPortada) {
      const tipo = cmdPortada[1].toLowerCase();
      const argPortada = cmdPortada[2].trim();
      await reply(chatId, `📸 Portada recibida. Generando ${tipo}...`);
      try {
        if (tipo === "flash") await cmdFlash(chatId, argPortada, fileId);
        else if (tipo === "hilo") await cmdHilo(chatId, argPortada, fileId);
        else if (tipo === "opinion") await cmdOpinion(chatId, argPortada, fileId);
        else if (tipo === "analiza") await cmdAnaliza(chatId, argPortada, fileId);
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
      case "/flash":      await cmdFlash(chatId, argStr); break;
      case "/hilo":       await cmdHilo(chatId, argStr); break;
      case "/analiza":    await cmdAnaliza(chatId, argStr); break;
      case "/grafico":
      case "/grafica":   await cmdGrafico(chatId, argStr); break;
      case "/opinion":    await cmdOpinion(chatId, argStr); break;
      case "/precio":     await cmdPrecio(chatId, argStr); break;
      case "/quepasa":    await cmdQuePasa(chatId); break;
      case "/senal":
      case "/señal":      await cmdSenal(chatId, argStr); break;
      case "/calendario": await cmdCalendario(chatId); break;
      case "/estado":     await cmdEstado(chatId); break;
      case "/pausa":      await cmdPausa(chatId); break;
      case "/activa":     await cmdActiva(chatId); break;
      case "/alerta":       await cmdAlerta(chatId, argStr); break;
      case "/alertas":      await cmdAlertas(chatId); break;
      case "/borralalerta": await cmdBorrarAlerta(chatId, argStr); break;
      case "/programar":    await cmdProgramar(chatId, argStr); break;
      case "/programadas":  await cmdProgramadas(chatId); break;
      case "/cancelar":     await cmdCancelar(chatId, argStr); break;
      case "/encuesta":     await cmdEncuesta(chatId, argStr); break;
      case "/semanal":      await cmdSemanal(chatId); break;
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
        { command: "encuesta",     description: "Generar encuesta para el canal basada en el mercado" },
        { command: "ayuda",        description: "Guía detallada de todos los comandos" },
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
