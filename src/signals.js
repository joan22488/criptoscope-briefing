import Anthropic from "@anthropic-ai/sdk";
import { registrarSenal, verificarResultados, calcularCorrelacion } from "./tracker.js";

const client = new Anthropic();
const OKX = "https://www.okx.com/api/v5/market";
const OKX_PUBLIC = "https://www.okx.com/api/v5/public";
const BINANCE_FAPI = "https://fapi.binance.com";
const SYMBOLS = (process.env.SIGNALS_SYMBOLS || "BTC,ETH,SOL,AVAX,LINK,BNB,XRP")
  .split(",").map((s) => s.trim().toUpperCase().replace("USDT", "") + "USDT");

// Configuración de cada franja horaria
const SLOTS = { 7: "apertura", 11: "pulso", 15: "derivados", 19: "cierre" };

const SLOT_CONFIG = {
  apertura: {
    label: "Radar de apertura",
    emoji: "🌅",
    hora_str: "07:00",
    sistema_extra: `Análisis de apertura (07:00). Foco en la estructura 4H y el sesgo del día.
Tu trabajo: leer la macro diaria, identificar el sesgo dominante y el nivel más importante del día.
Sé directo: "BTC abre alcista con soporte en X" o "ETH en lateral sin dirección clara en 4H".
Datos de Binance disponibles en campo "binance" de cada activo: oi_change_pct (cambio OI últimas 20h), ls_top (ratio longs/shorts top traders), taker_ratio (agresividad compradora vs vendedora).
Si ls_top > 1.2 al abrir = institucionales estuvieron largos durante la noche, sesgo alcista reforzado. Si ls_top < 0.85 = institucionales cortos, cautela aunque la estructura técnica sea alcista. OI subiendo de noche = dinero nuevo entrando antes de apertura Europa.`,
    instruccion_extra: `FOCO 07:00: estructura 4H, tendencia 1D, sesgo del día y nivel clave a vigilar.
El campo "sesgo" debe ser una lectura clara del bias del día integrando técnico Y derivados de Binance. El campo "cuando" debe nombrar el nivel exacto que activa o invalida el setup.
Si binance.ls_top confirma la dirección técnica: tamano NORMAL. Si contradice: REDUCIDO.`,
    pie: "Niveles y estructura para la sesión de hoy.",
  },
  pulso: {
    label: "Pulso técnico",
    emoji: "📈",
    hora_str: "11:00",
    sistema_extra: `Análisis de media mañana (11:00). Foco en 1H: ¿el precio respeta o rompe los niveles del radar de apertura?
Tu trabajo: evaluar el momentum 1H con RSI y MACD. Si hay setup con entrada clara, defínelo. Si el precio está en tierra de nadie, di ESPERAR.
RSI1H > 60 con histograma MACD subiendo = momentum alcista. RSI < 40 con histograma bajando = momentum bajista.
Datos de Binance disponibles en campo "binance": taker_ratio es el más relevante en el pulso de media mañana. taker > 1.1 con RSI subiendo = compradores agresivos detrás del momentum, señal real. taker < 0.9 con RSI subiendo = rally sin convicción, posible trampa alcista. ls_top refuerza o contradice el sesgo técnico.`,
    instruccion_extra: `FOCO 11:00: momentum 1H (RSI zona, MACD cruce y dirección histograma). ¿El setup de apertura se confirma o se invalida?
El campo "sesgo" debe nombrar el estado actual del momentum en 1H integrando taker y ls_top de Binance. El campo "por_que" debe incluir RSI, MACD 1H y el dato de Binance más relevante.
Si taker y RSI confirman la misma dirección: tamano NORMAL. Si divergen: REDUCIDO.`,
    pie: "Momentum 1H + derivados Binance a media mañana.",
  },
  derivados: {
    label: "On-chain y derivados",
    emoji: "⚡",
    hora_str: "15:00",
    sistema_extra: `Análisis de tarde (15:00). Foco en derivados: funding rate, open interest, posicionamiento del mercado.
Tu trabajo: leer el funding y el OI y traducirlos a lenguaje de mercado. Funding muy positivo = mercado excesivamente largo, riesgo de squeeze bajista. Funding muy negativo = shorts acumulados, riesgo de short squeeze.
Si el OI sube con el precio: la tendencia tiene respaldo. Si el OI cae con el precio: el movimiento pierde fuerza.
Datos de Binance disponibles en campo "binance" de cada activo: oi_change_pct = cambio OI últimas 20h (positivo = dinero entrando, negativo = saliendo), ls_top = ratio longs/shorts de los top traders (>1.2 smart money largo, <0.85 smart money corto), taker_ratio = agresividad compradora vs vendedora (>1.1 compradores dominan, <0.9 vendedores dominan).`,
    instruccion_extra: `FOCO 15:00: interpreta funding rate y open interest de cada activo. El campo "sesgo" debe nombrar el posicionamiento del mercado (ej: "Mercado largo en exceso, funding 0.08%"). El campo "por_que" debe conectar funding+OI con la dirección del precio.
Si hay datos "binance": usa oi_change_pct para validar si la tendencia tiene respaldo. Si ls_top y taker_ratio confirman la dirección tecnica = tamano NORMAL. Si contradicen la tecnica = REDUCIDO. Si ls_top < 0.85 = top traders cortos, refuerza SHORT.`,
    pie: "Datos de derivados: OKX funding + Binance OI/L/S/Taker.",
  },
  cierre: {
    label: "Cierre europeo",
    emoji: "🌙",
    hora_str: "19:00",
    sistema_extra: `Análisis de cierre europeo (19:00). Foco en el balance del día y la preparación para la sesión asiática.
Tu trabajo: comparar el precio actual con el rango del día, leer si el cierre deja estructura alcista o bajista, e identificar el nivel clave para la sesión asiática de esta noche.
Un cierre en la parte alta del rango del día = fortaleza. En la parte baja = debilidad.
Datos de Binance disponibles en campo "binance": al cierre europeo, oi_change_pct muestra si el dinero entró o salió durante el día. OI cayendo al cierre = posiciones reduciéndose antes de Asia, sesión asiática menos volátil. OI subiendo con precio en máximos = continuación asiática probable. ls_top al cierre = sesgo institucional para la noche.`,
    instruccion_extra: `FOCO 19:00: balance del día (dónde cierra en el rango diario), estructura del cierre y nivel clave para la sesión asiática.
El campo "sesgo" debe incluir el balance ("Día alcista, cierra en máximos") Y el sesgo de derivados (ls_top + oi_change_pct) para la noche.
El campo "cuando" debe nombrar el nivel asiático a vigilar. Si OI sube + ls_top alcista: probabilidad de continuación asiática alta.`,
    pie: "Cierre europeo. La sesión asiática abre en unas horas.",
  },
};

