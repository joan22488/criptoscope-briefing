// ============================================================
// x-replies.js - Sistema de borradores de respuesta en X
//
// MODO A (automático): requiere X API Basic plan ($100/mes)
//   → GET /2/users/:id/mentions cada 30 min
//
// MODO B (manual): el owner reenvía el comentario al bot
//   → /reply <texto del comentario>
//
// En ambos modos, Claude genera el borrador y lo envía
// al owner en Telegram para que lo apruebe antes de publicar.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { TwitterApi } from "twitter-api-v2";
import { loadJSON, saveJSON } from "./storage.js";
import { cortarEnFrase, aCashtags } from "./text.js";
import { registrarEscrituraX } from "./twitter-post.js";

const client = new Anthropic();

const loadState = () => loadJSON("x_state.json", {});
const saveState = (state) => saveJSON("x_state.json", state);

function getClient() {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY) throw new Error("X_API_KEY no configurado");
  return new TwitterApi({ appKey: X_API_KEY, appSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET });
}

// Genera un borrador de respuesta con Claude en la voz de CriptoScope
export async function generarBorradorRespuesta({ comentario, tweetOriginal = "", autor = "" }) {
  const contexto = tweetOriginal ? `\n\nTweet original al que responde:\n"${tweetOriginal}"` : "";
  const autorStr = autor ? `@${autor} ` : "";

  const prompt = `Eres el community manager de CriptoScope, análisis cripto en español. Alguien ha respondido a un tweet de CriptoScope.

Comentario recibido de ${autorStr}:
"${comentario}"${contexto}

Escribe UNA respuesta directa, bien argumentada y en la voz de CriptoScope. Entre 180 y 210 caracteres (deja margen, no lo apures: si te pasas, se corta). Tono: educado pero firme, analítico, sin condescender. Si el comentario tiene razón en algo, reconócelo. Si está equivocado, corrígelo con datos. Si es una pregunta, respóndela directamente. Termina la idea con un punto, no la dejes a medias.

X solo admite 1 cashtag por tuit: escribe $ delante SOLO de la primera moneda que menciones, el resto de tickers en texto normal sin $.

PROHIBIDO: emojis tribales (🚀💎🙌), lenguaje de hype, respuestas vagas ("Buen punto", "Gracias"), guiones largos (– o —), links, hashtags, mencionar Telegram.

Devuelve SOLO la respuesta. Sin comillas ni etiquetas.`;

  const res = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });
  return aCashtags(cortarEnFrase(res.content[0].text.trim(), 240));
}

// Publica una respuesta a un tweet concreto
export async function publicarRespuestaX(tweetId, texto) {
  const xClient = getClient();
  const result = await xClient.readWrite.v2.tweet(texto, {
    reply: { in_reply_to_tweet_id: tweetId },
  });
  registrarEscrituraX(1);
  return result.data.id;
}

// Obtiene el userId propio (para filtrar menciones que son replies a tweets propios)
let cachedUserId = null;
async function getOwnUserId() {
  if (cachedUserId) return cachedUserId;
  const xClient = getClient();
  const me = await xClient.readWrite.v2.me();
  cachedUserId = me.data.id;
  return cachedUserId;
}

// Modo A: fetch de menciones nuevas (requiere Basic plan)
// Devuelve array de { mentionId, texto, autorUsername, tweetOriginalId, tweetOriginalTexto }
export async function fetchMencionesNuevas() {
  const state = loadState();
  const xClient = getClient();
  const userId = await getOwnUserId();

  const params = {
    max_results: 10,
    "tweet.fields": "conversation_id,author_id,text,created_at,in_reply_to_user_id",
    expansions: "author_id,referenced_tweets.id",
    "user.fields": "username",
  };
  if (state.last_mention_id) params.since_id = state.last_mention_id;

  let timeline;
  try {
    timeline = await xClient.readOnly.v2.userMentionTimeline(userId, params);
  } catch (e) {
    // Free tier lanza 403 aquí — el caller decide si alertar
    throw new Error(`mentions_api_error: ${e.message}`);
  }

  if (!timeline.data?.data?.length) return [];

  // Guardar el id más reciente para la próxima llamada
  const newest = timeline.data.data[0].id;
  saveState({ ...state, last_mention_id: newest });

  const usuarios = {};
  for (const u of (timeline.data.includes?.users || [])) usuarios[u.id] = u.username;

  const tweetReferenciados = {};
  for (const t of (timeline.data.includes?.tweets || [])) tweetReferenciados[t.id] = t.text;

  // Solo nos interesan las menciones que son replies directas (in_reply_to_user_id = nuestro userId)
  const menciones = [];
  for (const tweet of timeline.data.data) {
    if (tweet.in_reply_to_user_id !== userId) continue;
    const refId = tweet.referenced_tweets?.find((r) => r.type === "replied_to")?.id;
    menciones.push({
      mentionId:           tweet.id,
      texto:               tweet.text,
      autorUsername:       usuarios[tweet.author_id] || tweet.author_id,
      tweetOriginalId:     refId || null,
      tweetOriginalTexto:  refId ? (tweetReferenciados[refId] || "") : "",
    });
  }

  return menciones;
}
