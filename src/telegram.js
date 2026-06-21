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

const CAPTION_MAX = 1020;

function truncarCaption(texto, max = CAPTION_MAX) {
  if (texto.length <= max) return texto;
  const SUFIJO = " [...]";
  const disponible = max - SUFIJO.length;
  const recorte = texto.slice(0, disponible);
  const umbral = disponible * 0.55;
  const pos = Math.max(
    recorte.lastIndexOf("\n\n") > umbral ? recorte.lastIndexOf("\n\n") : -1,
    recorte.lastIndexOf(". ")  > umbral ? recorte.lastIndexOf(". ") + 1 : -1,
    recorte.lastIndexOf("\n")  > umbral ? recorte.lastIndexOf("\n")  : -1,
  );
  return (pos > 0 ? recorte.slice(0, pos) : recorte).trimEnd() + SUFIJO;
}

/**
 * Envía foto desde un file_id de Telegram ya almacenado (portada fija).
 * Misma lógica smart: si cabe → 1 mensaje; si no → foto con título + texto completo aparte.
 */
export async function enviarTelegramConFotoId(texto, fileId) {
  const cabe = texto.length <= CAPTION_MAX;
  const caption = cabe
    ? texto
    : texto.split("\n").filter(Boolean).slice(0, 2).join("\n").slice(0, 300);

  const res  = await fetch(`${TG_BASE()}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, photo: fileId, caption, parse_mode: "HTML" }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!data.ok) console.warn("⚠️ enviarTelegramConFotoId fallido:", data.description);

  if (!cabe) await enviarTelegram(texto);
}

/**
 * Envía foto desde buffer (portada generada) con lógica inteligente:
 * - Si el texto cabe en el caption (≤1020 chars) → UN solo mensaje foto+texto
 * - Si el texto es largo → foto con solo el título como caption + texto completo como mensaje siguiente
 */
export async function enviarTelegramConFoto(texto, fotoBuffer) {
  const cabe = texto.length <= CAPTION_MAX;
  const caption = cabe
    ? texto
    : texto.split("\n").filter(Boolean).slice(0, 2).join("\n").slice(0, 300);

  const form = new FormData();
  form.append("chat_id", process.env.TELEGRAM_CHAT_ID);
  form.append("photo", new Blob([fotoBuffer], { type: "image/png" }), "portada.png");
  form.append("caption", caption);
  form.append("parse_mode", "HTML");

  const res  = await fetch(`${TG_BASE()}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (!data.ok) {
    console.warn("⚠️ enviarTelegramConFoto: sendPhoto falló:", data.description);
  }

  // Si el texto no cabía en el caption, enviarlo completo como mensaje siguiente
  if (!cabe) await enviarTelegram(texto);
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