// Elimina guiones medios/largos que cuela Claude — delatan texto de IA
function sanitizarDashes(s) {
  if (typeof s !== "string") return s;
  return s.replace(/ [–—] /g, ": ").replace(/[–—]/g, ".");
}

// Convierte "BTCUSDT" → "BTC-USDT", mapea intervalos Binance → OKX
const toOKXId = (sym) => sym.replace("USDT", "-USDT");
const toOKXBar = (iv) => ({ "1d": "1D", "4h": "4H", "1h": "1H", "15m": "15m" }[iv] || iv);

export async function getVelas(symbol, interval, limit = 120) {
  const instId = toOKXId(symbol);
  const bar = toOKXBar(interval);
  const url = `${OKX}/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`OKX ${symbol} ${interval}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== "0") throw new Error(`OKX ${symbol} ${interval}: ${json.msg}`);
  // OKX devuelve newest-first → invertir para tener cronológico
  return json.data.reverse().map((v) => ({
    time: new Date(parseInt(v[0])).toISOString(),
    open: parseFloat(v[1]), high: parseFloat(v[2]),
    low: parseFloat(v[3]), close: parseFloat(v[4]), volume: parseFloat(v[5]),
  }));
}

async function getFunding(symbol) {
  try {
    const instId = toOKXId(symbol) + "-SWAP";
    const [fr, oi] = await Promise.all([
      fetch(`${OKX_PUBLIC}/funding-rate?instId=${instId}`).then((r) => r.json()),
      fetch(`${OKX_PUBLIC}/open-interest?instType=SWAP&instId=${instId}`).then((r) => r.json()),
    ]);
    const frVal = parseFloat(fr.data?.[0]?.fundingRate || 0);
    const oiVal = parseFloat(oi.data?.[0]?.oi || 0);
    return {
      funding_pct: (frVal * 100).toFixed(4) + "%",
      open_interest: oiVal,
    };
  } catch { return null; }
}

