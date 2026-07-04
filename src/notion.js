// ============================================================
// notion.js - Integración con Notion API
// Guarda briefings y señales. Requiere NOTION_TOKEN en .env
// Setup: https://www.notion.so/my-integrations → crear integración
// ============================================================

import { Client } from "@notionhq/client";
import { cortarEnFrase } from "./text.js";

function getClient() {
  if (!process.env.NOTION_TOKEN) throw new Error("NOTION_TOKEN no configurado");
  return new Client({ auth: process.env.NOTION_TOKEN });
}

// ─── BRIEFINGS ───────────────────────────────────────────────

export async function guardarBriefingEnNotion(paquete, contexto, { conPortada = false, xPublicado = false } = {}) {
  if (!process.env.NOTION_BRIEFINGS_DB) return;
  const notion = getClient();

  const btc  = contexto?.precios?.["BTC-USD"];
  const eth  = contexto?.precios?.["ETH-USD"];
  const sol  = contexto?.precios?.["SOL-USD"];
  const mstr = contexto?.mstr;
  const liq  = contexto?.sentimiento?.liquidaciones;
  const fund = contexto?.derivados?.funding;
  const plataformas = [{ name: "Telegram" }, ...(xPublicado ? [{ name: "X" }] : [])];

  await notion.pages.create({
    parent: { database_id: process.env.NOTION_BRIEFINGS_DB },
    properties: {
      Titular:              { title:        [{ text: { content: paquete.titular || "Sin titular" } }] },
      Fecha:                { date:         { start: new Date().toISOString().split("T")[0] } },
      Estado:               { select:       { name: "Publicado" } },
      Plataformas:          { multi_select: plataformas },
      "BTC Precio":         { number: btc?.precio || 0 },
      "ETH Precio":         { number: eth?.precio || 0 },
      "SOL Precio":         { number: sol?.precio || 0 },
      "BTC % 24h":          { number: parseFloat((btc?.cambio24h_pct || 0).toFixed(2)) },
      "ETH % 24h":          { number: parseFloat((eth?.cambio24h_pct || 0).toFixed(2)) },
      "SOL % 24h":          { number: parseFloat((sol?.cambio24h_pct || 0).toFixed(2)) },
      "MSTR Precio":        { number: mstr?.precio || 0 },
      "MSTR % 24h":         { number: parseFloat((mstr?.cambio_pct || 0).toFixed(2)) },
      "Dominancia BTC":     { number: contexto?.mercadoGlobal?.dominancia_btc || 0 },
      "Fear & Greed":       { number: contexto?.sentimiento?.fearGreed?.valor || 0 },
      "Funding BTC":        { number: parseFloat((fund?.funding_rate || 0).toFixed(6)) },
      "Liquidaciones $M":   { number: liq ? parseFloat((liq.total_usd / 1e6).toFixed(2)) : 0 },
      "Con Portada":        { checkbox: conPortada },
      Narrativa:            { rich_text: [{ text: { content: paquete.narrativa_caliente || "" } }] },
      "Pregunta Comunidad": { rich_text: [{ text: { content: paquete.pregunta_comunidad || "" } }] },
      "Palabra del Día":    { rich_text: [{ text: { content: cortarEnFrase(paquete.palabra_del_dia || "", 2000) } }] },
      "Tweet X":            { rich_text: [{ text: { content: cortarEnFrase(paquete.tweet_x || "", 2000) } }] },
      "Guion Vídeo":        { rich_text: [{ text: { content: cortarEnFrase(paquete.guion_video || "", 2000) } }] },
    },
    children: [
      {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Briefing" } }] },
      },
      {
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ text: { content: cortarEnFrase((paquete.briefing || "").replace(/<[^>]+>/g, ""), 2000) } }] },
      },
      {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Thread X" } }] },
      },
      ...(paquete.thread || []).map((t) => ({
        object: "block", type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ text: { content: cortarEnFrase(t.replace(/<[^>]+>/g, ""), 2000) } }] },
      })),
      {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Guion Vídeo" } }] },
      },
      {
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ text: { content: cortarEnFrase((paquete.guion_video || "").replace(/<[^>]+>/g, ""), 2000) } }] },
      },
    ],
  });
}

// ─── PUBLICACIONES (log de todo lo publicado por el bot) ─────

export async function guardarPublicacionEnNotion({ tipo, titulo, texto, plataforma, conPortada = false, estado = "Publicado" }) {
  if (!process.env.NOTION_PUBLICACIONES_DB) return;
  const notion = getClient();
  const limpio = (texto || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

  await notion.pages.create({
    parent: { database_id: process.env.NOTION_PUBLICACIONES_DB },
    properties: {
      Título:     { title:     [{ text: { content: (titulo || "Sin título").slice(0, 200) } }] },
      Tipo:       { select:    { name: tipo || "Otro" } },
      Plataforma: { select:    { name: plataforma || "Canal" } },
      Fecha:      { date:      { start: new Date().toISOString() } },
      Portada:    { checkbox:  conPortada },
      Estado:     { select:    { name: estado } },
      Texto:      { rich_text: [{ text: { content: limpio.slice(0, 2000) } }] },
    },
  }).catch((e) => console.warn("⚠️ Notion publicación no guardada:", e.message));
}

// ─── RESUMEN SEMANAL ─────────────────────────────────────────

export async function guardarSemanalEnNotion(paquete) {
  if (!process.env.NOTION_BRIEFINGS_DB) return;
  const notion = getClient();

  await notion.pages.create({
    parent: { database_id: process.env.NOTION_BRIEFINGS_DB },
    properties: {
      Titular:              { title:     [{ text: { content: paquete.titular || "Resumen Semanal" } }] },
      Fecha:                { date:      { start: new Date().toISOString().split("T")[0] } },
      Narrativa:            { rich_text: [{ text: { content: "Resumen Semanal" } }] },
      "Pregunta Comunidad": { rich_text: [{ text: { content: paquete.pregunta_comunidad || "" } }] },
    },
    children: [
      {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Resumen de la Semana" } }] },
      },
      {
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ text: { content: (paquete.resumen || "").replace(/<[^>]+>/g, "").slice(0, 2000) } }] },
      },
      {
        object: "block", type: "heading_2",
        heading_2: { rich_text: [{ text: { content: "Guion Vídeo" } }] },
      },
      {
        object: "block", type: "paragraph",
        paragraph: { rich_text: [{ text: { content: (paquete.guion_video || "").slice(0, 2000) } }] },
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

  const res = await notion.dataSources.query({
    data_source_id: process.env.NOTION_SIGNALS_DB,
    filter: { property: "Resultado", select: { equals: "PENDIENTE" } },
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

  const res = await notion.dataSources.query({
    data_source_id: process.env.NOTION_SIGNALS_DB,
    filter: { property: "Fecha", date: { on_or_after: hace7d.toISOString().split("T")[0] } },
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
