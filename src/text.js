// ============================================================
// text.js - Utilidades de texto compartidas
// ============================================================

// Corta un texto en el límite de frase más cercano (punto, interrogación,
// exclamación) en vez de partir a mitad de palabra. Si no hay un límite
// razonablemente cerca del final, corta la última palabra parcial con "…".
export function cortarEnFrase(texto, maxLen) {
  if (texto.length <= maxLen) return texto;
  const recorte = texto.slice(0, maxLen);
  const puntos = [
    recorte.lastIndexOf(". "), recorte.lastIndexOf("? "), recorte.lastIndexOf("! "),
    recorte.lastIndexOf(".\n"), recorte.lastIndexOf("?\n"), recorte.lastIndexOf("!\n"),
  ];
  const fin = Math.max(...puntos);
  if (fin > maxLen * 0.55) return recorte.slice(0, fin + 1).trimEnd();
  return recorte.replace(/\s+\S*$/, "…");
}

// Tickers que convertimos en cashtag ($BTC) al publicar en X.
// X solo permite UN cashtag por tuit (error 403 "Posts are limited to a
// maximum of one cashtag" si hay más de uno) — por eso solo se cashtaguea
// la PRIMERA mención; el resto de tickers (aunque ya llevaran $ escrito
// por Claude) se dejan en texto plano. Los hashtags de cierre (#BTC) no
// cuentan para este límite y quedan siempre intactos.
const TICKERS = [
  "BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "AVAX", "LINK", "DOGE", "MSTR",
  "DOT", "MATIC", "LTC", "TRX", "TON", "ARB", "OP", "ATOM", "NEAR", "SUI", "APT", "SHIB", "PEPE", "UNI",
];
const PATRON_TICKERS = new RegExp(`(?<![#\\w])(\\$)?\\b(${TICKERS.join("|")})\\b`, "g");

export function aCashtags(texto) {
  if (!texto) return texto;
  let asignado = false;
  return texto.replace(PATRON_TICKERS, (match, dolar, ticker) => {
    if (asignado) return ticker; // ya hay un cashtag: el resto en texto plano
    asignado = true;
    return `$${ticker}`;
  });
}