// Datos de derivados de Binance Futures (API pública, sin API key)
// OI histórico 4H, ratio longs/shorts global, top traders y presión taker
export async function getBinanceFutures(symbol) {
  const safe = (p) => p.catch(() => null);
  try {
    const [oiHist, lsGlobal, lsTop, taker] = await Promise.all([
      safe(fetch(`${BINANCE_FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=5`).then((r) => r.json())),
      safe(fetch(`${BINANCE_FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`).then((r) => r.json())),
      safe(fetch(`${BINANCE_FAPI}/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`).then((r) => r.json())),
      safe(fetch(`${BINANCE_FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=3`).then((r) => r.json())),
    ]);

    // Cambio de OI en las últimas 20h (5 velas de 4H)
    let oi_change_pct = null;
    if (Array.isArray(oiHist) && oiHist.length >= 2) {
      const first = parseFloat(oiHist[0].sumOpenInterest);
      const last = parseFloat(oiHist[oiHist.length - 1].sumOpenInterest);
      if (first > 0) {
        const chgNum = (last - first) / first * 100;
        const chg = chgNum.toFixed(2);
        oi_change_pct = `${chgNum > 0 ? "+" : ""}${chg}%`;
      }
    }

    // Ratio L/S global retail (último 1h)
    const ls_global = Array.isArray(lsGlobal) && lsGlobal[0]
      ? parseFloat(lsGlobal[0].longShortRatio).toFixed(3) : null;

    // Ratio L/S top traders Binance (último 1h) — el más útil para señales
    const ls_top = Array.isArray(lsTop) && lsTop[0]
      ? parseFloat(lsTop[0].longShortRatio).toFixed(3) : null;

    // Agresividad compradora vs vendedora (media últimas 3h)
    let taker_ratio = null;
    if (Array.isArray(taker) && taker.length) {
      const avg = taker.reduce((a, b) => a + parseFloat(b.buySellRatio), 0) / taker.length;
      taker_ratio = avg.toFixed(3);
    }

    if (!oi_change_pct && !ls_global && !ls_top && !taker_ratio) return null;
    return { oi_change_pct, ls_global, ls_top, taker_ratio };
  } catch (e) {
    console.warn(`⚠️  Binance futures ${symbol}:`, e.message);
    return null;
  }
}

// Contexto de derivados BTC+ETH para inyectar en cualquier prompt de Claude
export async function getContextoDerivadosBTC() {
  try {
    const [btcB, ethB, btcF, ethF] = await Promise.all([
      getBinanceFutures("BTCUSDT"),
      getBinanceFutures("ETHUSDT"),
      getFunding("BTCUSDT"),
      getFunding("ETHUSDT"),
    ]);
    const resumir = (nombre, b, f) => {
      const p = [];
      if (f?.funding_pct) p.push(`funding ${f.funding_pct}`);
      if (b?.oi_change_pct) p.push(`OI ${b.oi_change_pct} en 20h`);
      if (b?.ls_top) {
        const v = parseFloat(b.ls_top);
        p.push(`top traders L/S ${b.ls_top}${v > 1.2 ? " (smart money largo)" : v < 0.85 ? " (smart money corto)" : ""}`);
      }
      if (b?.taker_ratio) {
        const v = parseFloat(b.taker_ratio);
        p.push(`taker ${b.taker_ratio}${v > 1.1 ? " (compradores agresivos)" : v < 0.9 ? " (vendedores agresivos)" : ""}`);
      }
      return `${nombre}: ${p.join(", ")}`;
    };
    const resumen = [resumir("BTC", btcB, btcF), resumir("ETH", ethB, ethF)].join(". ");
    return { BTC: { ...btcB, ...btcF }, ETH: { ...ethB, ...ethF }, resumen };
  } catch (e) {
    console.warn("⚠️  getContextoDerivadosBTC:", e.message);
    return null;
  }
}

