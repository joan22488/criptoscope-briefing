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
