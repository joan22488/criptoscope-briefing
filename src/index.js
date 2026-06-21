// ============================================================
// index.js - Arranque con programación diaria (node-cron)
// Ejecuta: npm start  →  queda esperando y publica cada mañana
// ============================================================

import "dotenv/config";
import cron from "node-cron";
import { ejecutarBriefing } from "./pipeline.js";
import { ejecutarAnalisisTecnico } from "./signals.js";
import { ejecutarResumenSemanal } from "./weekly.js";
import { verificarAlertas } from "./alerts.js";
import { getEventosMacro, formatearResumenSemana } from "./calendar.js";
import { enviarTelegram, enviarTelegramConFoto, enviarTelegramConFotoId } from "./telegram.js";
import { getPortadaFija } from "./portadas_fijas.js";
import { verificarResultados } from "./tracker.js";
import { getPrices } from "./coindesk.js";
import { iniciarBot, isPausado, verificarAlertasPrecios, monitorNoticias, ejecutarRecapDiario, enviarSenalParaRevisar } from "./bot.js";
import { iniciarWebhookServer } from "./webhook.js";

const horario = process.env.CRON_SCHEDULE || "0 7 * * *";
const horarioSenales = process.env.SIGNALS_SCHEDULE || "0 7,11,15,19 * * *";
const horarioSemanal = process.env.WEEKLY_SCHEDULE || "0 9 * * 0"; // Domingos 9:00
const horarioAlertas = process.env.ALERTS_SCHEDULE || "*/30 * * * *"; // Cada 30 min
const zona = process.env.TIMEZONE || "Europe/Madrid";

console.log("═══════════════════════════════════════");
console.log("  CRIPTOSCOPE - Modo automático");
console.log(`  Briefing:  ${horario} (${zona})`);
console.log(`  Señales:   ${horarioSenales} (${zona})`);
console.log(`  Semanal:   ${horarioSemanal} (${zona})`);
console.log(`  Macro lun: 0 8 * * 1 (${zona})`);
console.log(`  Alertas:   ${horarioAlertas}`);
console.log(`  Bot:       activo (long-polling)`);
console.log("═══════════════════════════════════════");

// Envía un aviso de error solo al owner (privado), nunca al canal público
const alertarOwner = async (msg) => {
  const ownerId = process.env.TELEGRAM_OWNER_ID;
  if (!ownerId) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ownerId, text: msg, parse_mode: "HTML" }),
    });
  } catch {}
};

// Briefing matinal diario
cron.schedule(
  horario,
  async () => {
    if (isPausado()) return console.log("⏸ Briefing omitido (pausado)");
    try {
      await ejecutarBriefing();
    } catch (e) {
      console.error("❌ Error en el briefing:", e.message);
      await alertarOwner(`⚠️ <b>Briefing fallido</b>\n<code>${e.message.slice(0, 300)}</code>`);
    }
  },
  { timezone: zona }
);

// Análisis técnico BTC + ETH + SOL cada 4h
cron.schedule(
  horarioSenales,
  async () => {
    if (isPausado()) return console.log("⏸ Señales omitidas (pausado)");
    try {
      const { mensaje } = await ejecutarAnalisisTecnico();
      await enviarSenalParaRevisar(mensaje); // → owner revisa antes de publicar al canal
    } catch (e) {
      console.error("❌ Error en análisis técnico:", e.message);
      await alertarOwner(`⚠️ <b>Análisis técnico fallido</b>\n<code>${e.message.slice(0, 300)}</code>`);
    }
  },
  { timezone: zona }
);

// Resumen semanal — domingos a las 9:00
cron.schedule(
  horarioSemanal,
  async () => {
    if (isPausado()) return console.log("⏸ Semanal omitido (pausado)");
    try {
      const { mensaje, chartBuffer } = await ejecutarResumenSemanal();
      const portadaFijaId = getPortadaFija("semanal");
      if (portadaFijaId) {
        await enviarTelegramConFotoId(mensaje, portadaFijaId);
      } else if (chartBuffer) {
        await enviarTelegramConFoto(mensaje, chartBuffer);
      } else {
        await enviarTelegram(mensaje);
      }
    } catch (e) {
      console.error("❌ Error en resumen semanal:", e.message);
      await alertarOwner(`⚠️ <b>Resumen semanal fallido</b>\n<code>${e.message.slice(0, 300)}</code>`);
    }
  },
  { timezone: zona }
);

