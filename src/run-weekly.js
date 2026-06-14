import "dotenv/config";
import { ejecutarResumenSemanal } from "./weekly.js";
import { enviarTelegram } from "./telegram.js";

const { mensaje } = await ejecutarResumenSemanal();
await enviarTelegram(mensaje);
console.log("✅ Resumen semanal enviado");