export function calcEMA(velas, p) {
  const k = 2 / (p + 1);
  let ema = velas[0].close;
  const s = [ema];
  for (let i = 1; i < velas.length; i++) { ema = velas[i].close * k + ema * (1 - k); s.push(ema); }
  return s;
}

function calcRSI(velas, p = 14) {
  const c = velas.map((v) => v.close);
  const ch = c.slice(1).map((x, i) => x - c[i]);
  let g = ch.slice(0, p).filter((x) => x > 0).reduce((a, b) => a + b, 0) / p;
  let l = ch.slice(0, p).filter((x) => x < 0).reduce((a, b) => a + Math.abs(b), 0) / p;
  const s = [];
  for (let i = p; i < ch.length; i++) {
    g = (g * (p - 1) + Math.max(ch[i], 0)) / p;
    l = (l * (p - 1) + Math.max(-ch[i], 0)) / p;
    s.push(parseFloat((100 - 100 / (1 + (l === 0 ? 100 : g / l))).toFixed(2)));
  }
  return s;
}

function calcMACD(velas, r = 12, lp = 26, sig = 9) {
  const eR = calcEMA(velas, r);
  const eL = calcEMA(velas, lp);
  const off = lp - r;
  const macd = eR.slice(off).map((v, i) => v - eL[i]);
  const sigVelas = velas.slice(off).map((v, i) => ({ ...v, close: macd[i] }));
  const sigLine = calcEMA(sigVelas, sig);
  const hist = macd.slice(sig - 1).map((v, i) => parseFloat((v - sigLine[i]).toFixed(4)));
  return { macd: macd.slice(sig - 1).map((v) => parseFloat(v.toFixed(4))), senal: sigLine, hist };
}

function divRSI(velas, rsi, w = 20) {
  const p = velas.slice(-w).map((v) => v.close);
  const r = rsi.slice(-w);
  const ps = p[p.length - 1] > p[0], rs = r[r.length - 1] > r[0];
  if (ps && !rs) return "DIV_BAJISTA";
  if (!ps && rs) return "DIV_ALCISTA";
  return null;
}

function divMACD(velas, hist, w = 10) {
  const p = velas.slice(-w).map((v) => v.close);
  const h = hist.slice(-w);
  const ps = p[p.length - 1] > p[0], hs = h[h.length - 1] > h[0];
  if (ps && !hs) return "AGOTAMIENTO";
  return null;
}

function analizarTF(velas, label) {
  const rsi = calcRSI(velas);
  const macd = calcMACD(velas);
  const ema20 = calcEMA(velas, 20);
  const ema50 = calcEMA(velas, 50);
  const u = velas.slice(-30);
  const rsiV = rsi[rsi.length - 1];
  const macdV = macd.macd[macd.macd.length - 1];
  const sigV = macd.senal[macd.senal.length - 1];
  const hV = macd.hist[macd.hist.length - 1];
  const hP = macd.hist[macd.hist.length - 2];
  return {
    tf: label,
    precio: parseFloat(velas[velas.length - 1].close.toFixed(2)),
    ema20: parseFloat(ema20[ema20.length - 1].toFixed(2)),
    ema50: parseFloat(ema50[ema50.length - 1].toFixed(2)),
    rsi: { v: rsiV, zona: rsiV > 70 ? "OB" : rsiV < 30 ? "OS" : (rsiV >= 40 && rsiV <= 60) ? "RESET" : "NEUTRO", div: divRSI(velas, rsi) },
    macd: { v: macdV, sig: sigV, hist: hV, cruce: macdV > sigV ? "BUY" : "SELL", cero: macdV > 0 ? "+" : "-", hist_dir: hV > hP ? "^" : "v", div: divMACD(velas, macd.hist) },
    res: parseFloat(Math.max(...u.map((v) => v.high)).toFixed(2)),
    sop: parseFloat(Math.min(...u.map((v) => v.low)).toFixed(2)),
  };
}

