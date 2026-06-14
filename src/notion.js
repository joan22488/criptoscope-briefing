// ============================================================
// notion.js - Integración con Notion API
// Guarda briefings y señales. Requiere NOTION_TOKEN en .env
// Setup: https://www.notion.so/my-integrations → crear integración
// ============================================================

import { Client } from "@notionhq/client";

function getClient() {
  if (!process.env.NOTION_TOKEN) throw new Error("NOTION_TOKEN no configurado");
  return new Client({ auth: process.env.NOTION_TOKEN });
}

// ─── BRIEFINGS ───────────────────────────────────────────────

export async function guardarBriefingEnNotion(paquete, contexto) {
  if (!process.env.NOTION_BRIEFINGS_DB) return;
  const notion = getClient();

  await notion.pages.create({
    parent: { database_id: process.env.NOTION_BRIEFINGS_DB },
    properties: {
      Titular: { title: [{ text: { content: paquete.titular || "Sin titular" } }] },
      Fecha: { date: { start: new Date().toISOString().split("T")[0] } },
      "BTC Precio": { number: contexto?.precios?.["BTC-USD"]?.precio || 0 },
      "ETH Precio": { number: contexto?.precios?.["ETH-USD"]?.precio || 0 },
      "Fear & Greed": { number: contexto?.sentimiento?.fearGreed?.valor || 0 },
      Narrativa: { rich_text: [{ text: { content: paquete.narrativa_caliente || "" } }] },
      "Pregunta Comunidad": { rich_text: [{ text: { content: paquete.pregunta_comunidad || "" } }] },
    },
    children: [
      {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Briefing" } }] },
      },
      {
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ text: { content: (paquete.briefing || "").replace(/<[^>]+>/g, "").slice(0, 2000) } }] },
      },
      {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Thread X" } }] },
      },
      ...(paquete.thread || []).map((t) => ({
        object: "block", type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ text: { content: t.replace(/<[^>]+>/g, "").slice(0, 2000) } }] },
      })),
      {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Guion Vídeo" } }] },
      },
      {
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ text: { content: (paquete.guion_video || "").replace(/<[^>]+>/g, "").slice(0, 2000) } }] },
      },
    ],
  });
}

// ─── SEÑALES ─────────────────────────────────────────────────

export async function guardarSenalEnNotion(registro) {
  if (!process.env.NOTION_SIGNALS_DB) return;
  const notion = getClient();

  await notion.pages.create({
    parent: { database_id: process.env.NOTION_SIGNALS_DB },
    properties: {
      ID: { title: [{ text: { content: registro.id } }] },
      Symbol: { select: { name: registro.symbol } },
      Operación: { select: { name: registro.op } },
      Entrada: { number: registro.entrada || 0 },
      TP1: { number: registro.tp1 || 0 },
      TP2: { number: registro.tp2 || 0 },
      SL: { number: registro.sl || 0 },
      "R:R": { rich_text: [{ text: { content: registro.rr || "" } }] },
      "Precio Envío": { number: registro.precio_al_enviar || 0 },
      Fecha: { date: { start: new Date(registro.fecha).toISOString() } },
      Resultado: { select: { name: "PENDIENTE" } },
    },
  });
}

export async function obtenerSenalesPendientes() {
  if (!process.env.NOTION_SIGNALS_DB) return [];
  const notion = getClient();

  const res = await notion.request({
    path: `databases/${process.env.NOTION_SIGNALS_DB}/query`,
    method: "POST",
    body: { filter: { property: "Resultado", select: { equals: "PENDIENTE" } } },
  });

  return res.results.map((p) => ({
    id: p.id,
    symbol: p.properties.Symbol?.select?.name,
    op: p.properties["Operación"]?.select?.name,
    tp1: p.properties.TP1?.number,
    tp2: p.properties.TP2?.number,
    sl: p.properties.SL?.number,
    fecha: p.properties.Fecha?.date?.start,
  }));
}

export async function actualizarResultadoSenal(pageId, resultado) {
  if (!process.env.NOTION_SIGNALS_DB) return;
  const notion = getClient();

  await notion.pages.update({
    page_id: pageId,
    properties: {
      Resultado: { select: { name: resultado } },
      "Resultado Fecha": { date: { start: new Date().toISOString() } },
    },
  });
}

export async function obtenerSenalesSemana() {
  if (!process.env.NOTION_SIGNALS_DB) return [];
  const notion = getClient();

  const hace7d = new Date();
  hace7d.setDate(hace7d.getDate() - 7);

  const res = await notion.request({
    path: `databases/${process.env.NOTION_SIGNALS_DB}/query`,
    method: "POST",
    body: { filter: { property: "Fecha", date: { on_or_after: hace7d.toISOString().split("T")[0] } } },
  });

  return res.results
    .filter((p) => p.properties["Operación"]?.select?.name !== "ESPERAR")
    .map((p) => ({
      id: p.id,
      symbol: p.properties.Symbol?.select?.name,
      op: p.properties["Operación"]?.select?.name,
      resultado: p.properties.Resultado?.select?.name || "PENDIENTE",
      fecha: p.properties.Fecha?.date?.start,
    }));
}
