// ============================================================
// editorial.js - Pipeline editorial autónomo (guion semanal X)
// Genera tweet según el día, envía borrador al owner y publica
// tras EDITORIAL_DELAY_MIN minutos si no se cancela.
// No interfiere con señales técnicas ni briefing existentes.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { getMarketContext } from "./coindesk.js";
import { getContextoDerivadosBTC } from "./signals.js";
import { getEventosMacro } from "./calendar.js";
import { publicarTweetUnico, subirImagenX } from "./twitter-post.js";
import { generarChartBarras, aplicarLogo } from "./media.js";

const client = new Anthropic();
const PENDING_FILE = "./data/pending_editorial.json";

// ── Utilidades ────────────────────────────────────────────────

function notificarOwner(texto) {
  const ownerId = process.env.TELEGRAM_OWNER_ID;
  if (!ownerId) return Promise.resolve();
  return fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ownerId, text: texto, parse_mode: "HTML" }),
    }
  ).catch(() => {});
}

function guardarPendiente(data) {
  if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify({ ...data, ts: Date.now() }));
}

function leerPendiente() {
  try {
    if (!existsSync(PENDING_FILE)) return null;
    return JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  } catch { return null; }
}

export function cancelarEditorial() {
  const pendiente = leerPendiente();
  if (!pendiente || pendiente.cancelado || pendiente.publicado) return false;
  guardarPendiente({ ...pendiente, cancelado: true });
  return true;
}

// ── Tipo de tweet según día ───────────────────────────────────

const TIPO_POR_DIA = {
  0: "domingo_principal",
  1: "lunes_etf",
  2: "martes_institucional",
  3: "miercoles_educativo",
  6: "sabado_historico",
  // 4 (jue) y 5 (vie): solo si hay macro — no se programa automático
};

// ── Contexto de mercado ───────────────────────────────────────

async function construirContexto() {
  const [contexto, derivados, eventosMacro] = await Promise.all([
    getMarketContext(),
    getContextoDerivadosBTC().catch(() => null),
    getEventosMacro().catch(() => null),
  ]);

  const btc  = contexto.precios?.["BTC-USD"];
  const eth  = contexto.precios?.["ETH-USD"];
  const fg   = contexto.sentimiento?.fearGreed;
  const gm   = contexto.mercadoGlobal;
  const mstr = contexto.mstr;

  const lineas = [];
  if (btc?.precio)        lineas.push(`BTC: $${btc.precio.toLocaleString("es-ES")} (${btc.cambio24h_pct >= 0 ? "+" : ""}${btc.cambio24h_pct?.toFixed(2)}% 24h)`);
  if (eth?.precio)        lineas.push(`ETH: $${eth.precio.toLocaleString("es-ES")} (${eth.cambio24h_pct >= 0 ? "+" : ""}${eth.cambio24h_pct?.toFixed(2)}% 24h)`);
  if (mstr?.precio)       lineas.push(`MSTR (Strategy): $${mstr.precio} (${mstr.cambio_pct >= 0 ? "+" : ""}${mstr.cambio_pct}% hoy)`);
  if (fg)                 lineas.push(`Fear & Greed: ${fg.valor} (${fg.clasificacion})`);
  if (gm?.dominancia_btc) lineas.push(`Dominancia BTC: ${gm.dominancia_btc}%`);
  if (derivados?.resumen) lineas.push(`Derivados: ${derivados.resumen}`);

  // Eventos macro próximos (hoy + mañana)
  const DIAS_ED = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const proxEventos = [...(eventosMacro?.hoy || []), ...(eventosMacro?.manana || [])];
  if (proxEventos.length) {
    const resumenMacro = proxEventos.map((e) => {
      const d   = new Date(e.date);
      const dia = DIAS_ED[d.getDay()] || "?";
      const imp = e.impact === "High" ? "🔴" : "🟡";
      return `${imp} ${dia} ${e.time || "?"} ET: ${e.title}${e.forecast ? ` (prev: ${e.forecast})` : ""}`;
    }).join(" | ");
    lineas.push(`Macro próximo: ${resumenMacro}`);
  }

  const noticias = (contexto.noticias || [])
    .slice(0, 5)
    .map((n) => `- ${n.titulo}`)
    .join("\n");

  // Chart: mismo criterio que el briefing — ganadores + perdedores del día
  const gl = contexto.gainersLosers;
  let coins = gl
    ? [
        ...gl.ganadores.map((g) => ({ label: `$${g.simbolo}`, value: parseFloat(g.cambio) })),
        ...gl.perdedores.map((p) => ({ label: `$${p.simbolo}`, value: parseFloat(p.cambio) })),
      ]
    : [];

  // Añadir BTC/ETH/SOL si no están ya
  const existentes = new Set(coins.map((c) => c.label));
  for (const [id, d] of Object.entries(contexto.precios || {})) {
    const label = `$${id.replace("-USD", "")}`;
    if (!existentes.has(label) && d.cambio24h_pct != null) {
      coins.push({ label, value: parseFloat(d.cambio24h_pct.toFixed(2)) });
    }
  }

  // Top 5 ganadores + top 5 perdedores (máx 10 barras)
  const sorted = [...coins].sort((a, b) => b.value - a.value);
  const top    = sorted.slice(0, 5);
  const bottom = sorted.slice(-Math.min(5, Math.max(0, sorted.length - top.length)));
  coins = [...new Map([...top, ...bottom].map((c) => [c.label, c])).values()];

  return {
    resumen:  lineas.join("\n"),
    noticias,
    derivados: derivados?.resumen || "no disponible",
    coins,
  };
}

