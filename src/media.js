// ============================================================
// media.js — Utilidades compartidas de imagen y gráficos
// Usado por bot.js, weekly.js y pipeline.js
// ============================================================

import sharp from "sharp";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir   = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dir, "../assets/logo.png");

const QC_URL = "https://quickchart.io/chart";
const QC_BASE = { width: 800, height: 420, backgroundColor: "#1e1e2e", format: "png", version: 4 };

const chartFooter = () =>
  process.env.X_PROFILE_URL
    ? `CriptoScope · ${process.env.X_PROFILE_URL.replace("https://", "")}`
    : "CriptoScope";

// ── Logo overlay en esquina inferior derecha ───────────────────
export async function aplicarLogo(imgBuffer, logoWidthPct = 0.18) {
  try {
    const base = sharp(imgBuffer);
    const { width, height } = await base.metadata();
    const logoW = Math.round(width * logoWidthPct);
    const logo  = await sharp(LOGO_PATH).resize(logoW, null, { fit: "inside" }).png().toBuffer();
    const { width: lw, height: lh } = await sharp(logo).metadata();
    return await base
      .composite([{ input: logo, left: width - lw - 14, top: height - lh - 14, blend: "over" }])
      .png()
      .toBuffer();
  } catch (e) {
    console.warn("⚠️ Logo overlay fallido:", e.message);
    return imgBuffer;
  }
}

