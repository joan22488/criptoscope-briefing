// ============================================================
// twitter.js - Tweets de cuentas clave via Nitter RSS
// Prueba múltiples instancias públicas con fallback automático
// ============================================================

const INSTANCIAS_NITTER = [
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.lucabased.xyz",
  "https://nitter.woodland.cafe",
  "https://nitter.mint.lgbt",
];

const CUENTAS = [
  "saylor", "APompliano", "RaoulGMI", "novogratz", "CryptoHayes",
  "woonomic", "WClementeIII", "nic__carter", "PeterLBrandt",
  "HsakaTrades", "tedtalksmacro", "MustStopMurad",
  "CoinDesk", "Cointelegraph", "TheBlock__",
];

let instanciaActiva = null;

async function detectarInstancia() {
  if (instanciaActiva) return instanciaActiva;
  for (const base of INSTANCIAS_NITTER) {
    try {
      const res = await fetch(`${base}/saylor/rss`, {
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.ok && res.headers.get("content-type")?.includes("xml")) {
        instanciaActiva = base;
        return base;
      }
    } catch {}
  }
  return null;
}

function parsearRSS(xml, cuenta) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return items.slice(0, 3).map((m) => {
    const bloque = m[1];
    const get = (tag) => {
      const match = bloque.match(new RegExp(`<${tag}[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/${tag}>`, "s"));
      return match ? match[1].trim() : "";
    };
    const texto = get("title");
    const isRT = texto.startsWith("RT @");
    return { autor: cuenta, texto, fecha: get("pubDate"), url: get("link"), isRT };
  });
}

export async function getTweetsRelevantes() {
  try {
    const base = await detectarInstancia();
    if (!base) {
      console.warn("⚠️  Nitter: ninguna instancia disponible");
      return [];
    }
    console.log(`🐦 Obteniendo tweets via Nitter (${base})...`);

    const resultados = await Promise.allSettled(
      CUENTAS.map(async (cuenta) => {
        const res = await fetch(`${base}/${cuenta}/rss`, {
          signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!res.ok) return [];
        const xml = await res.text();
        return parsearRSS(xml, cuenta);
      })
    );

    const tweets = resultados
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter((t) => t.texto && !t.isRT)
      .slice(0, 20);

    console.log(`   ✓ ${tweets.length} tweets capturados`);
    return tweets;
  } catch (e) {
    console.warn("⚠️  Tweets no disponibles:", e.message);
    return [];
  }
}
