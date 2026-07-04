// ============================================================
// coindesk.js - Obtención de datos de mercado y noticias
// Fuentes: CoinGecko (precios) | CryptoPanic (noticias) | Binance (derivados)
// Todas gratuitas, sin API key
// ============================================================

import { cortarEnFrase } from "./text.js";

async function apiFetch(url) {
  const headers = { Accept: "application/json" };
  if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * 1) NOTICIAS - RSS de CoinDesk parseado directamente (sin key)
 */
// Puntúa una noticia según su potencial editorial para X y Telegram
// Basado en el guion semanal: institucional + cifra + urgencia = viral
export function puntuarNoticia(noticia) {
  const texto = `${noticia.titulo} ${noticia.resumen || ""}`.toLowerCase();
  let score = 0;

  // Strategy/Saylor/MSTR = siempre viral: son el principal motor institucional del ciclo
  const estrategia = ["strategy", "microstrategy", "saylor", "\bmstr\b"];
  if (estrategia.some((k) => new RegExp(k).test(texto))) {
    return { score: 9, emoji: "🔥🔥🔥", etiqueta: "Viral para X" };
  }

  const institucional = ["etf", "grayscale", "blackrock", "sec", "fed", "federal reserve", "cpi", "nfp", "treasury", "jp morgan", "goldman", "fidelity", "ark invest", "vaneck", "invesco"];
  if (institucional.some((k) => texto.includes(k))) score += 3;

  if (/\$[\d,.]+\s*[mbk]?|[\d,.]+\s*(million|billion|millones|millardos)/i.test(texto)) score += 2;

  const urgencia = ["crash", "spike", "surges", "plummets", "ban", "hack", "exploit", "record", "récord", "all-time", "ath", "liquidat", "insolvent", "bankrupt", "seized", "arrest"];
  if (urgencia.some((k) => texto.includes(k))) score += 2;

  if (/bitcoin|\bbtc\b/.test(texto)) score += 1;
  if (/ethereum|\beth\b/.test(texto)) score += 1;

  const regulacion = ["regulation", "regulación", "congress", "senate", "executive order", "compliance", "prohibit", "ilegal"];
  if (regulacion.some((k) => texto.includes(k))) score += 1;

  if (score >= 6) return { score, emoji: "🔥🔥🔥", etiqueta: "Viral para X" };
  if (score >= 4) return { score, emoji: "🔥🔥",   etiqueta: "Buena para X" };
  if (score >= 2) return { score, emoji: "🔥",     etiqueta: "Canal Telegram" };
  return             { score, emoji: "⬜",          etiqueta: "Omitir" };
}

/**
 * Precio y cambio diario de MSTR (Strategy) — Yahoo Finance, gratis, sin key
 */
export async function getMSTRPrice() {
  try {
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/MSTR?interval=1d&range=2d",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; CriptoScope/1.0)" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const meta   = json.chart?.result?.[0]?.meta;
    const closes = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!meta || !closes) throw new Error("Sin datos");
    const precio  = meta.regularMarketPrice;
    const validos = closes.filter(Boolean);
    // Con menos de 2 cierres no hay referencia real de "anterior" — mejor omitir el dato que publicar un falso 0.00%
    if (validos.length < 2) throw new Error("Sin cierre anterior suficiente para calcular % MSTR");
    const anterior = validos.at(-2);
    const cambio   = ((precio - anterior) / anterior) * 100;
    return { precio: parseFloat(precio.toFixed(2)), cambio_pct: parseFloat(cambio.toFixed(2)) };
  } catch (e) {
    console.warn("⚠️  MSTR price no disponible:", e.message);
    return null;
  }
}

