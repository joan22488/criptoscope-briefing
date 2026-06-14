// ============================================================
// claude.js - Generación del briefing con la API de Claude
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { VOZ_CRIPTOSCOPE, INSTRUCCIONES_BRIEFING } from "./prompts.js";

const client = new Anthropic(); // Lee ANTHROPIC_API_KEY del entorno automáticamente

/**
 * Genera el paquete completo del día (briefing + guion + thread + pregunta)
 * en UNA sola llamada. Una llamada = coherencia total entre formatos y menos coste.
 */
export async function generarPaqueteDiario(contextoMercado) {
  const fecha = new Date().toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: process.env.TIMEZONE || "Europe/Madrid",
  });

  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 4000,
    system: VOZ_CRIPTOSCOPE,
    messages: [
      {
        role: "user",
        content: `Fecha de hoy: ${fecha}

CONTEXTO DE MERCADO (datos reales):
${JSON.stringify({ ...contextoMercado, gainersLosers: undefined }, null, 1)}

${INSTRUCCIONES_BRIEFING}`,
      },
    ],
  });

  // Extraemos el texto y parseamos el JSON con tolerancia a backticks
  const texto = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // Extraer el bloque JSON — busca desde el primer { hasta el último }
  const inicio = texto.indexOf("{");
  const fin = texto.lastIndexOf("}");
  const limpio = inicio !== -1 && fin !== -1
    ? texto.slice(inicio, fin + 1)
    : texto.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(limpio);
  } catch (e) {
    // Intento de rescate: extraer campos clave con regex
    console.warn("⚠️ JSON.parse falló, intentando rescate por regex...");
    try {
      const extraer = (campo) => {
        const m = limpio.match(new RegExp(`"${campo}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
        return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
      };
      const extraerArray = (campo) => {
        const m = limpio.match(new RegExp(`"${campo}"\\s*:\\s*\\[(.*?)\\]`, "s"));
        if (!m) return [];
        return [...m[1].matchAll(/"((?:[^"\\\\]|\\\\.)*)"/g)].map((x) =>
          x[1].replace(/\\n/g, "\n").replace(/\\"/g, '"')
        );
      };
      return {
        titular: extraer("titular") || "Briefing CriptoScope",
        briefing: extraer("briefing"),
        narrativa_caliente: extraer("narrativa_caliente"),
        guion_video: extraer("guion_video"),
        thread: extraerArray("thread"),
        pregunta_comunidad: extraer("pregunta_comunidad"),
      };
    } catch (e2) {
      console.error("❌ Rescate también falló:", e2.message);
      return {
        titular: "Briefing del día",
        briefing: limpio.slice(0, 3500),
        narrativa_caliente: "",
        guion_video: "",
        thread: [],
        pregunta_comunidad: "",
      };
    }
  }
}