// ── Prompts por tipo de día ───────────────────────────────────

const VOZ = `REGLAS DE VOZ (innegociable):
- Castellano neutro y directo. Cero frases de IA.
- Voz activa. Frases cortas.
- PROHIBIDO guiones medios o largos (– o —): sustitúyelos por punto o dos puntos.
- PROHIBIDO empezar con "Hoy", "El mercado" o "BTC ha".
- Sin HTML, sin links, sin menciones, sin CTAs de Telegram.
- Sin hashtags. Sin firma.
- Máx 3 emojis funcionales (📊🔴🟢⚠️🚨🎯). Nunca al final de frase.
- Responde SOLO el texto del tweet, sin comillas ni explicación.`;

function promptLunesEtf(ctx) {
  return `${VOZ}

Datos actuales de mercado:
${ctx.resumen}

Noticias recientes:
${ctx.noticias}

TIPO HOY: Lunes — Flujo ETF / dato institucional más impactante

Escribe UN tweet de 210-240 caracteres:
LÍNEA 1 (gancho, 90-110 chars): emoji urgente + dato ETF con cifra exacta si aparece en noticias, o el dato de mercado más impactante.
LÍNEA 2 (desarrollo, 110-130 chars): qué implica para el precio, nivel exacto a vigilar, termina con pregunta de elección forzada.`;
}

function promptMartesInstitucional(ctx) {
  return `${VOZ}

Datos actuales de mercado:
${ctx.resumen}

Noticias recientes:
${ctx.noticias}

TIPO HOY: Martes — Ángulo institucional (Grayscale, Strategy, ETF, fundaciones, ballenas)

Escribe UN tweet de 210-240 caracteres:
LÍNEA 1 (gancho): hecho institucional llamativo con nombre concreto y dato numérico.
LÍNEA 2 (desarrollo): por qué importa para el precio o qué cambiaría si continúa. Termina con paradoja o pregunta.

Técnica preferida: contrarian. Ejemplo: "[Entidad] no [acción obvia]. [Lo que realmente hace]."`;
}

function promptMiercolesEducativo(ctx) {
  return `${VOZ}

Datos actuales de mercado:
${ctx.resumen}

TIPO HOY: Miércoles — Concepto educativo conectado al mercado hoy

Elige el concepto cripto o macro más relevante ahora (OI, funding, L/S ratio, dominancia, liquidaciones, RSI, etc.)
Escribe UN tweet de 210-240 caracteres:
LÍNEA 1: "Hoy se habla mucho de [concepto]. [Qué es en una frase, sin academicismo]."
LÍNEA 2: "Cuando [condición A], suele significar [implicación A]. Ahora mismo BTC está en ese escenario." (o B si aplica).`;
}

function promptSabadoHistorico(ctx) {
  return `${VOZ}

Datos actuales de mercado:
${ctx.resumen}

TIPO HOY: Sábado — Patrón histórico de BTC o ETH relevante ahora

Escribe UN tweet de 210-240 caracteres:
LÍNEA 1: "[Activo] lleva [X tiempo] [comportamiento concreto]. Las últimas [N] veces que pasó esto:"
LÍNEA 2: resultado histórico más relevante + diferencia de contexto actual. Termina con pregunta abierta.

Solo usa patrones verificables y conocidos (halvings, capitulaciones, acumulación con OI bajo, etc.).
No inventes cifras históricas.`;
}