export async function getNews(limit = 25) {
  try {
    const res = await fetch("https://www.coindesk.com/arc/outboundfeeds/rss/", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CriptoScope/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);
    return items.map((m) => {
      const bloque = m[1];
      const get = (tag) => {
        const match = bloque.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, "s"));
        return match ? match[1].trim() : "";
      };
      const noticia = {
        titulo: get("title"),
        resumen: cortarEnFrase(get("description").replace(/<[^>]+>/g, ""), 400),
        fuente: "CoinDesk",
        fecha: get("pubDate"),
        categorias: get("category"),
        url: get("link"),
      };
      noticia.puntuacion = puntuarNoticia(noticia);
      return noticia;
    });
  } catch (e) {
    console.warn("⚠️  Noticias no disponibles:", e.message);
    return [];
  }
}

/**
 * 2) PRECIOS SPOT - Binance 24h ticker (sin key, sin restricciones de rate)
 * Fallback a CoinGecko si Binance falla
 */
export async function getPrices() {
  const data = await apiFetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&sparkline=false&price_change_percentage=24h"
  );
  const ID_MAP = { bitcoin: "BTC-USD", ethereum: "ETH-USD", solana: "SOL-USD" };
  const out = {};
  for (const coin of data) {
    const key = ID_MAP[coin.id];
    if (!key) continue;
    out[key] = {
      precio: coin.current_price,
      cambio24h_pct: coin.price_change_percentage_24h,
      maximo24h: coin.high_24h,
      minimo24h: coin.low_24h,
      volumen24h: coin.total_volume,
    };
  }
  return out;
}

/**
 * 3) FUNDING RATE - Binance Futures API pública (sin key)
 */
