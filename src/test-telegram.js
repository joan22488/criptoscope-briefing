// ============================================================
// test-telegram.js - Comprueba que el bot llega al canal.
// Úsalo lo primero: npm run test-telegram
// ============================================================

import "dotenv/config";
import { enviarTelegram } from "./telegram.js";

enviarTelegram("✅ <b>CriptoScope Briefing</b> conectado correctamente. Mañana empieza el café con datos. ☕")
  .then(() => {
    console.log("✅ Mensaje enviado. Revisa tu canal de Telegram.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("❌ Fallo de conexión con Telegram:", e.message);
    console.error("   Revisa TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en el .env");
    process.exit(1);
  });
