// Ejecuta el análisis técnico una vez ahora mismo
// Uso: node src/run-signals.js
import "dotenv/config";
import { ejecutarAnalisisTecnico } from "./signals.js";
import { enviarTelegram } from "./telegram.js";

const { mensaje } = await ejecutarAnalisisTecnico();
await enviarTelegram(mensaje);
console.log("✅ Análisis enviado a Telegram");
process.exit(0);
