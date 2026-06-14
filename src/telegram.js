// ============================================================
// telegram.js - Publicación en el canal de Telegram
// ============================================================

const TG_BASE = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const LIMITE_TELEGRAM = 4000; // El límite real es 4096; dejamos margen

/**
 * Envía un mensaje al canal/chat configurado.
 * Si supera el límite de Telegram, lo trocea por párrafos.
 */
export async function enviarTelegram(texto, { silencioso = false } = {}) {
  const trozos = trocear(texto, LIMITE_TELEGRAM);

  for (const trozo of trozos) {
    const res = await fetch(`${TG_BASE()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: trozo,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: silencioso,
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      // Reintento sin HTML por si el formato rompe el parseo de Telegram
      const retry = await fetch(`${TG_BASE()}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: trozo.replace(/<[^>]+>/g, ""),
          disable_web_page_preview: true,
        }),
      });
      const retryData = await retry.json();
      if (!retryData.ok) {
        throw new Error(`Telegram error: ${JSON.stringify(retryData)}`);
      }
    }
  }
}

/** Trocea texto largo respetando párrafos */
function trocear(texto, max) {
  if (texto.length <= max) return [texto];

  const trozos = [];
  let actual = "";
  for (const parrafo of texto.split("\n\n")) {
    if ((actual + "\n\n" + parrafo).length > max) {
      if (actual) trozos.push(actual);
      actual = parrafo;
    } else {
      actual = actual ? actual + "\n\n" + parrafo : parrafo;
    }
  }
  if (actual) trozos.push(actual);
  return trozos;
}
