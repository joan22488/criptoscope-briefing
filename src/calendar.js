// ============================================================
// calendar.js - Calendario económico de alto impacto
// Fuente: ForexFactory RSS (gratis, sin key)
// Filtra eventos que mueven crypto: Fed, CPI, NFP, PPI, FOMC
// ============================================================

const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";

const EVENTOS_CRIPTO = [
  "nonfarm payrolls", "nfp",
  "cpi", "consumer price index",
  "ppi", "producer price index",
  "fomc", "federal reserve", "fed rate", "interest rate decision",
  "gdp", "gross domestic product",
  "unemployment", "jobless claims",
  "retail sales",
  "pce", "personal consumption",
  "jackson hole",
  "etf", "sec",
];

export async function getEventosMacro() {
  try {
    const res = await fetch(FF_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CriptoScope/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    const eventos = [...xml.matchAll(/<event>([\s\S]*?)<\/event>/g)].map((m) => {
      const get = (tag) => {
        const match = m[1].match(new RegExp(`<${tag}>(.*?)<\/${tag}>`));
        return match ? match[1].trim() : "";
      };
      return {
        titulo: get("title"),
        pais: get("country"),
        fecha: get("date"),
        hora: get("time"),
        impacto: get("impact"),
        prevision: get("forecast"),
        anterior: get("previous"),
      };
    });

    // Solo USD de alto impacto que impacten crypto
    const relevantes = eventos.filter((e) => {
      if (e.pais !== "USD") return false;
      if (e.impacto !== "High") return false;
      const titulo = e.titulo.toLowerCase();
      return EVENTOS_CRIPTO.some((k) => titulo.includes(k));
    });

    // Separar hoy y mañana
    const hoy = new Date();
    const manana = new Date(hoy);
    manana.setDate(hoy.getDate() + 1);
    const fmtFF = (d) => d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }).replace(",", "");

    return {
      hoy: relevantes.filter((e) => {
        const d = new Date(e.fecha);
        return d.toDateString() === hoy.toDateString();
      }),
      manana: relevantes.filter((e) => {
        const d = new Date(e.fecha);
        return d.toDateString() === manana.toDateString();
      }),
      semana: relevantes,
    };
  } catch (e) {
    console.warn("⚠️  Calendario económico no disponible:", e.message);
    return { hoy: [], manana: [], semana: [] };
  }
}

export function formatearAlertaMacro(eventos) {
  if (!eventos.manana?.length && !eventos.hoy?.length) return null;

  let msg = `⚠️ <b>CRIPTOSCOPE | Alerta Macro</b>\n\n`;

  if (eventos.hoy.length) {
    msg += `<b>📅 HOY</b>\n`;
    for (const e of eventos.hoy) {
      msg += `• <b>${e.titulo}</b> — ${e.hora} ET`;
      if (e.prevision) msg += ` · Prev: ${e.prevision}`;
      if (e.anterior) msg += ` · Ant: ${e.anterior}`;
      msg += "\n";
    }
    msg += "\n";
  }

  if (eventos.manana.length) {
    msg += `<b>📅 MAÑANA</b>\n`;
    for (const e of eventos.manana) {
      msg += `• <b>${e.titulo}</b> — ${e.hora} ET`;
      if (e.prevision) msg += ` · Prev: ${e.prevision}`;
      if (e.anterior) msg += ` · Ant: ${e.anterior}`;
      msg += "\n";
    }
    msg += "\n";
  }

  msg += `<i>Datos macro de alto impacto — pueden generar volatilidad en crypto</i>`;
  return msg;
}
