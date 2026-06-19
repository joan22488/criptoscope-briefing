import Anthropic from "@anthropic-ai/sdk";
import { registrarSenal, verificarResultados, calcularCorrelacion } from "./tracker.js";

const client = new Anthropic();
const OKX = "https://www.okx.com/api/v5/market";
const OKX_PUBLIC = "https://www.okx.com/api/v5/public";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

// Configuración de cada franja horaria
const SLOTS = { 7: "apertura", 11: "pulso", 15: "derivados", 19: "cierre" };

const SLOT_CONFIG = {
  apertura: {
    label: "Radar de apertura",
    emoji: "🌅",
    hora_str: "07:00",
    sistema_extra: `Análisis de apertura (07:00). Foco en la estructura 4H y el sesgo del día.
Tu trabajo: leer la macro diaria, identificar el sesgo dominante y el nivel más importante del día.
Sé directo: "BTC abre alcista con soporte en X" o "ETH en lateral sin dirección clara en 4H".`,
    instruccion_extra: `FOCO 07:00: estructura 4H, tendencia 1D, sesgo del día y nivel clave a vigilar.
El campo "sesgo" debe ser una lectura clara del bias del día. El campo "cuando" debe nombrar el nivel exacto que activa o invalida el setup.`,
    pie: "Niveles y estructura para la sesión de hoy.",
  },
  pulso: {
    label: "Pulso técnico",
    emoji: "📈",
    hora_str: "11:00",
    sistema_extra: `Análisis de media mañana (11:00). Foco en 1H: ¿el precio respeta o rompe los niveles del radar de apertura?
Tu trabajo: evaluar el momentum 1H con RSI y MACD. Si hay setup con entrada clara, defínelo. Si el precio está en tierra de nadie, di ESPERAR.
RSI1H > 60 con histograma MACD subiendo = momentum alcista. RSI < 40 con histograma bajando = momentum bajista.`,
    instruccion_extra: `FOCO 11:00: momentum 1H (RSI zona, MACD cruce y dirección histograma). ¿El setup de apertura se confirma o se invalida?
El campo "sesgo" debe nombrar el estado actual del momentum en 1H. El campo "por_que" debe incluir RSI y MACD 1H.`,
    pie: "Momentum 1H actualizado a media mañana.",
  },
  derivados: {
    label: "On-chain y derivados",
    emoji: "⚡",
    hora_str: "15:00",
    sistema_extra: `Análisis de tarde (15:00). Foco en derivados: funding rate, open interest, posicionamiento del mercado.
Tu trabajo: leer el funding y el OI y traducirlos a lenguaje de mercado. Funding muy positivo = mercado excesivamente largo, riesgo de squeeze bajista. Funding muy negativo = shorts acumulados, riesgo de short squeeze.
Si el OI sube con el precio: la tendencia tiene respaldo. Si el OI cae con el precio: el movimiento pierde fuerza.`,
    instruccion_extra: `FOCO 15:00: interpreta funding rate y open interest de cada activo. El campo "sesgo" debe nombrar el posicionamiento del mercado (ej: "Mercado largo en exceso, funding 0.08%"). El campo "por_que" debe conectar funding+OI con la dirección del precio.`,
    pie: "Datos de derivados instantáneos. El funding cambia cada 8h.",
  },
  cierre: {
    label: "Cierre europeo",
    emoji: "🌙",
    hora_str: "19:00",
    sistema_extra: `Análisis de cierre europeo (19:00). Foco en el balance del día y la preparación para la sesión asiática.
Tu trabajo: comparar el precio actual con el rango del día, leer si el cierre deja estructura alcista o bajista, e identificar el nivel clave para la sesión asiática de esta noche.
Un cierre en la parte alta del rango del día = fortaleza. En la parte baja = debilidad.`,
    instruccion_extra: `FOCO 19:00: balance del día (dónde cierra en el rango diario), estructura del cierre y nivel clave para la sesión asiática.
El campo "sesgo" debe incluir el balance: "Día alcista, cierra en máximos" o "Día bajista, cierra en mínimos del rango".
El campo "cuando" debe nombrar el nivel asiático a vigilar esta noche.`,
    pie: "Cierre de la sesión europea. La sesión asiática abre en unas horas.",
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

async function getVelas(symbol, interval, limit = 120) {
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

function calcEMA(velas, p) {
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
  const [v1d, v4h, v1h, v15m, funding] = await Promise.all([
    getVelas(symbol, "1d", 60), getVelas(symbol, "4h", 120),
    getVelas(symbol, "1h", 120), getVelas(symbol, "15m", 120),
    getFunding(symbol),
  ]);
  const ema20s = calcEMA(v4h, 20);
  const ema50s = calcEMA(v4h, 50);
  return {
    nombre, precio: v15m[v15m.length - 1].close, funding,
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
    obj[s] = { sesgo: "frase corta directa", op: "LONG|SHORT|ESPERAR", por_que: "1 frase", entrada: null, tp1: null, tp2: null, sl: null, rr: null, tamano: "NORMAL|REDUCIDO", cuando: "condicion o nivel", alerta: null };
    return obj;
  }, {});

  const instruccion = `Genera SOLO este JSON sin markdown:
${JSON.stringify(plantilla)}

REGLAS EXTRA:
- Usa el 1D para filtrar: si el Daily está en tendencia clara, prioriza esa dirección.
- Los pivots (pivot, r1, r2, s1, s2) son niveles clave para TP y SL — úsalos cuando sean relevantes.
- SOL analízala igual que BTC y ETH con su propia estructura.
- RR mínimo 1:1.5. Si no hay setup limpio, op=ESPERAR siempre.
${cfg.instruccion_extra}

DATOS: ` + JSON.stringify(datos);

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 2000,
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
    // Rescue: extract BTC and ETH blocks individually
    const rescatar = (sym) => {
      const raw = limpio.match(new RegExp(`"${sym}"\\s*:(\\{[\\s\\S]*?)(?="BTC"|"ETH"|"SOL"|$)`))?.[1] || "";
      const str = (c) => { const m = raw.match(new RegExp(`"${c}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"`)); return m?.[1] || null; };
      const num = (c) => { const m = raw.match(new RegExp(`"${c}"\\s*:\\s*([0-9.]+)`)); return m ? parseFloat(m[1]) : null; };
      return { sesgo: str("sesgo") || "sin datos", op: str("op") || "ESPERAR", por_que: str("por_que") || "", entrada: num("entrada"), tp1: num("tp1"), tp2: num("tp2"), sl: num("sl"), rr: str("rr"), tamano: str("tamano") || "REDUCIDO", cuando: str("cuando") || "", alerta: str("alerta") };
    };
    return { BTC: rescatar("BTC"), ETH: rescatar("ETH"), SOL: rescatar("SOL") };
  }
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

  // DERIVADOS: tabla de funding/OI como intro antes de los coins
  if (slot === "derivados") {
    msg += `<b>Posicionamiento ahora:</b>\n`;
    for (const d of datos) {
      if (!d.funding) continue;
      const fr = parseFloat(d.funding.funding_pct);
      const icono = fr > 0.04 ? "🔴" : fr < -0.04 ? "🟢" : "⚪";
      const sesgo = fr > 0.04 ? "longs pagando" : fr < -0.04 ? "shorts pagando" : "equilibrado";
      const oi = d.funding.open_interest > 0 ? `  OI ${(d.funding.open_interest / 1e6).toFixed(0)}M` : "";
      msg += `${icono} <b>${d.nombre}</b>: ${d.funding.funding_pct} (${sesgo})${oi}\n`;
    }
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

    // APERTURA y CIERRE: funding como dato de contexto, discreto
    if ((slot === "apertura" || slot === "cierre") && info?.funding) {
      msg += `Funding: ${info.funding.funding_pct}\n`;
    }

    msg += `\n${d.sesgo}\n\n`;
    msg += `${iconOp[d.op] || "⏸ ESPERAR"}\n`;
    msg += `${d.por_que}\n`;

    if (d.op !== "ESPERAR" && d.entrada) {
      msg += `\nEntrada  <b>${d.entrada}</b>\n`;
      msg += `TP1  ${d.tp1}  ·  TP2  ${d.tp2}\n`;
      msg += `SL  ${d.sl}  ·  R:R  ${d.rr}\n`;
      if (d.tamano === "REDUCIDO") msg += `⚠️ Posición reducida por divergencia\n`;
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
  return msg;
}

export async function ejecutarAnalisisTecnico() {
  // Detectar franja horaria en Madrid
  const horaNum = parseInt(new Date().toLocaleTimeString("es-ES", {
    hour: "2-digit", timeZone: process.env.TIMEZONE || "Europe/Madrid",
  }).split(":")[0]);
  const slot = SLOTS[horaNum] || "apertura";
  const cfg = SLOT_CONFIG[slot];

  console.log(`📊 ${cfg.emoji} ${cfg.label} (${cfg.hora_str}) — BTC + ETH + SOL...`);
  const datos = await Promise.all(SYMBOLS.map(analizarSymbol));
  console.log(`   BTC $${datos[0].precio.toFixed(0)} | ETH $${datos[1].precio.toFixed(0)} | SOL $${datos[2].precio.toFixed(0)}`);
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
      await registrarSenal(d.nombre, s, d.precio).catch(() => {});
    }
  }

  // Verificar resultados de señales anteriores
  const precios = Object.fromEntries(datos.map((d) => [d.nombre, d.precio]));
  const actualizadas = await verificarResultados(precios).catch(() => []);
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
