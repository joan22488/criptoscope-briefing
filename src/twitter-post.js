// ============================================================
// twitter-post.js - Publicar thread en X/Twitter
// Requiere en .env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
// Obtener en: https://developer.twitter.com/en/portal/dashboard
// Plan gratuito de X Developer permite hasta 1500 tweets/mes
// ============================================================

import { TwitterApi } from "twitter-api-v2";

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

export async function publicarThread(tweets, { mediaId } = {}) {
  if (!process.env.X_API_KEY) {
    console.log("ℹ️  X posting no configurado — saltando");
    return null;
  }
  if (!tweets?.length) return null;

  const client = getClient();
  const rwClient = client.readWrite;

  // Limpiar HTML del briefing para X (texto plano)
  const limpiar = (t) => t.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

  // Primer tweet (con imagen si hay mediaId)
  const primerPayload = mediaId ? { media: { media_ids: [mediaId] } } : undefined;
  const primerTweet = await rwClient.v2.tweet(limpiar(tweets[0]).slice(0, 270), primerPayload);
  let ultimoId = primerTweet.data.id;

  // Resto como replies en cadena
  for (let i = 1; i < tweets.length; i++) {
    const texto = limpiar(tweets[i]).slice(0, 270);
    const reply = await rwClient.v2.tweet(texto, { reply: { in_reply_to_tweet_id: ultimoId } });
    ultimoId = reply.data.id;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Último tweet: CTA con enlace al canal de Telegram
  const canal = process.env.TELEGRAM_CANAL_URL || "https://t.me/criptoscopespain";
  const cta = `📊 Análisis diario, señales técnicas y alertas en tiempo real en nuestro canal de Telegram 👇\n${canal}`;
  await rwClient.v2.tweet(cta, { reply: { in_reply_to_tweet_id: ultimoId } });

  console.log(`✅ Thread publicado en X — ${tweets.length + 1} tweets (+ CTA Telegram)`);
  return primerTweet.data.id;
}
