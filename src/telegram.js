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

/** Trocea texto largo respetando párrafos, líneas y como último recurso caracteres */
function trocear(texto, max) {
  if (texto.length <= max) return [texto];

  // Intento 1: dividir por párrafos dobles
  const trozos = [];
  let actual = "";
  for (const parrafo of texto.split("\n\n")) {
    const sep = actual ? "\n\n" : "";
    if ((actual + sep + parrafo).length > max) {
      if (actual) trozos.push(actual.trim());
      // Si el párrafo solo es demasiado largo, subdividirlo por líneas simples
      if (parrafo.length > max) {
        const subtrozos = trocearLineas(parrafo, max);
        for (let i = 0; i < subtrozos.length - 1; i++) trozos.push(subtrozos[i].trim());
        actual = subtrozos[subtrozos.length - 1];
      } else {
        actual = parrafo;
      }
    } else {
      actual = actual + sep + parrafo;
    }
  }
  if (actual.trim()) trozos.push(actual.trim());
  return trozos.filter(Boolean);
}

function trocearLineas(texto, max) {
  if (texto.length <= max) return [texto];
  const trozos = [];
  let actual = "";
  for (const linea of texto.split("\n")) {
    const sep = actual ? "\n" : "";
    if ((actual + sep + linea).length > max) {
      if (actual) trozos.push(actual);
      // Si una sola línea es mayor que max, cortarla por caracteres
      actual = linea.length > max ? linea.slice(0, max) : linea;
      if (linea.length > max) { trozos.push(actual); actual = linea.slice(max); }
    } else {
      actual = actual + sep + linea;
    }
  }
  if (actual) trozos.push(actual);
  return trozos;
}
