// ============================================================
// calendar.js - Calendario económico de alto impacto
// Fuente: ForexFactory RSS (gratis, sin key)
// ============================================================

// Única fuente disponible gratis: cubre lun-vie de la semana en curso.
// No existe endpoint de "semana siguiente" en este servicio (probado: 404) —
// de sáb a dom, hasta que la fuente publique la semana nueva, no habrá eventos futuros.
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

// Países cuyos datos macro nos interesan (más allá de solo EE.UU.)
const PAISES = ["USD", "EUR", "GBP", "JPY", "CNY", "AUD"];
const BANDERAS = { USD: "🇺🇸", EUR: "🇪🇺", GBP: "🇬🇧", JPY: "🇯🇵", CNY: "🇨🇳", AUD: "🇦🇺" };
const banderaDe = (country) => BANDERAS[country] || "🌐";

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
  const paises = eventos.filter((e) => PAISES.includes(e.country));

  // 1ª prioridad: Alto impacto + keyword cripto/macro
  let relevantes = paises.filter((e) => {
    if (e.impact !== "High") return false;
    return PALABRAS_CLAVE.some((k) => e.title.toLowerCase().includes(k));
  });

  // 2ª prioridad: Alto o Medio + keyword cripto/macro
  if (!relevantes.length) {
    relevantes = paises.filter((e) => {
      if (!["High", "Medium"].includes(e.impact)) return false;
      return PALABRAS_CLAVE.some((k) => e.title.toLowerCase().includes(k));
    });
  }

  // 3ª prioridad: cualquier Alto impacto de los países que seguimos (semana sin datos claros)
  if (!relevantes.length) {
    relevantes = paises.filter((e) => e.impact === "High");
  }

  return relevantes;
}

export async function getEventosMacro() {
  try {
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

    const hoy     = [];
    const manana  = [];
    const semana  = [];

    for (const e of relevantes) {
      const d = new Date(e.date);
      if (isNaN(d.getTime())) continue;
      d.setHours(0, 0, 0, 0);

      // Solo incluir hoy y fechas futuras — nunca eventos ya pasados
      if (d.getTime() >= hoyMedNoche.getTime()) semana.push(e);
      if (d.getTime() === hoyMedNoche.getTime())    hoy.push(e);
      else if (d.getTime() === mananaMedNoche.getTime()) manana.push(e);
    }

    // La fuente solo cubre lun-vie de la semana en curso. Si no queda nada por
    // delante y estamos en fin de semana, no es que no haya datos: es que la
    // fuente aún no ha publicado la semana siguiente (suele actualizar el domingo).
    const diaSemana = ahora.getDay(); // 0 domingo, 6 sábado
    const agotadaPorFinDeSemana = semana.length === 0 && (diaSemana === 0 || diaSemana === 6);

    return { hoy, manana, semana, agotadaPorFinDeSemana };
  } catch (e) {
    console.warn("⚠️  Calendario económico no disponible:", e.message);
    return { hoy: [], manana: [], semana: [], agotadaPorFinDeSemana: false };
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
      msg += `${imp} ${banderaDe(e.country)} <b>${e.title}</b> — ${e.time || "?"} ET`;
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
      msg += `${imp} ${banderaDe(e.country)} <b>${e.title}</b> — ${e.time || "?"} ET`;
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
// Formato tarjeta: separador por día, evento con bandera+hora, título y "Anterior" en su propia línea.
export function formatearResumenSemana(eventos) {
  if (!eventos.semana?.length) return null;

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
  const DIVISOR = "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬";
  const primero = ordenado[0].fecha;
  const ultimo  = ordenado[ordenado.length - 1].fecha;
  const rango = primero.getTime() === ultimo.getTime()
    ? `${primero.getDate()} ${MESES_ES[primero.getMonth()]}`
    : `${primero.getDate()} ${MESES_ES[primero.getMonth()]} – ${ultimo.getDate()} ${MESES_ES[ultimo.getMonth()]}`;

  let msg = `📅 <b>CRIPTOSCOPE | Macro de la semana</b>\n<i>${rango}</i>\n\n`;

  for (const { fecha, eventos: evs } of ordenado) {
    const diaNom = DIAS_ES[fecha.getDay()].toUpperCase();
    const diaNum = fecha.getDate();
    const mesNom = MESES_ES[fecha.getMonth()];
    msg += `${DIVISOR}\n<b>${diaNom} ${diaNum} ${mesNom}</b>\n${DIVISOR}\n`;
    for (const e of evs) {
      const imp = e.impact === "High" ? "🔴" : "🟡";
      msg += `${imp} ${e.time ? `${e.time} ET · ` : ""}<b>${e.title}</b>\n`;
      const datos = [];
      if (e.previous) datos.push(`Anterior: ${e.previous}`);
      if (e.forecast) datos.push(`Previsión: ${e.forecast}`);
      if (datos.length) msg += `   ${banderaDe(e.country)} ${datos.join(" · ")}\n`;
    }
    msg += "\n";
  }

  msg += `<i>🔴 Alto impacto · 🟡 Medio · Horarios en ET (Nueva York)</i>`;
  return msg;
}