function calcPivots(velas) {
  // Pivot points basados en las últimas 20 velas (soporte/resistencia clave)
  const recientes = velas.slice(-20);
  const highs = recientes.map((v) => v.high).sort((a, b) => b - a);
  const lows = recientes.map((v) => v.low).sort((a, b) => a - b);
  const pivot = (recientes[recientes.length - 1].high + recientes[recientes.length - 1].low + recientes[recientes.length - 1].close) / 3;
  return {
    pivot: parseFloat(pivot.toFixed(2)),
    r1: parseFloat((2 * pivot - lows[0]).toFixed(2)),
    r2: parseFloat(highs[1]?.toFixed(2) || highs[0].toFixed(2)),
    s1: parseFloat((2 * pivot - highs[0]).toFixed(2)),
    s2: parseFloat(lows[1]?.toFixed(2) || lows[0].toFixed(2)),
  };
}

export async function analizarSymbol(symbol) {
  const nombre = symbol.replace("USDT", "");
  const [v1d, v4h, v1h, v15m, funding, binance] = await Promise.all([
    getVelas(symbol, "1d", 60), getVelas(symbol, "4h", 120),
    getVelas(symbol, "1h", 120), getVelas(symbol, "15m", 120),
    getFunding(symbol),
    getBinanceFutures(symbol),
  ]);
  const ema20s = calcEMA(v4h, 20);
  const ema50s = calcEMA(v4h, 50);
  return {
    nombre, precio: v15m[v15m.length - 1].close, funding, binance,
    tf1d: analizarTF(v1d, "1D"),
    tf4h: analizarTF(v4h, "4H"),
    tf1h: analizarTF(v1h, "1H"),
    tf15m: analizarTF(v15m, "15m"),
    pivots: calcPivots(v4h),
    velas4h: v4h.slice(-30),
    ema20_4h: ema20s.slice(-30),
    ema50_4h: ema50s.slice(-30),
  };
}

export async function generarSenal(datos, slot = "apertura") {
  const cfg = SLOT_CONFIG[slot] || SLOT_CONFIG.apertura;

  const sistema = `Eres el analista de CriptoScope. Voz directa de trader a trader — sin relleno, sin frases de IA. El precio manda.
Metodologia: 4H estructura → 1H confirma RSI/MACD → 15m gatillo. RSI14 MACD 12/26/9.
Divergencias en 1H/4H contra el setup = tamaño REDUCIDO o ESPERAR. RR minimo 1:1.5. Analisis educativo.
PROHIBIDO usar guiones medios o largos (– o —). Usa punto, dos puntos o reestructura la frase.

${cfg.sistema_extra}`;

  const syms = datos.map((d) => d.nombre);
  const plantilla = syms.reduce((obj, s) => {
    obj[s] = { sesgo: "máx 8 palabras", op: "LONG|SHORT|ESPERAR", por_que: "máx 10 palabras", entrada: null, tp1: null, tp2: null, sl: null, rr: null, tamano: "NORMAL|REDUCIDO", cuando: "máx 10 palabras", alerta: null };
    return obj;
  }, {});

  const instruccion = `Genera SOLO este JSON sin markdown:
${JSON.stringify(plantilla)}

LÍMITES ESTRICTOS DE CAMPO: sesgo ≤8 palabras · por_que ≤10 palabras · cuando ≤10 palabras · alerta ≤8 palabras o null. ESTOS LÍMITES SON OBLIGATORIOS.

REGLAS EXTRA:
- Usa el 1D para filtrar: si el Daily está en tendencia clara, prioriza esa dirección.
- Los pivots (pivot, r1, r2, s1, s2) son niveles clave para TP y SL — úsalos cuando sean relevantes.
- SOL analízala igual que BTC y ETH con su propia estructura.
- RR mínimo 1:1.5. Si no hay setup limpio, op=ESPERAR siempre.
${cfg.instruccion_extra}

DATOS: ` + JSON.stringify(datos);

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 4000,
    system: sistema,
    messages: [{ role: "user", content: instruccion }],
  });
  const txt = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const inicio = txt.indexOf("{");
  const fin = txt.lastIndexOf("}");
  const limpio = inicio !== -1 && fin !== -1 ? txt.slice(inicio, fin + 1) : txt.replace(/```json|```/g, "").trim();
  const aplicarSanitizacion = (parsed) => {
    const campos = ["sesgo", "por_que", "cuando", "alerta", "rr"];
    for (const sym of Object.keys(parsed)) {
      for (const campo of campos) {
        if (parsed[sym]?.[campo]) parsed[sym][campo] = sanitizarDashes(parsed[sym][campo]);
      }
    }
    return parsed;
  };

  try {
    return aplicarSanitizacion(JSON.parse(limpio));
  } catch (e) {
    // Rescue: extraer bloque de cada símbolo de forma dinámica
    const otrosSyms = syms.map((s) => `"${s}"`).join("|");
    const rescatar = (sym) => {
      const raw = limpio.match(new RegExp(`"${sym}"\\s*:(\\{[\\s\\S]*?)(?=${otrosSyms}|$)`))?.[1] || "";
      const str = (c) => { const m = raw.match(new RegExp(`"${c}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"`)); return m?.[1] || null; };
      const num = (c) => { const m = raw.match(new RegExp(`"${c}"\\s*:\\s*([0-9.]+)`)); return m ? parseFloat(m[1]) : null; };
      return { sesgo: str("sesgo") || "sin datos", op: str("op") || "ESPERAR", por_que: str("por_que") || "", entrada: num("entrada"), tp1: num("tp1"), tp2: num("tp2"), sl: num("sl"), rr: str("rr"), tamano: str("tamano") || "REDUCIDO", cuando: str("cuando") || "", alerta: str("alerta") };
    };
    return Object.fromEntries(syms.map((s) => [s, rescatar(s)]));
  }
}

