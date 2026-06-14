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
 * 8) LIQUIDACIONES 24h - Coinglass API pública (sin key, endpoint público)
 */
export async function getLiquidaciones() {
  try {
    const res = await fetch("https://open-api.coinglass.com/public/v2/liquidation_history?symbol=BTC&time_type=h24", {
      headers: { "Accept": "application/json", "coinglassSecret": "" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error("Coinglass error");
    const total = data.data?.reduce((acc, x) => acc + (x.buyVolUsd || 0) + (x.sellVolUsd || 0), 0) || 0;
    const longs = data.data?.reduce((acc, x) => acc + (x.sellVolUsd || 0), 0) || 0;
    const shorts = data.data?.reduce((acc, x) => acc + (x.buyVolUsd || 0), 0) || 0;
    return { total_usd: total, longs_liq_usd: longs, shorts_liq_usd: shorts };
  } catch (e) {
    // Fallback: intenta endpoint alternativo
    try {
      const res2 = await fetch("https://open-api.coinglass.com/api/pro/v1/futures/liquidation/chart?symbol=BTC&interval=0", {
        headers: { "Accept": "application/json" },
      });
      if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
      const d2 = await res2.json();
      if (d2.data) {
        const recent = d2.data.slice(-24);
        const longs = recent.reduce((a, x) => a + (x[1] || 0), 0);
        const shorts = recent.reduce((a, x) => a + (x[2] || 0), 0);
        return { total_usd: longs + shorts, longs_liq_usd: longs, shorts_liq_usd: shorts };
      }
    } catch {}
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
