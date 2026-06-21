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
