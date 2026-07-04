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
// No toca los que ya llevan $ o # delante (hashtags de cierre como #BTC quedan intactos).
const TICKERS = [
  "BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "AVAX", "LINK", "DOGE", "MSTR",
  "DOT", "MATIC", "LTC", "TRX", "TON", "ARB", "OP", "ATOM", "NEAR", "SUI", "APT", "SHIB", "PEPE", "UNI",
];
const PATRON_TICKERS = new RegExp(`(?<![$#\\w])(${TICKERS.join("|")})\\b`, "g");

export function aCashtags(texto) {
  if (!texto) return texto;
  return texto.replace(PATRON_TICKERS, "$$$1");
}
