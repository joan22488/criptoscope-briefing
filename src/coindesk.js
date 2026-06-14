// ============================================================
// coindesk.js - Obtención de datos de mercado y noticias
// Fuentes: CoinGecko (precios) | CryptoPanic (noticias) | Binance (derivados)
// Todas gratuitas, sin API key
// ============================================================

async function apiFetch(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * 1) NOTICIAS - RSS de CoinDesk parseado directamente (sin key)
 */
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
      return {
        titulo: get("title"),
        resumen: get("description").replace(/<[^>]+>/g, "").slice(0, 400),
        fuente: "CoinDesk",
        fecha: get("pubDate"),
        categorias: get("category"),
        url: get("link"),
      };
    });
  } catch (e) {
    console.warn("⚠️  Noticias no disponibles:", e.message);
    return [];
  }
}

/**
 * 2) PRECIOS SPOT - CoinGecko (gratis, sin key)
 */
export async function getPrices() {
  const data = await apiFetch(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&sparkline=false&price_change_percentage=24h"
  );
  const out = {};
  for (const coin of data) {
    const key = coin.id === "bitcoin" ? "BTC-USD" : "ETH-USD";
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
  const [noticias, precios, funding, openInterest, gainersLosers, fearGreed, globalMarket, liquidaciones] = await Promise.all([
    getNews(),
    getPrices(),
    getFunding(),
    getOpenInterest(),
    getGainersLosers(),
    getFearGreed(),
    getGlobalMarket(),
    getLiquidaciones(),
  ]);

  return {
    generado: new Date().toISOString(),
    precios,
    derivados: { funding, openInterest },
    sentimiento: { fearGreed, liquidaciones },
    mercadoGlobal: globalMarket,
    gainersLosers, // usado solo en pipeline.js para Telegram, no se pasa a Claude
    noticias,
  };
}
