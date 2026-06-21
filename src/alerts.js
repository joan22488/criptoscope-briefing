// ============================================================
// alerts.js - Detector de eventos de alto impacto
// Monitoriza noticias cada 30min y alerta si detecta algo crítico
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { getNews } from "./coindesk.js";

const client = new Anthropic();

// Palabras clave que disparan revisión profunda
const KEYWORDS_CRITICAS = [
  "hack", "exploit", "breach", "stolen", "hacked",
  "sec", "lawsuit", "ban", "banned", "illegal", "arrest",
  "etf approved", "etf rejected", "spot etf",
  "fed", "federal reserve", "interest rate", "cpi", "inflation",
  "crash", "collapse", "bankrupt", "insolvent",
  "whale", "dump", "rug pull",
  "halving", "upgrade", "merge", "fork",
  "trump", "biden", "executive order", "regulation",
  "tether", "usdt", "usdc", "depeg",
];

// Cache persistente de noticias ya alertadas — sobrevive reinicios
const ALERTADAS_FILE = "./data/alertadas.json";
function cargarAlertadas() {
  try {
    if (!existsSync(ALERTADAS_FILE)) return new Map();
    const entries = JSON.parse(readFileSync(ALERTADAS_FILE, "utf8"));
    const limite = Date.now() - 24 * 60 * 60 * 1000;
    return new Map(entries.filter(([, ts]) => ts > limite));
  } catch { return new Map(); }
}
function guardarAlertadas() {
  try {
    if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
    writeFileSync(ALERTADAS_FILE, JSON.stringify([...alertadas.entries()]));
  } catch {}
}
const alertadas = cargarAlertadas(); // Map: key → timestamp

export async function verificarAlertas() {
  try {
    const noticias = await getNews(15);
    const nuevas = noticias.filter((n) => {
      const key = n.titulo?.toLowerCase().slice(0, 60);
      if (alertadas.has(key)) return false;
      const texto = `${n.titulo} ${n.resumen}`.toLowerCase();
      return KEYWORDS_CRITICAS.some((k) => texto.includes(k));
    });

    if (nuevas.length === 0) return null;

    // Pide a Claude que evalúe si realmente es urgente
    const response = await client.messages.create({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 600,
      system: `Eres el filtro de urgencia de CriptoScope. Tu único trabajo: decidir si una noticia merece una alerta inmediata a los suscriptores. Criterio: impacto real en precio de BTC/ETH en las próximas horas. Responde SOLO JSON sin markdown.`,
      messages: [{
        role: "user",
        content: `Evalúa estas noticias y devuelve:
{"urgente": true|false, "noticia": "título de la más urgente si urgente=true", "por_que": "1 frase del impacto esperado", "alerta": "mensaje de alerta para Telegram en HTML, máx 300 caracteres, con <b>negritas</b>"}

NOTICIAS:
${nuevas.slice(0, 5).map((n) => `- ${n.titulo}: ${n.resumen?.slice(0, 150)}`).join("\n")}`,
      }],
    });

    const txt = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const inicio = txt.indexOf("{"); const fin = txt.lastIndexOf("}");
    const resultado = JSON.parse(txt.slice(inicio, fin + 1));

    if (resultado.urgente) {
      nuevas.forEach((n) => alertadas.set(n.titulo?.toLowerCase().slice(0, 60), Date.now()));
      guardarAlertadas();
      return `🚨 <b>ALERTA CRIPTOSCOPE</b>\n\n${resultado.alerta}`;
    }

    return null;
  } catch (e) {
    console.warn("⚠️  Verificación de alertas fallida:", e.message);
    return null;
  }
}