export async function getFunding() {
  try {
    const symbol = (process.env.MAIN_INSTRUMENT || "ETHUSDT")
      .replace("-USDT-VANILLA-PERPETUAL", "USDT")
      .replace(/-/g, "");
    const data = await apiFetch(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`
    );
    return { funding_rate: parseFloat(data.lastFundingRate), instrumento: data.symbol };
  } catch (e) {
    console.warn("⚠️  Funding no disponible:", e.message);
    return null;
  }
}

/**
 * 4) OPEN INTEREST - Binance Futures API pública (sin key)
 */
export async function getOpenInterest() {
  try {
    const symbol = (process.env.MAIN_INSTRUMENT || "ETHUSDT")
      .replace("-USDT-VANILLA-PERPETUAL", "USDT")
      .replace(/-/g, "");
    const data = await apiFetch(
      `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`
    );
    return { open_interest: parseFloat(data.openInterest), instrumento: data.symbol };
  } catch (e) {
    console.warn("⚠️  Open Interest no disponible:", e.message);
    return null;
  }
}

/**
 * 5) TOP GAINERS & LOSERS 24h - CoinGecko (top 200 por market cap, filtrados por movimiento)
 */
export async function getGainersLosers() {
  try {
    const data = await apiFetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=false&price_change_percentage=24h"
    );
    const validos = data.filter((c) => c.price_change_percentage_24h != null && c.total_volume > 5_000_000);
    const ordenados = [...validos].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h);
    const ganadores = ordenados.slice(0, 3).map((c) => ({
      simbolo: c.symbol.toUpperCase(),
      cambio: c.price_change_percentage_24h.toFixed(1),
    }));
    const perdedores = ordenados.slice(-3).reverse().map((c) => ({
      simbolo: c.symbol.toUpperCase(),
      cambio: c.price_change_percentage_24h.toFixed(1),
    }));
    return { ganadores, perdedores };
  } catch (e) {
    console.warn("⚠️  Gainers/Losers no disponibles:", e.message);
    return null;
  }
}

/**
 * 6) FEAR & GREED INDEX - alternative.me (gratis, sin key)
 */
export async function getFearGreed() {
  try {
    const data = await apiFetch("https://api.alternative.me/fng/?limit=2");
    const [hoy, ayer] = data.data;
    return {
      valor: parseInt(hoy.value),
      clasificacion: hoy.value_classification,
      ayer: parseInt(ayer.value),
      clasificacion_ayer: ayer.value_classification,
    };
  } catch (e) {
    console.warn("⚠️  Fear & Greed no disponible:", e.message);
    return null;
  }
}

/**
 * 7) DOMINANCIA BTC + datos globales - CoinGecko (gratis, sin key)
 */
export async function getGlobalMarket() {
  try {
    const data = await apiFetch("https://api.coingecko.com/api/v3/global");
    const g = data.data;
    return {
      dominancia_btc: parseFloat(g.market_cap_percentage.btc.toFixed(1)),
      dominancia_eth: parseFloat(g.market_cap_percentage.eth.toFixed(1)),
      market_cap_total_usd: g.total_market_cap.usd,
      cambio_market_cap_24h: parseFloat(g.market_cap_change_percentage_24h_usd.toFixed(2)),
      activos_activos: g.active_cryptocurrencies,
    };
  } catch (e) {
    console.warn("⚠️  Global market no disponible:", e.message);
    return null;
  }
}

/**
 * 8) LIQUIDACIONES recientes - OKX API pública (sin key)
 * Devuelve las últimas liquidaciones de BTC, ETH y SOL en perpetuos
 */
export async function getLiquidaciones() {
  try {
    const FAMILIAS = [
      { familia: "BTC-USDT", nombre: "BTC" },
      { familia: "ETH-USDT", nombre: "ETH" },
      { familia: "SOL-USDT", nombre: "SOL" },
    ];
    const hace24h = Date.now() - 24 * 60 * 60 * 1000;

    const resultados = await Promise.all(
      FAMILIAS.map(async ({ familia, nombre }) => {
        const url = `https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instFamily=${familia}&state=filled&limit=100`;
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.code !== "0") throw new Error(`OKX: ${json.msg}`);

        // OKX devuelve referencias $ref para datos repetidos — resolvemos el primero
        const base = json.data?.[0];
        if (!base?.details) return { nombre, longs: 0, shorts: 0, total: 0 };

        let longs = 0, shorts = 0;
        for (const d of base.details) {
          const ts = parseInt(d.ts || d.time || 0);
          if (ts < hace24h) continue;
          const valor = parseFloat(d.sz) * parseFloat(d.bkPx);
          // posSide "long" = posición larga liquidada, "short" = posición corta liquidada
          if (d.posSide === "long") longs += valor;
          else if (d.posSide === "short") shorts += valor;
        }
        return { nombre, longs, shorts, total: longs + shorts };
      })
    );

    const totalLongs = resultados.reduce((a, r) => a + r.longs, 0);
    const totalShorts = resultados.reduce((a, r) => a + r.shorts, 0);
    const totalTotal = totalLongs + totalShorts;

    const pctLongs = totalTotal > 0 ? (totalLongs / totalTotal) * 100 : 50;
    const sesgo = pctLongs > 60 ? "caza de longs" : pctLongs < 40 ? "caza de shorts" : "equilibrado";

    return {
      total_usd: totalTotal,
      longs_liq_usd: totalLongs,
      shorts_liq_usd: totalShorts,
      sesgo,
      por_par: resultados,
    };
  } catch (e) {
    console.warn("⚠️  Liquidaciones no disponibles:", e.message);
    return null;
  }
}

/**
 * Recopila TODO el contexto de mercado en un solo objeto.
 */
export async function getMarketContext() {
  const [noticias, precios, funding, openInterest, fearGreed, liquidaciones] = await Promise.all([
    getNews(),
    getPrices(),
    getFunding(),
    getOpenInterest(),
    getFearGreed(),
    getLiquidaciones(),
  ]);
  const [gainersLosers, globalMarket, mstr] = await Promise.all([
    getGainersLosers().catch(() => null),
    getGlobalMarket().catch(() => null),
    getMSTRPrice().catch(() => null),
  ]);

  return {
    generado: new Date().toISOString(),
    precios,
    derivados: { funding, openInterest },
    sentimiento: { fearGreed, liquidaciones },
    mercadoGlobal: globalMarket,
    gainersLosers,
    mstr,   // Strategy (MSTR) stock — indicador institucional clave
    noticias,
  };
}