function calcConfluencia(datos) {
  const lineas = [];
  for (const d of datos) {
    if (!d.binance) continue;
    const oiNum = d.binance.oi_change_pct ? parseFloat(d.binance.oi_change_pct) : null;
    const topNum = d.binance.ls_top ? parseFloat(d.binance.ls_top) : null;
    const takNum = d.binance.taker_ratio ? parseFloat(d.binance.taker_ratio) : null;
    const señales = [
      oiNum !== null ? (oiNum > 0 ? 1 : -1) : null,
      topNum !== null ? (topNum > 1.05 ? 1 : topNum < 0.95 ? -1 : 0) : null,
      takNum !== null ? (takNum > 1.05 ? 1 : takNum < 0.95 ? -1 : 0) : null,
    ].filter((x) => x !== null);
    if (!señales.length) continue;
    const suma = señales.reduce((a, b) => a + b, 0);
    if (suma >= 2) lineas.push(`✅ ${d.nombre}: OI + derivados alineados alcistas`);
    else if (suma <= -2) lineas.push(`🔴 ${d.nombre}: OI + derivados alineados bajistas`);
    else lineas.push(`⚡ ${d.nombre}: señales mixtas`);
  }
  const btc = datos.find((d) => d.nombre === "BTC");
  const eth = datos.find((d) => d.nombre === "ETH");
  if (btc?.binance?.ls_top && eth?.binance?.ls_top) {
    const bTop = parseFloat(btc.binance.ls_top);
    const eTop = parseFloat(eth.binance.ls_top);
    if (bTop > 1.1 && eTop < 0.95) lineas.push("🔀 Rotación: smart money largo BTC, corto ETH");
    else if (eTop > 1.1 && bTop < 0.95) lineas.push("🔀 Rotación: smart money largo ETH, corto BTC");
  }
  return lineas.length ? lineas.join("\n") : null;
}

