// ============================================================
// calendar.js - Calendario económico de alto impacto
// Fuente: ForexFactory RSS (gratis, sin key)
// ============================================================

const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

const PALABRAS_CLAVE = [
  "nonfarm payrolls", "nfp",
  "cpi", "consumer price index",
  "ppi", "producer price index",
  "fomc", "federal reserve", "fed rate", "interest rate decision",
  "gdp", "gross domestic product",
  "unemployment", "jobless claims", "initial claims", "continuing claims",
  "retail sales",
  "pce", "personal consumption",
  "jackson hole",
  "etf", "sec",
  "michigan", "consumer sentiment", "consumer confidence",
  "ism", "pmi", "manufacturing",
  "durable goods",
  "housing starts", "existing home sales", "new home sales",
  "trade balance",
];

const DIAS_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const MESES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function filtrarRelevantes(eventos) {
  const usd = eventos.filter((e) => e.country === "USD");

  // 1ª prioridad: High + keyword cripto
  let relevantes = usd.filter((e) => {
    if (e.impact !== "High") return false;
    return PALABRAS_CLAVE.some((k) => e.title.toLowerCase().includes(k));
  });

  // 2ª prioridad: High o Medium + keyword cripto
  if (!relevantes.length) {
    relevantes = usd.filter((e) => {
      if (!["High", "Medium"].includes(e.impact)) return false;
      return PALABRAS_CLAVE.some((k) => e.title.toLowerCase().includes(k));
    });
  }

  // 3ª prioridad: cualquier High USD (semana sin datos)
  if (!relevantes.length) {
    relevantes = usd.filter((e) => e.impact === "High");
  }

  return relevantes;
}

export async function getEventosMacro() {
  try {
    // ForexFactory ofrece JSON además del XML — más fácil de parsear
    const res = await fetch(FF_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CriptoScope/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const todos = await res.json(); // Array de eventos

    const relevantes = filtrarRelevantes(todos);

    const ahora = new Date();
    const hoyMedNoche = new Date(ahora); hoyMedNoche.setHours(0, 0, 0, 0);
    const mananaMedNoche = new Date(hoyMedNoche); mananaMedNoche.setDate(hoyMedNoche.getDate() + 1);
    const pasadoMedNoche = new Date(mananaMedNoche); pasadoMedNoche.setDate(mananaMedNoche.getDate() + 1);

    const hoy     = [];
    const manana  = [];
    const semana  = [];

    for (const e of relevantes) {
      const d = new Date(e.date);
      if (isNaN(d.getTime())) continue;
      d.setHours(0, 0, 0, 0);

      semana.push(e);
      if (d.getTime() === hoyMedNoche.getTime())    hoy.push(e);
      else if (d.getTime() === mananaMedNoche.getTime()) manana.push(e);
    }

    return { hoy, manana, semana };
  } catch (e) {
    console.warn("⚠️  Calendario económico no disponible:", e.message);
    return { hoy: [], manana: [], semana: [] };
  }
}

// Para alertas diarias (hoy y mañana solamente)
export function formatearAlertaMacro(eventos) {
  if (!eventos.manana?.length && !eventos.hoy?.length) return null;

  let msg = `⚠️ <b>CRIPTOSCOPE | Alerta Macro</b>\n\n`;

  if (eventos.hoy.length) {
    msg += `<b>📅 HOY</b>\n`;
    for (const e of eventos.hoy) {
      const imp = e.impact === "High" ? "🔴" : "🟡";
      msg += `${imp} <b>${e.title}</b> — ${e.time || "?"} ET`;
      if (e.forecast) msg += ` · Prev: ${e.forecast}`;
      if (e.previous) msg += ` · Ant: ${e.previous}`;
      msg += "\n";
    }
    msg += "\n";
  }

  if (eventos.manana.length) {
    msg += `<b>📅 MAÑANA</b>\n`;
    for (const e of eventos.manana) {
      const imp = e.impact === "High" ? "🔴" : "🟡";
      msg += `${imp} <b>${e.title}</b> — ${e.time || "?"} ET`;
      if (e.forecast) msg += ` · Prev: ${e.forecast}`;
      if (e.previous) msg += ` · Ant: ${e.previous}`;
      msg += "\n";
    }
    msg += "\n";
  }

  msg += `<i>Datos macro de alto impacto — pueden generar volatilidad en crypto</i>`;
  return msg;
}

// Para /calendario y el cron de los lunes — resumen completo de la semana
export function formatearResumenSemana(eventos) {
  if (!eventos.semana?.length) return null;

  let msg = `📅 <b>CRIPTOSCOPE | Macro de la semana</b>\n\n`;

  // Agrupar por día
  const porDia = {};
  for (const e of eventos.semana) {
    const d = new Date(e.date);
    if (isNaN(d.getTime())) continue;
    d.setHours(0, 0, 0, 0);
    const key = d.toDateString();
    if (!porDia[key]) porDia[key] = { fecha: d, eventos: [] };
    porDia[key].eventos.push(e);
  }

  const ordenado = Object.values(porDia).sort((a, b) => a.fecha - b.fecha);

  for (const { fecha, eventos: evs } of ordenado) {
    const diaNom = DIAS_ES[fecha.getDay()];
    const diaNum = fecha.getDate();
    const mesNom = MESES_ES[fecha.getMonth()];
    msg += `<b>${diaNom} ${diaNum} ${mesNom}</b>\n`;
    for (const e of evs) {
      const imp = e.impact === "High" ? "🔴" : "🟡";
      msg += `${imp} <b>${e.title}</b>`;
      if (e.time) msg += ` — ${e.time} ET`;
      if (e.forecast) msg += `\n   Prev: ${e.forecast}`;
      if (e.previous) msg += ` · Ant: ${e.previous}`;
      msg += "\n";
    }
    msg += "\n";
  }

  msg += `<i>🔴 Alto impacto · 🟡 Medio · Horarios en ET (Nueva York)</i>`;
  return msg;
}
