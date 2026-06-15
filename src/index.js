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
import { enviarTelegram } from "./telegram.js";
import { verificarResultados } from "./tracker.js";
import { getPrices } from "./coindesk.js";
import { iniciarBot, isPausado, verificarAlertasPrecios, monitorNoticias } from "./bot.js";

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
      await enviarTelegram(mensaje);
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
      const { mensaje } = await ejecutarResumenSemanal();
      await enviarTelegram(mensaje);
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
        await enviarTelegram(
          `${emoji} <b>Señal ${s.resultado}</b>\n` +
          `${s.symbol} ${s.op} · Entrada ${s.entrada}\n` +
          `<i>Enviada el ${new Date(s.fecha).toLocaleDateString("es-ES")}</i>`
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

// Bot de comandos bajo demanda (long-polling — no bloquea los crons)
iniciarBot().catch((e) => console.error("❌ Bot error fatal:", e.message));

console.log("⏳ Esperando ejecuciones programadas... (Ctrl+C para salir)");