function formatear(senales, datos, hora, correlacion, slot = "apertura") {
  const cfg = SLOT_CONFIG[slot] || SLOT_CONFIG.apertura;
  const iconOp = { LONG: "🟢 LONG", SHORT: "🔴 SHORT", ESPERAR: "⏸ ESPERAR" };
  const fecha = new Date().toLocaleDateString("es-ES", {
    weekday: "long", day: "numeric", month: "long",
    timeZone: process.env.TIMEZONE || "Europe/Madrid",
  });

  let msg = `<b>${cfg.emoji} CRIPTOSCOPE | ${cfg.label}</b>\n`;
  msg += `<b>${fecha} · ${hora}</b>\n\n`;

  // DERIVADOS: tabla de funding + Binance OI/L/S/Taker como intro antes de los coins
  if (slot === "derivados") {
    msg += `<b>Posicionamiento ahora:</b>\n`;
    for (const d of datos) {
      if (!d.funding && !d.binance) continue;
      const fr = d.funding ? parseFloat(d.funding.funding_pct) : 0;
      const icono = fr > 0.04 ? "🔴" : fr < -0.04 ? "🟢" : "⚪";
      const sesgo = fr > 0.04 ? "longs pagando" : fr < -0.04 ? "shorts pagando" : "equilibrado";
      msg += `${icono} <b>${d.nombre}</b>: ${d.funding?.funding_pct || "n/a"} (${sesgo})\n`;
      if (d.binance) {
        const parts = [];
        if (d.binance.oi_change_pct) parts.push(`OI ${d.binance.oi_change_pct}`);
        if (d.binance.ls_top) {
          const topVal = parseFloat(d.binance.ls_top);
          const topIcon = topVal > 1.2 ? " 🐋" : topVal < 0.85 ? " 🐻" : "";
          parts.push(`Top L/S ${d.binance.ls_top}${topIcon}`);
        }
        if (d.binance.taker_ratio) {
          const takVal = parseFloat(d.binance.taker_ratio);
          const takIcon = takVal > 1.1 ? "▲" : takVal < 0.9 ? "▼" : "";
          parts.push(`Taker ${d.binance.taker_ratio}${takIcon}`);
        }
        if (parts.length) msg += `   ${parts.join("  ·  ")}\n`;
      }
    }
    // Línea de confluencia automática
    const confluencia = calcConfluencia(datos);
    if (confluencia) msg += `\n${confluencia}\n`;
    msg += "\n";
  }

  for (const [sym, d] of Object.entries(senales)) {
    const info = datos.find((x) => x.nombre === sym);
    const precio = info ? `$${info.precio.toFixed(0)}` : "";

    msg += `──────────────\n`;
    msg += `<b>${sym} ${precio}</b>\n`;

    // PULSO: RSI 1H y dirección MACD visible bajo el precio
    if (slot === "pulso" && info?.tf1h) {
      const { rsi, macd } = info.tf1h;
      const rsiEmoji = rsi.v > 60 ? "🟢" : rsi.v < 40 ? "🔴" : "⚪";
      const histDir = macd.hist_dir === "^" ? "▲" : "▼";
      msg += `${rsiEmoji} RSI 1H: ${rsi.v} ${rsi.zona}  ·  MACD ${macd.cruce}  hist ${histDir}\n`;
    }

    // APERTURA y CIERRE: funding + datos Binance compactos
    if ((slot === "apertura" || slot === "cierre") && info?.funding) {
      msg += `Funding: ${info.funding.funding_pct}\n`;
    }
    if ((slot === "apertura" || slot === "cierre") && info?.binance) {
      const parts = [];
      if (info.binance.ls_top) {
        const v = parseFloat(info.binance.ls_top);
        parts.push(`Top L/S ${info.binance.ls_top}${v > 1.2 ? " 🐋" : v < 0.85 ? " 🐻" : ""}`);
      }
      if (info.binance.oi_change_pct) parts.push(`OI ${info.binance.oi_change_pct}`);
      if (parts.length) msg += `${parts.join("  ·  ")}\n`;
    }

    // PULSO: taker + Top L/S como contexto de momentum
    if (slot === "pulso" && info?.binance) {
      const parts = [];
      if (info.binance.taker_ratio) {
        const v = parseFloat(info.binance.taker_ratio);
        parts.push(`Taker ${info.binance.taker_ratio}${v > 1.1 ? "▲" : v < 0.9 ? "▼" : ""}`);
      }
      if (info.binance.ls_top) {
        const v = parseFloat(info.binance.ls_top);
        parts.push(`Top L/S ${info.binance.ls_top}${v > 1.2 ? " 🐋" : v < 0.85 ? " 🐻" : ""}`);
      }
      if (parts.length) msg += `${parts.join("  ·  ")}\n`;
    }

    msg += `\n${d.sesgo}\n\n`;
    msg += `${iconOp[d.op] || "⏸ ESPERAR"}${d.tamano === "REDUCIDO" ? " · pos.reducida" : ""}\n`;
    msg += `${d.por_que}\n`;

    if (d.op !== "ESPERAR" && d.entrada) {
      msg += `\nEntrada  <b>${d.entrada}</b>\n`;
      msg += `TP1  ${d.tp1}  ·  TP2  ${d.tp2}\n`;
      msg += `SL  ${d.sl}  ·  R:R  ${d.rr}\n`;
      msg += `\n✅ Activar si: ${d.cuando}\n`;
    } else {
      // CIERRE usa label de sesión asiática, el resto usa Vigilar
      const labelVigilar = slot === "cierre" ? "🌙 Asiática:" : "🎯 Vigilar:";
      msg += `\n${labelVigilar} ${d.cuando}\n`;
    }

    if (d.alerta) msg += `\n⚠️ ${d.alerta}\n`;
    msg += "\n";
  }

  // APERTURA: síntesis del nivel del día al final (extraído del campo "cuando" de BTC)
  if (slot === "apertura" && senales["BTC"]?.cuando) {
    msg += `──────────────\n📌 Nivel del día: ${senales["BTC"].cuando}\n\n`;
  }

  if (correlacion && slot !== "derivados") msg += `──────────────\n🔗 ${correlacion}\n\n`;
  msg += `──────────────\n`;
  msg += `<i>${cfg.pie} · Análisis educativo, no consejo financiero</i>`;
  if (process.env.X_PROFILE_URL) msg += `\n\n🐦 <a href="${process.env.X_PROFILE_URL}">Síguenos en X</a>`;
  return msg;
}