function promptDomingoPrincipal(ctx) {
  return `${VOZ}

Datos actuales de mercado:
${ctx.resumen}

Derivados en detalle:
${ctx.derivados}

Noticias recientes:
${ctx.noticias}

TIPO HOY: Domingo — El tweet más importante de la semana. Formato institucional + derivados.

Escribe UN tweet de 220-250 caracteres:
LÍNEA 1 (gancho, 90-110 chars): 🚨 o ⚠️ + hecho institucional impactante con cifra exacta. Para el scroll.
LÍNEA 2 (contexto, 70-80 chars): dato de derivados que amplifica (OI, top L/S, taker). Qué dice el smart money.
LÍNEA 3 (tensión, 50-60 chars): qué señal falta para confirmar dirección. Sin resolver.`;
}

const PROMPTS = {
  lunes_etf:            promptLunesEtf,
  martes_institucional: promptMartesInstitucional,
  miercoles_educativo:  promptMiercolesEducativo,
  sabado_historico:     promptSabadoHistorico,
  domingo_principal:    promptDomingoPrincipal,
};

// ── Pipeline principal ────────────────────────────────────────

export async function ejecutarEditorial() {
  const dia  = new Date().getDay();
  const tipo = TIPO_POR_DIA[dia];

  if (!tipo) {
    console.log("📝 Editorial: sin slot automático hoy (jue/vie — solo con macro)");
    return;
  }

  const DELAY_MIN = parseInt(process.env.EDITORIAL_DELAY_MIN || "10");
  console.log(`📝 Editorial [${tipo}]: generando tweet...`);

  try {
    const ctx      = await construirContexto();
    const promptFn = PROMPTS[tipo];

    const response = await client.messages.create({
      model:      process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 350,
      system:     "Redactor de CriptoScope. Responde SOLO el texto del tweet, sin comillas ni explicación adicional.",
      messages:   [{ role: "user", content: promptFn(ctx) }],
    });

    const tweetTexto = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .replace(/ [–—] /g, ": ")
      .replace(/[–—]/g, ".");

    if (!tweetTexto) throw new Error("Claude devolvió texto vacío");

    // Generar chart (buffer en memoria — no serializable, se regenera si se cancela)
    let imagenBuffer = null;
    if (ctx.coins.length) {
      imagenBuffer = await generarChartBarras(ctx.coins)
        .then((b) => (b ? aplicarLogo(b) : null))
        .catch(() => null);
    }

    // Guardar estado pendiente
    guardarPendiente({ tipo, texto: tweetTexto, conImagen: !!imagenBuffer, cancelado: false, publicado: false });

    // Borrador al owner
    const tipoLabel = tipo.replace(/_/g, " ");
    await notificarOwner(
      `📝 <b>BORRADOR EDITORIAL</b> (${tipoLabel})\n\n` +
      `${tweetTexto}\n\n` +
      `<i>Publicando en X en ${DELAY_MIN} min. Escribe /cancelar_editorial para detener.</i>`
    );
    console.log(`📝 Borrador enviado. Publicando en ${DELAY_MIN} min si no se cancela.`);

    // Publicar tras delay
    setTimeout(async () => {
      const pendiente = leerPendiente();
      if (!pendiente || pendiente.cancelado) {
        console.log("📝 Tweet editorial cancelado.");
        await notificarOwner("❌ Tweet editorial cancelado — no se publicó en X.");
        return;
      }

      try {
        let mediaId = null;
        if (imagenBuffer) {
          mediaId = await subirImagenX(imagenBuffer).catch(() => null);
        }
        await publicarTweetUnico(tweetTexto, mediaId ? { mediaId } : {});
        console.log("✅ Tweet editorial publicado en X.");
        await notificarOwner("✅ Tweet editorial publicado en X.");
        guardarPendiente({ ...pendiente, publicado: true, cancelado: false });
      } catch (e) {
        console.warn("⚠️ Error publicando tweet editorial:", e.message);
        await notificarOwner(`⚠️ <b>Error publicando tweet editorial</b>\n<code>${e.message.slice(0, 200)}</code>`);
      }
    }, DELAY_MIN * 60 * 1000);

  } catch (e) {
    console.warn("⚠️ Pipeline editorial fallido:", e.message);
    await notificarOwner(`⚠️ <b>Editorial fallido</b>\n<code>${e.message.slice(0, 200)}</code>`);
  }
}