// Monitor de alertas de alto impacto — cada 30 minutos
cron.schedule(
  horarioAlertas,
  async () => {
    try {
      if (!isPausado()) {
        const alerta = await verificarAlertas();
        if (alerta) {
          console.log("🚨 Alerta de evento detectada — enviando a Telegram");
          await enviarTelegram(alerta);
        }
      }
    } catch (e) {
      console.warn("⚠️  Monitor de alertas falló:", e.message);
    }

    // Verificar resultados de señales pendientes (cada 30min junto con alertas)
    try {
      const precios = await getPrices();
      const preciosMap = {
        BTC: precios["BTC-USD"]?.precio,
        ETH: precios["ETH-USD"]?.precio,
        SOL: precios["SOL-USD"]?.precio,
      };
      const actualizadas = await verificarResultados(preciosMap);
      for (const s of actualizadas) {
        const emoji = s.resultado.includes("TP") ? "✅" : "❌";
        // Aviso público al canal (breve)
        await enviarTelegram(
          `${emoji} <b>Señal ${s.resultado}</b>\n` +
          `${s.symbol} ${s.op} · Entrada ${s.entrada || "?"}\n` +
          `<i>Enviada el ${new Date(s.fecha).toLocaleDateString("es-ES")}</i>`
        );
        // Notificación privada al owner con todos los detalles
        await alertarOwner(
          `${emoji} <b>Señal ${s.resultado}</b> — ${s.symbol} ${s.op}\n\n` +
          (s.entrada ? `Entrada: <b>${s.entrada}</b>\n` : "") +
          `TP1: ${s.tp1 || "?"}  ·  TP2: ${s.tp2 || "?"}  ·  SL: ${s.sl || "?"}\n` +
          (s.rr ? `R:R: ${s.rr}\n` : "") +
          `<i>Señal del ${new Date(s.fecha).toLocaleDateString("es-ES", { day: "numeric", month: "long" })}</i>`
        );
      }
    } catch (e) {
      // silencioso — no crítico
    }
  }
);

// Alertas de precio — cada 5 minutos
cron.schedule("*/5 * * * *", async () => {
  await verificarAlertasPrecios().catch(() => {});
}, { timezone: zona });

// Monitor de noticias — cada 15 minutos
cron.schedule("*/15 * * * *", async () => {
  await monitorNoticias().catch((e) => console.warn("⚠️  Monitor noticias:", e.message));
}, { timezone: zona });

// Resumen macro semanal al canal — lunes 8:00
cron.schedule("0 8 * * 1", async () => {
  if (isPausado()) return console.log("⏸ Macro lunes omitido (pausado)");
  try {
    const eventos = await getEventosMacro();
    const msg = formatearResumenSemana(eventos);
    if (msg) {
      await enviarTelegram(msg);
      console.log("📅 Resumen macro semanal enviado al canal");
    } else {
      console.log("📅 Sin eventos macro relevantes esta semana — no se publica");
    }
  } catch (e) {
    console.error("❌ Error en macro lunes:", e.message);
    await alertarOwner(`⚠️ <b>Macro lunes fallido</b>\n<code>${e.message.slice(0, 300)}</code>`);
  }
}, { timezone: zona });

// Recap diario privado al owner — 22:00
cron.schedule("0 22 * * *", async () => {
  await ejecutarRecapDiario().catch((e) => console.warn("⚠️  Recap diario:", e.message));
}, { timezone: zona });

// Bot de comandos bajo demanda (long-polling — no bloquea los crons)
iniciarBot().catch((e) => console.error("❌ Bot error fatal:", e.message));

// Servidor HTTP para webhooks de TradingView
iniciarWebhookServer();

console.log("⏳ Esperando ejecuciones programadas... (Ctrl+C para salir)");