export async function ejecutarAnalisisTecnico() {
  // Detectar franja horaria en Madrid
  const horaNum = parseInt(new Date().toLocaleTimeString("es-ES", {
    hour: "2-digit", timeZone: process.env.TIMEZONE || "Europe/Madrid",
  }).split(":")[0]);
  const slot = SLOTS[horaNum] || "apertura";
  const cfg = SLOT_CONFIG[slot];

  const nombresLog = SYMBOLS.map((s) => s.replace("USDT", "")).join(" + ");
  console.log(`📊 ${cfg.emoji} ${cfg.label} (${cfg.hora_str}) — ${nombresLog}...`);
  const datos = await Promise.all(SYMBOLS.map(analizarSymbol));
  console.log("   " + datos.map((d) => `${d.nombre} $${d.precio.toFixed(0)}`).join(" | "));
  console.log(`🧠 Generando análisis [slot: ${slot}] con Claude...`);
  const senales = await generarSenal(datos, slot);
  const hora = new Date().toLocaleTimeString("es-ES", {
    hour: "2-digit", minute: "2-digit",
    timeZone: process.env.TIMEZONE || "Europe/Madrid",
  });
  // Registrar señales con entrada real en tracker (backtesting)
  for (const d of datos) {
    const s = senales[d.nombre];
    if (s && s.op !== "ESPERAR" && s.entrada) {
      await registrarSenal(d.nombre, s, d.precio).catch((e) => console.warn(`⚠️  registrarSenal ${d.nombre}:`, e.message));
    }
  }

  // Verificar resultados de señales anteriores
  const precios = Object.fromEntries(datos.map((d) => [d.nombre, d.precio]));
  const actualizadas = await verificarResultados(precios).catch((e) => { console.warn("⚠️  verificarResultados:", e.message); return []; });
  if (actualizadas.length) {
    console.log(`   📊 ${actualizadas.length} señal(es) con resultado actualizado`);
  }

  // Calcular correlación BTC/ETH/SOL
  const correlacion = calcularCorrelacion(datos);

  const mensaje = formatear(senales, datos, hora, correlacion, slot);
  const ops = datos.map((d) => `${d.nombre}: ${senales[d.nombre]?.op || "?"}`).join(" | ");
  console.log(`   ${ops}`);
  return { mensaje, senales };
}
