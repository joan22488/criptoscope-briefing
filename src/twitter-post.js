// ============================================================
// twitter-post.js - Publicar thread en X/Twitter
// Requiere en .env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
// Obtener en: https://developer.twitter.com/en/portal/dashboard
// El tier Free de X limita las publicaciones mensuales — el contador
// de abajo lleva la cuenta (límite configurable con X_MONTHLY_LIMIT).
// ============================================================

import { TwitterApi } from "twitter-api-v2";
import { loadJSON, saveJSON } from "./storage.js";
import { cortarEnFrase, aCashtags, limpiarDashes } from "./text.js";

// Extrae el detalle real de un error de la API de X (twitter-api-v2 adjunta
// el cuerpo JSON del error en e.data). "Request failed with code 403" solo
// dice el código HTTP — esto añade el motivo real (permisos, duplicado, etc.)
export function detalleErrorX(e) {
  const partes = [e.message];
  if (e.data?.detail) partes.push(e.data.detail);
  if (e.data?.title && e.data.title !== e.data.detail) partes.push(e.data.title);
  if (Array.isArray(e.data?.errors)) partes.push(e.data.errors.map((x) => x.message).filter(Boolean).join("; "));
  if (e.code) partes.push(`HTTP ${e.code}`);
  return [...new Set(partes.filter(Boolean))].join(" — ");
}

// ── Contador de escrituras mensuales en X ────────────────────
// Cada tweet publicado (único, de thread o reply) cuenta 1.
const mesActual = () => new Date().toISOString().slice(0, 7); // "2026-07"

export function registrarEscrituraX(n = 1) {
  const data = loadJSON("x_writes.json", {});
  const mes = mesActual();
  data[mes] = (data[mes] || 0) + n;
  const claves = Object.keys(data).sort();
  while (claves.length > 3) delete data[claves.shift()]; // conservar 3 meses
  saveJSON("x_writes.json", data);
  const limite = parseInt(process.env.X_MONTHLY_LIMIT || "500");
  if (data[mes] >= limite * 0.8) {
    console.warn(`⚠️ X: ${data[mes]}/${limite} tweets este mes (${Math.round((data[mes] / limite) * 100)}% del límite)`);
  }
  return data[mes];
}

export function getEscriturasXMes() {
  const data = loadJSON("x_writes.json", {});
  return data[mesActual()] || 0;
}

// Hashtags para el thread del briefing: base fija + contextuales según contenido
function generarHashtagsBriefing(tweets) {
  const texto = tweets.join(" ").toLowerCase();
  const tags  = ["#Bitcoin", "#BTC", "#Cripto"]; // base siempre

  const contextuales = [
    ["#Ethereum",  ["ethereum", " eth "]],
    ["#Solana",    ["solana", " sol "]],
    ["#XRP",       [" xrp ", "ripple"]],
    ["#ETF",       ["etf"]],
    ["#Fed",       ["fed ", "fomc", "powell", "federal reserve"]],
    ["#CPI",       ["cpi", "inflaci"]],
    ["#Macro",     ["macro", "nfp", "empleo", "gdp", "pib"]],
    ["#Análisis",  []], // siempre añadir como tag editorial
  ];

  for (const [tag, keywords] of contextuales) {
    if (tags.length >= 6) break;
    if (!keywords.length || keywords.some((k) => texto.includes(k))) tags.push(tag);
  }

  return tags.join(" ");
}

function getClient() {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
    throw new Error("Credenciales X no configuradas (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET)");
  }
  return new TwitterApi({
    appKey: X_API_KEY,
    appSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET,
  });
}

// Subir imagen a Twitter desde un buffer y devolver el media_id
export async function subirImagenX(buffer, mimeType = "image/jpeg") {
  if (!process.env.X_API_KEY) return null;
  const client = getClient();
  const mediaId = await client.v1.uploadMedia(buffer, { mimeType });
  return mediaId;
}

// Publica un único tweet con hashtags automáticos (para briefing y señales)
export async function publicarTweetUnico(texto, { mediaId } = {}) {
  if (!process.env.X_API_KEY) {
    console.log("ℹ️  X posting no configurado — saltando");
    return null;
  }

  const client   = getClient();
  const rwClient = client.readWrite;
  const limpiar  = (t) => limpiarDashes(t.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim());

  const hashtags = generarHashtagsBriefing([texto]);
  const cuerpo   = aCashtags(limpiar(texto));

  // Reservar espacio para los hashtags al final
  const espacio    = 280 - hashtags.length - 2; // 2 = "\n\n"
  const cuerpoFinal = cortarEnFrase(cuerpo, espacio);
  const tweetFinal = `${cuerpoFinal}\n\n${hashtags}`;

  const payload = mediaId ? { media: { media_ids: [mediaId] } } : undefined;
  const result  = await rwClient.v2.tweet(tweetFinal, payload);

  registrarEscrituraX(1);
  console.log(`✅ Tweet publicado en X`);
  return result.data.id;
}

export async function publicarThread(tweets, { mediaId } = {}) {
  if (!process.env.X_API_KEY) {
    console.log("ℹ️  X posting no configurado — saltando");
    return null;
  }
  if (!tweets?.length) return null;

  const client = getClient();
  const rwClient = client.readWrite;

  // Limpiar HTML del briefing para X (texto plano) + guiones/~ + convertir tickers a cashtag
  const limpiar = (t) => aCashtags(limpiarDashes(t.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()));

  // Primer tweet (con imagen si hay mediaId)
  const primerPayload = mediaId ? { media: { media_ids: [mediaId] } } : undefined;
  const primerTweet = await rwClient.v2.tweet(limpiar(tweets[0]).slice(0, 280), primerPayload);
  let ultimoId = primerTweet.data.id;
  registrarEscrituraX(1);

  // Resto como replies en cadena
  for (let i = 1; i < tweets.length; i++) {
    const texto = limpiar(tweets[i]).slice(0, 280);
    const reply = await rwClient.v2.tweet(texto, { reply: { in_reply_to_tweet_id: ultimoId } });
    ultimoId = reply.data.id;
    registrarEscrituraX(1);
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`✅ Thread publicado en X — ${tweets.length} tweets`);
  return primerTweet.data.id;
}
