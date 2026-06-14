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
console.log("═══════════════════════════════════════");

// Briefing matinal diario
cron.schedule(
  horario,
  async () => {
    try {
      await ejecutarBriefing();
    } catch (e) {
      console.error("❌ Error en el briefing:", e.message);
      try { await enviarTelegram(`⚠️ El briefing de hoy ha fallado: ${e.message}`, { silencioso: true }); } catch {}
    }
  },
  { timezone: zona }
);

// Análisis técnico BTC + ETH + SOL cada 4h
cron.schedule(
  horarioSenales,
  async () => {
    try {
      const { mensaje } = await ejecutarAnalisisTecnico();
      await enviarTelegram(mensaje);
    } catch (e) {
      console.error("❌ Error en análisis técnico:", e.message);
      try { await enviarTelegram(`⚠️ Análisis técnico fallido: ${e.message}`, { silencioso: true }); } catch {}
    }
  },
  { timezone: zona }
);

// Resumen semanal — domingos a las 9:00
cron.schedule(
  horarioSemanal,
  async () => {
    try {
      const { mensaje } = await ejecutarResumenSemanal();
      await enviarTelegram(mensaje);
    } catch (e) {
      console.error("❌ Error en resumen semanal:", e.message);
      try { await enviarTelegram(`⚠️ Resumen semanal fallido: ${e.message}`, { silencioso: true }); } catch {}
    }
  },
  { timezone: zona }
);

// Monitor de alertas de alto impacto — cada 30 minutos
cron.schedule(
  horarioAlertas,
  async () => {
    try {
      const alerta = await verificarAlertas();
      if (alerta) {
        console.log("🚨 Alerta de evento detectada — enviando a Telegram");
        await enviarTelegram(alerta);
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

console.log("⏳ Esperando ejecuciones programadas... (Ctrl+C para salir)");