// ── POST a quickchart.io, verifica Content-Type ───────────────
export async function fetchGraficoBuffer(chartConfig, opciones = {}) {
  if (!chartConfig) return null;
  const res = await fetch(QC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chart: chartConfig, ...QC_BASE, ...opciones }),
    signal: AbortSignal.timeout(15000),
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("image")) {
    const err = await res.text().catch(() => "");
    throw new Error(`quickchart ${res.status}: ${err.replace(/<[^>]*>/g, "").slice(0, 150)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── Gráfico de barras horizontal — cambios 24h de varias coins ──
// coins: [{ label: "BTC", value: 2.3 }, ...]  (value = % cambio 24h)
export async function generarChartBarras(coins) {
  const sorted = [...coins].sort((a, b) => b.value - a.value);
  const labels = sorted.map((c) => c.label);
  const values = sorted.map((c) => parseFloat(c.value.toFixed(2)));
  const colors = values.map((v) => v >= 0 ? "rgba(38,166,154,0.85)" : "rgba(239,83,80,0.85)");

  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        barThickness: 26,
      }],
    },
    options: {
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: chartFooter(),
          position: "bottom",
          color: "rgba(255,255,255,0.35)",
          font: { size: 11 },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#aaa",
            callback: (v) => (v >= 0 ? "+" : "") + v + "%",
          },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          ticks: { color: "#ddd" },
          grid: { display: false },
        },
      },
    },
  };

  return fetchGraficoBuffer(config, { height: Math.max(300, coins.length * 44 + 80) });
}

// ── Gráfico de líneas — evolución % de varias coins en el tiempo ──
// datasets: [{ label: "BTC", data: [0, 1.2, -0.5, ...], color: "#F7931A" }, ...]
export async function generarChartLinea(datasets, labels) {
  const config = {
    type: "line",
    data: {
      labels,
      datasets: datasets.map((d) => ({
        label: d.label,
        data: d.data,
        borderColor: d.color,
        backgroundColor: "transparent",
        borderWidth: 2.5,
        pointRadius: 4,
        tension: 0.35,
        fill: false,
      })),
    },
    options: {
      scales: {
        x: {
          ticks: { color: "#aaa", maxTicksLimit: 8 },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          ticks: {
            color: "#aaa",
            callback: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + "%",
          },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
      plugins: {
        legend: { labels: { color: "#ddd" } },
        title: {
          display: true,
          text: chartFooter(),
          position: "bottom",
          color: "rgba(255,255,255,0.35)",
          font: { size: 11 },
        },
      },
    },
  };

  return fetchGraficoBuffer(config);
}

// ── Portada branded — 1200×628 para Telegram y X ─────────────
// Genera la card de portada del briefing con Sharp puro (SVG → PNG).
// Params: { titular, badge, narrativa, btc, eth, sol, mstr, fg, fecha }
export async function generarPortadaCard({ titular, badge = "BRIEFING MATINAL", narrativa, btc, eth, sol, mstr, fg, fecha } = {}) {
  const W = 1200, H = 628;
  const ORANGE = "#f97316";

  const esc = (s) =>
    (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Word-wrap: split text into lines of maxChars at word boundaries
  const wrapLines = (text, maxChars) => {
    const words = (text || "").split(" ");
    const lines = [];
    let cur = "";
    for (const w of words) {
      const attempt = (cur + " " + w).trim();
      if (attempt.length > maxChars && cur) { lines.push(cur); cur = w; }
      else cur = attempt;
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  };

  const svgText = (lines, x, startY, lineH, attrs) =>
    lines.map((l, i) => `<text x="${x}" y="${startY + i * lineH}" ${attrs}>${esc(l)}</text>`).join("\n");

  const fmtPrice = (v) => {
    if (v == null) return "";
    const n = Number(v);
    if (n >= 1000) return `$${Math.round(n).toLocaleString("es-ES")}`;
    if (n === Math.floor(n)) return `$${n}`;
    return `$${n.toFixed(2)}`;
  };
  const fmtPct   = (v) => v != null ? `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%` : "";
  const pctCol   = (v) => (v == null || v >= 0) ? "#22c55e" : "#ef4444";

  const fechaStr = fecha || new Date().toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });

  const coins = [
    btc?.precio  ? { label: "BTC",  price: btc.precio,  pct: btc.cambio24h_pct  } : null,
    eth?.precio  ? { label: "ETH",  price: eth.precio,  pct: eth.cambio24h_pct  } : null,
    sol?.precio  ? { label: "SOL",  price: sol.precio,  pct: sol.cambio24h_pct  } : null,
    mstr?.precio ? { label: "MSTR", price: mstr.precio, pct: mstr.cambio_pct    } : null,
  ].filter(Boolean);

  const COL_W   = 185;
  const COL_X0  = 60;
  const BAR_Y   = 480;
  const coinsSvg = coins.map((c, i) => {
    const x = COL_X0 + i * COL_W;
    return `
    <text x="${x}" y="${BAR_Y + 28}" font-family="Arial,sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.42)" letter-spacing="1.5">${esc(c.label)}</text>
    <text x="${x}" y="${BAR_Y + 60}" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="#ffffff">${esc(fmtPrice(c.price))}</text>
    <text x="${x}" y="${BAR_Y + 84}" font-family="Arial,sans-serif" font-size="15" fill="${pctCol(c.pct)}">${esc(fmtPct(c.pct))}</text>`;
  }).join("");

  const fgSvg = fg?.valor != null ? `
    <text x="${W - 60}" y="${BAR_Y + 28}" text-anchor="end" font-family="Arial,sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.42)" letter-spacing="1.5">FEAR &amp; GREED</text>
    <text x="${W - 60}" y="${BAR_Y + 60}" text-anchor="end" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="${ORANGE}">${fg.valor} · ${esc(fg.clasificacion || "")}</text>
    <text x="${W - 60}" y="${BAR_Y + 84}" text-anchor="end" font-family="Arial,sans-serif" font-size="13" fill="rgba(255,255,255,0.28)">${esc(fechaStr)}</text>` : `
    <text x="${W - 60}" y="${BAR_Y + 60}" text-anchor="end" font-family="Arial,sans-serif" font-size="13" fill="rgba(255,255,255,0.28)">${esc(fechaStr)}</text>`;

  const headLines  = wrapLines(titular, 44);
  const headSvg    = svgText(headLines, 60, 175, 58, `font-family="Arial,sans-serif" font-size="46" font-weight="700" fill="#ffffff"`);
  const subY       = 175 + headLines.length * 58 + 24;
  const subLines   = wrapLines(narrativa, 72);
  const subSvg     = subLines.length ? svgText(subLines, 60, subY, 30, `font-family="Arial,sans-serif" font-size="19" fill="rgba(255,255,255,0.48)"`) : "";

  // Badge width estimate: ~10px per char + padding
  const badgeText  = badge.toUpperCase();
  const badgeW     = Math.max(140, badgeText.length * 9 + 32);
  const badgeX     = W - 60 - badgeW;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="glow" cx="12%" cy="50%" r="55%">
      <stop offset="0%" stop-color="${ORANGE}" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="${ORANGE}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
      <path d="M60 0 L0 0 0 60" fill="none" stroke="rgba(255,255,255,0.022)" stroke-width="0.5"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="#0a0a12"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <!-- Logo -->
  <circle cx="78" cy="54" r="20" fill="${ORANGE}"/>
  <text x="78" y="61" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="800" fill="#ffffff">C</text>
  <text x="110" y="61" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#ffffff" letter-spacing="2.5">CRIPTOSCOPE</text>
  <!-- Badge -->
  <rect x="${badgeX}" y="35" width="${badgeW}" height="34" rx="17" fill="rgba(249,115,22,0.18)" stroke="rgba(249,115,22,0.35)" stroke-width="1"/>
  <text x="${badgeX + badgeW / 2}" y="57" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="${ORANGE}" letter-spacing="1.5">${esc(badgeText)}</text>
  <!-- Divider -->
  <line x1="60" y1="104" x2="${W - 60}" y2="104" stroke="rgba(249,115,22,0.22)" stroke-width="1"/>
  <!-- Headline -->
  ${headSvg}
  <!-- Sub -->
  ${subSvg}
  <!-- Bottom bar -->
  <rect x="0" y="${BAR_Y}" width="${W}" height="${H - BAR_Y}" fill="rgba(0,0,0,0.55)"/>
  <line x1="0" y1="${BAR_Y}" x2="${W}" y2="${BAR_Y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  ${coinsSvg}
  ${fgSvg}
</svg>`;

  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return aplicarLogo(buf, 0.10);
}

// ── Banner para portada de X — 1500×500 con datos del día ─────
// datos: { btc, eth, fg, dominancia, coins[] }
export async function generarBannerX({ btc, eth, fg, dominancia, coins = [] }) {
  const W = 1500, H = 500;
  const pivotX = 1200;
  const barMaxW = 200;
  const barH = 22;
  const barGap = 10;
  const barsY0 = 90;

  const fmtPct   = (v) => v != null ? `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%` : "";
  const fmtPrice = (v) => v != null ? `$${Number(v).toLocaleString("es-ES")}` : "";

  const stats = [
    btc?.precio ? `BTC ${fmtPrice(btc.precio)}   ${fmtPct(btc.cambio24h_pct)}` : null,
    eth?.precio ? `ETH ${fmtPrice(eth.precio)}   ${fmtPct(eth.cambio24h_pct)}` : null,
    fg          ? `Fear & Greed: ${fg.valor}  (${fg.clasificacion})` : null,
    dominancia  ? `Dominancia BTC: ${dominancia}%` : null,
  ].filter(Boolean);

  const displayCoins = coins.slice(0, 8);
  const maxAbs = displayCoins.length
    ? Math.max(...displayCoins.map((c) => Math.abs(c.value)), 1)
    : 1;

  const barsSvg = displayCoins.map((coin, i) => {
    const isPos = coin.value >= 0;
    const w     = Math.max(4, Math.round((Math.abs(coin.value) / maxAbs) * barMaxW));
    const y     = barsY0 + i * (barH + barGap);
    const x     = isPos ? pivotX : pivotX - w;
    const col   = isPos ? "rgba(38,166,154,0.85)" : "rgba(239,83,80,0.85)";
    const pct   = `${isPos ? "+" : ""}${coin.value.toFixed(1)}%`;
    return (
      `<rect x="${x}" y="${y}" width="${w}" height="${barH}" rx="2" fill="${col}"/>` +
      `<text x="${pivotX - 6}" y="${y + 15}" text-anchor="end" font-size="12" fill="#8899aa" font-family="Arial,sans-serif">${coin.label}</text>` +
      `<text x="${isPos ? x + w + 5 : x - 5}" y="${y + 15}" text-anchor="${isPos ? "start" : "end"}" font-size="12" fill="${isPos ? "#26a69a" : "#ef5350"}" font-family="Arial,sans-serif">${pct}</text>`
    );
  }).join("");

  const statsSvg = stats.map((s, i) =>
    `<text x="80" y="${330 + i * 30}" font-size="16" fill="#536471" font-family="Arial,sans-serif">${s}</text>`
  ).join("");

  const barsBottom = barsY0 + displayCoins.length * (barH + barGap);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <pattern id="g" width="80" height="80" patternUnits="userSpaceOnUse">
      <path d="M80 0L0 0 0 80" fill="none" stroke="rgba(255,255,255,0.018)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="#0d1117"/>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect width="${W}" height="3" fill="rgba(29,155,240,0.55)"/>
  <text x="80" y="155" font-size="60" font-weight="bold" fill="#e7e9ea" font-family="Arial,sans-serif">Datos,</text>
  <text x="80" y="232" font-size="60" font-weight="bold" fill="#e7e9ea" font-family="Arial,sans-serif">no predicciones.</text>
  <text x="82" y="282" font-size="20" fill="#3d5166" font-family="Arial,sans-serif">ETFs · Derivados · Macro · Institucionales</text>
  <line x1="80" y1="305" x2="700" y2="305" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  ${statsSvg}
  <text x="${pivotX}" y="65" text-anchor="middle" font-size="11" fill="rgba(255,255,255,0.22)" font-family="Arial,sans-serif" letter-spacing="3">MERCADO HOY</text>
  <line x1="${pivotX}" y1="75" x2="${pivotX}" y2="${barsBottom}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
  ${barsSvg}
  <rect x="0" y="458" width="${W}" height="42" fill="rgba(255,255,255,0.022)"/>
  <text x="${W / 2}" y="485" text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.15)" font-family="Arial,sans-serif" letter-spacing="3">ANÁLISIS CRIPTO EN ESPAÑOL · DATOS EN TIEMPO REAL</text>
</svg>`;

  try {
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return aplicarLogo(buf, 0.06);
  } catch (e) {
    console.warn("⚠️ Banner SVG falló, usando chart de barras:", e.message);
    return generarChartBarras(coins.slice(0, 8));
  }
}

// ── Panel de mercado /mercado — F&G + dominancia + distribución + capitalización ──
// datos: { fg, global, distribucion, historial }
export async function generarPanelMercado({ fg, global, distribucion, historial = [] } = {}) {
  const W = 1080, H = 1540;
  const ORANGE = "#f97316";
  const VERDE  = "#00C896";
  const ROJO   = "#e5484d";
  const CARD   = "#12121c";
  const BORDE  = "rgba(255,255,255,0.06)";
  const GRIS   = "rgba(255,255,255,0.42)";

  const esc = (s) =>
    (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const fmtT = (v) =>
    v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(0)}B` : `$${Math.round(v / 1e6)}M`;

  const card = (x, y, w, h) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${CARD}" stroke="${BORDE}" stroke-width="1"/>`;

  const titulo = (x, y, texto) =>
    `<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="${GRIS}" letter-spacing="1.8">${esc(texto)}</text>`;

  const sinDatos = (cx, cy) =>
    `<text x="${cx}" y="${cy}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="rgba(255,255,255,0.25)">Sin datos disponibles</text>`;

  // ── Card A: medidor Fear & Greed (arco) ──────────────────────
  const GAUGE_COLORES = ["#e5484d", "#f0883e", "#f5d90a", "#7ee787", VERDE];
  const clasifES = (v) => v < 25 ? "Miedo extremo" : v < 45 ? "Miedo" : v < 55 ? "Neutral" : v < 75 ? "Codicia" : "Codicia extrema";
  const colorFG  = (v) => GAUGE_COLORES[Math.min(4, Math.floor(v / 20))];

  let gaugeSvg = "";
  {
    const cx = 285, cy = 405, r = 128, grosor = 24;
    const polar = (v) => {
      const a = Math.PI * (1 - v / 100);
      return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    };
    const arco = (v1, v2, color) => {
      const [x1, y1] = polar(v1);
      const [x2, y2] = polar(v2);
      return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${grosor}" stroke-linecap="round"/>`;
    };
    const segmentos = [0, 20, 40, 60, 80].map((ini, i) =>
      arco(ini + (i === 0 ? 0 : 1.5), ini + 20 - (i === 4 ? 0 : 1.5), GAUGE_COLORES[i])
    ).join("\n    ");

    if (fg?.valor != null) {
      const [nx, ny] = polar(fg.valor);
      const col = colorFG(fg.valor);
      gaugeSvg = `
    ${segmentos}
    <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="12" fill="#0a0a12" stroke="#ffffff" stroke-width="3"/>
    <text x="${cx}" y="${cy - 14}" text-anchor="middle" font-family="Arial,sans-serif" font-size="76" font-weight="800" fill="#ffffff">${fg.valor}</text>
    <text x="${cx}" y="${cy + 26}" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="700" fill="${col}">${esc(clasifES(fg.valor))}</text>
    ${fg.ayer != null ? `<text x="${cx}" y="${cy + 56}" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="rgba(255,255,255,0.30)">ayer: ${fg.ayer} · ${esc(clasifES(fg.ayer))}</text>` : ""}`;
    } else {
      gaugeSvg = `${segmentos}\n    ${sinDatos(cx, cy)}`;
    }
  }

  // ── Card B: dominancia BTC / ETH / Others ────────────────────
  let domSvg = "";
  {
    const bx = 590, by = 258, bw = 410, bh = 26;
    if (global?.dominancia_btc != null) {
      const pBtc = global.dominancia_btc;
      const pEth = global.dominancia_eth || 0;
      const pOtros = Math.max(0, 100 - pBtc - pEth);
      const wBtc = (pBtc / 100) * bw;
      const wEth = (pEth / 100) * bw;
      const cols = [
        { label: "BTC",    pct: pBtc,   color: "#f7931a", x: 590 },
        { label: "ETH",    pct: pEth,   color: "#627eea", x: 745 },
        { label: "Others", pct: pOtros, color: "#8b949e", x: 900 },
      ];
      const leyenda = cols.map((c) => `
    <circle cx="${c.x + 6}" cy="${by + 74}" r="6" fill="${c.color}"/>
    <text x="${c.x + 20}" y="${by + 79}" font-family="Arial,sans-serif" font-size="14" fill="${GRIS}">${esc(c.label)}</text>
    <text x="${c.x}" y="${by + 112}" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#ffffff">${c.pct.toFixed(1)}%</text>`).join("");

      domSvg = `
    <clipPath id="domclip"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="13"/></clipPath>
    <g clip-path="url(#domclip)">
      <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="#3d4451"/>
      <rect x="${bx}" y="${by}" width="${(wBtc + wEth).toFixed(1)}" height="${bh}" fill="#627eea"/>
      <rect x="${bx}" y="${by}" width="${wBtc.toFixed(1)}" height="${bh}" fill="#f7931a"/>
    </g>
    ${leyenda}
    ${global.market_cap_total_usd ? `<text x="590" y="${by + 158}" font-family="Arial,sans-serif" font-size="13" fill="rgba(255,255,255,0.30)">Market cap total: ${fmtT(global.market_cap_total_usd)} · ${global.activos_activos?.toLocaleString("es-ES") || "?"} activos</text>` : ""}`;
    } else {
      domSvg = sinDatos(795, 320);
    }
  }

  // ── Card C: distribución de ganancias y pérdidas ─────────────
  let distSvg = "";
  {
    const baseY = 852, maxH = 205, plotX = 76, slotW = 85;
    if (distribucion?.tramos?.length) {
      const maxCount = Math.max(...distribucion.tramos.map((t) => t.count), 1);
      const colorTramo = (tipo) => tipo === "sube" ? VERDE : tipo === "baja" ? ROJO : "#8b949e";
      const barras = distribucion.tramos.map((t, i) => {
        const h = Math.max(3, (t.count / maxCount) * maxH);
        const x = plotX + i * slotW + 14;
        const w = slotW - 28;
        return `
    <text x="${x + w / 2}" y="${(baseY - h - 10).toFixed(1)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="${GRIS}">${t.count}</text>
    <rect x="${x}" y="${(baseY - h).toFixed(1)}" width="${w}" height="${h.toFixed(1)}" rx="4" fill="${colorTramo(t.tipo)}"/>
    <text x="${x + w / 2}" y="${baseY + 22}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="rgba(255,255,255,0.32)">${esc(t.label)}</text>`;
      }).join("");

      const totalSB = distribucion.subida + distribucion.bajada || 1;
      const splitY = baseY + 46, splitW = 928, splitX = plotX;
      const wSube = Math.max(8, (distribucion.subida / totalSB) * splitW - 3);
      const wBaja = Math.max(8, splitW - wSube - 6);
      distSvg = `
    ${barras}
    <rect x="${splitX}" y="${splitY}" width="${wSube.toFixed(1)}" height="10" rx="5" fill="${VERDE}"/>
    <rect x="${(splitX + wSube + 6).toFixed(1)}" y="${splitY}" width="${wBaja.toFixed(1)}" height="10" rx="5" fill="${ROJO}"/>
    <text x="${splitX}" y="${splitY + 34}" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="${VERDE}">Subida ${distribucion.subida}</text>
    <text x="${splitX + splitW}" y="${splitY + 34}" text-anchor="end" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="${ROJO}">Bajada ${distribucion.bajada}</text>`;
    } else {
      distSvg = sinDatos(W / 2, 740);
    }
  }

  // ── Card D: capitalización total (curva con historial) ───────
  let capSvg = "";
  {
    const gx = 76, gw = 928, gy = 1168, gh = 240;
    const cambio = global?.cambio_market_cap_24h;
    const colCambio = cambio == null || cambio >= 0 ? VERDE : ROJO;
    const chip = cambio != null ? `
    <rect x="300" y="1076" width="120" height="34" rx="17" fill="${cambio >= 0 ? "rgba(0,200,150,0.14)" : "rgba(229,72,77,0.14)"}"/>
    <text x="360" y="1099" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="${colCambio}">${cambio >= 0 ? "▲" : "▼"} ${cambio >= 0 ? "+" : ""}${cambio.toFixed(2)}%</text>` : "";

    const cabecera = global?.market_cap_total_usd ? `
    <text x="${gx}" y="1106" font-family="Arial,sans-serif" font-size="50" font-weight="800" fill="#ffffff">${fmtT(global.market_cap_total_usd)}</text>
    ${chip}
    ${global.volumen_total_usd ? `<text x="${gx + gw}" y="1100" text-anchor="end" font-family="Arial,sans-serif" font-size="14" fill="rgba(255,255,255,0.30)">Vol 24h: ${fmtT(global.volumen_total_usd)}</text>` : ""}` : sinDatos(W / 2, 1100);

    if (historial.length >= 2) {
      const caps = historial.map((p) => p.cap);
      let min = Math.min(...caps), max = Math.max(...caps);
      const pad = Math.max((max - min) * 0.12, max * 0.002);
      min -= pad; max += pad;
      const t0 = historial[0].ts, t1 = historial[historial.length - 1].ts;
      const px = (ts) => gx + ((ts - t0) / Math.max(1, t1 - t0)) * gw;
      const py = (cap) => gy + gh - ((cap - min) / (max - min)) * gh;
      const pts = historial.map((p) => `${px(p.ts).toFixed(1)},${py(p.cap).toFixed(1)}`);
      const fechaCorta = (ts) => new Date(ts).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: process.env.TIMEZONE || "Europe/Madrid" });
      const grid = [0.25, 0.5, 0.75].map((f) => {
        const y = gy + gh * f;
        const val = max - (max - min) * f;
        return `<line x1="${gx}" y1="${y.toFixed(1)}" x2="${gx + gw}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.05)" stroke-width="1" stroke-dasharray="4 6"/>
    <text x="${gx + gw}" y="${(y - 6).toFixed(1)}" text-anchor="end" font-family="Arial,sans-serif" font-size="12" fill="rgba(255,255,255,0.25)">${fmtT(val)}</text>`;
      }).join("\n    ");

      capSvg = `
    ${cabecera}
    ${grid}
    <path d="M ${pts[0]} L ${pts.join(" L ")} L ${(gx + gw).toFixed(1)},${gy + gh} L ${gx},${gy + gh} Z" fill="url(#capgrad)"/>
    <polyline points="${pts.join(" ")}" fill="none" stroke="${VERDE}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
    <text x="${gx}" y="${gy + gh + 26}" font-family="Arial,sans-serif" font-size="12" fill="rgba(255,255,255,0.28)">${esc(fechaCorta(t0))}</text>
    <text x="${gx + gw}" y="${gy + gh + 26}" text-anchor="end" font-family="Arial,sans-serif" font-size="12" fill="rgba(255,255,255,0.28)">${esc(fechaCorta(t1))}</text>`;
    } else {
      capSvg = `
    ${cabecera}
    <text x="${W / 2}" y="${gy + gh / 2 - 12}" text-anchor="middle" font-family="Arial,sans-serif" font-size="17" fill="rgba(255,255,255,0.35)">Recopilando historial del mercado</text>
    <text x="${W / 2}" y="${gy + gh / 2 + 16}" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" fill="rgba(255,255,255,0.22)">Se guarda un punto cada hora. La curva aparecerá aquí en cuanto haya datos suficientes.</text>`;
    }
  }

  const fechaStr = new Date().toLocaleString("es-ES", {
    day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: process.env.TIMEZONE || "Europe/Madrid",
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
      <path d="M60 0 L0 0 0 60" fill="none" stroke="rgba(255,255,255,0.022)" stroke-width="0.5"/>
    </pattern>
    <linearGradient id="capgrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${VERDE}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${VERDE}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#0a0a12"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <!-- Header -->
  <circle cx="78" cy="54" r="20" fill="${ORANGE}"/>
  <text x="78" y="61" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="800" fill="#ffffff">C</text>
  <text x="110" y="61" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#ffffff" letter-spacing="2.5">CRIPTOSCOPE</text>
  <rect x="${W - 240}" y="37" width="200" height="34" rx="17" fill="rgba(249,115,22,0.18)" stroke="rgba(249,115,22,0.35)" stroke-width="1"/>
  <text x="${W - 140}" y="59" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="${ORANGE}" letter-spacing="1.5">MERCADO AHORA</text>
  <line x1="40" y1="104" x2="${W - 40}" y2="104" stroke="rgba(249,115,22,0.22)" stroke-width="1"/>

  <!-- Card A: Fear & Greed -->
  ${card(40, 134, 490, 372)}
  ${titulo(70, 176, "ÍNDICE FEAR & GREED")}
  ${gaugeSvg}

  <!-- Card B: Dominancia -->
  ${card(560, 134, 480, 372)}
  ${titulo(590, 176, "DOMINANCIA DE BITCOIN")}
  ${domSvg}

  <!-- Card C: Distribución -->
  ${card(40, 536, 1000, 424)}
  ${titulo(70, 578, "DISTRIBUCIÓN DE GANANCIAS Y PÉRDIDAS · 24H · TOP 200")}
  ${distSvg}

  <!-- Card D: Capitalización -->
  ${card(40, 990, 1000, 464)}
  ${titulo(70, 1032, "CAPITALIZACIÓN TOTAL DEL MERCADO")}
  ${capSvg}

  <!-- Footer (la esquina derecha la ocupa el logo que composita aplicarLogo) -->
  <text x="40" y="${H - 22}" font-family="Arial,sans-serif" font-size="12" fill="rgba(255,255,255,0.20)">${esc(fechaStr)} · Datos: CoinGecko · alternative.me</text>
</svg>`;

  try {
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return aplicarLogo(buf, 0.08);
  } catch (e) {
    console.warn("⚠️ Panel de mercado SVG falló:", e.message);
    return null;
  }
}

// ── Portada editorial gpt-image-1 (CriptoScope Visual Style v4.1: sala de trading institucional) ──
// CRITICAL RULE reforzada al inicio Y al final: nunca cifras legibles (serían datos inventados) NI
// frases/titulares en pantalla (gpt-image-1 destroza cualquier texto de más de 1-2 palabras: "LOE DATOS",
// "CONFIRNADO"...). Como mucho una palabra de marca; nada más se escribe en pantalla.
const MASTER_PROMPT = `Ultra-realistic cinematic photograph for a premium institutional financial news outlet, in the visual tradition of a Bloomberg terminal room caught at 2am. CRITICAL RULE, NEVER VIOLATE (this is the single most important instruction): NO readable sentences, headlines, phrases, captions or multi-word labels anywhere in the image. Text-rendering fails badly at more than one or two words, producing garbled misspelled gibberish, so the only text allowed on any screen is, at most, ONE short brand wordmark (one or two words, e.g. a real company/exchange name like "BlackRock" or "Coinbase" if the topic names one) — nothing else is written anywhere: no titles, no status words, no captions, no ticker symbols with letters. Every chart, graph or dashboard panel shows ONLY abstract shapes, lines, bars or candlesticks with NO readable numbers, prices, dollar amounts or percentages either — these would be fabricated data, not real. Scene: a dim, glass-walled institutional trading room or private office at night, one to three business-suited figures shown from behind, in profile, or as three-quarter silhouettes (never a clear frontal face), standing or seated, illuminated only by the cold glow of massive wall-mounted monitors. The dominant hero element is ONE oversized screen styled as a live financial monitoring dashboard, its content built entirely from abstract chart shapes and color blocks, not text. Smaller secondary monitors around the desk show the same abstract chart language. Beyond the glass, a dense night skyline glows in the distance, softly out of focus. Color palette: near-black navy and charcoal, cool blue-cyan screen glow, with emerald green (#00C896) reserved for the single most bullish/positive element on screen and a muted desaturated red for the bearish counterpart — consistent brand accent, used sparingly. Cinematic single-source lighting from the screens, dramatic long shadows, shallow depth of field, subtle film grain, premium editorial color grading. STRICTLY FORBIDDEN: memes, rockets, moons, bulls or bears as literal animals, laser eyes, cartoonish UI, visible keyboards or mouse in close-up, watermarks, any recognizable real person's face, clickbait-style oversized emoji graphics. 16:9. Final reminder of the critical rule: at most one short brand word on screen, zero sentences, zero headlines, zero readable numbers anywhere in the image.`;

export async function generarPortadaEditorial(tema) {
  if (!process.env.OPENAI_API_KEY) return null;

  const imgRes = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: `${MASTER_PROMPT}\n\nSubject (for mood and abstract composition ONLY — do not write this text, or any part of it, on screen): ${tema.slice(0, 1000)}`,
      n: 1,
      size: "1536x1024",
      quality: "medium",
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!imgRes.ok) {
    const err = await imgRes.text().catch(() => "");
    throw new Error(`Image API HTTP ${imgRes.status}: ${err.slice(0, 200)}`);
  }

  const imgJson = await imgRes.json();
  if (imgJson.error) throw new Error(imgJson.error.message);

  const imgData = imgJson.data?.[0];
  if (!imgData) throw new Error("No image data in response");

  // gpt-image-1 devuelve b64_json; dall-e-3 devolvía url
  if (imgData.b64_json) {
    console.log(`✅ Portada generada (b64) para: ${tema.slice(0, 60)}`);
    return Buffer.from(imgData.b64_json, "base64");
  }
  if (imgData.url) {
    const downloadRes = await fetch(imgData.url, { signal: AbortSignal.timeout(30000) });
    if (!downloadRes.ok) throw new Error(`Error descargando imagen: ${downloadRes.status}`);
    console.log(`✅ Portada generada (url) para: ${tema.slice(0, 60)}`);
    return Buffer.from(await downloadRes.arrayBuffer());
  }
  throw new Error("Sin b64_json ni url en respuesta");
}
