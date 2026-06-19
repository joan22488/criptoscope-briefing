// ============================================================
// webhook.js — Servidor HTTP para recibir alertas de TradingView
// Endpoint: POST /webhook/tradingview?token=WEBHOOK_SECRET
// ============================================================

import { createServer } from "http";
import { procesarAlertaTradingView } from "./bot.js";

const PORT   = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || "criptoscope-tv";

export function iniciarWebhookServer() {
  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("CriptoScope OK");
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405); res.end(); return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname !== "/webhook/tradingview") {
      res.writeHead(404); res.end(); return;
    }

    // Validar token secreto
    const token = url.searchParams.get("token");
    if (token !== SECRET) {
      console.warn("⚠️ Webhook: token inválido —", req.headers["x-forwarded-for"] || "IP desconocida");
      res.writeHead(401); res.end("Unauthorized"); return;
    }

    // Leer body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8").trim();

    // Responder 200 inmediatamente (TradingView reintenta si no recibe respuesta rápida)
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");

    if (!body) return;
    console.log(`🔔 TradingView webhook recibido: ${body.slice(0, 120)}`);

    // Procesar de forma asíncrona (ya respondimos 200)
    procesarAlertaTradingView(body).catch((e) =>
      console.error("⚠️ Error procesando alerta TV:", e.message)
    );
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🔗 Webhook server en puerto ${PORT}`);
    console.log(`   Endpoint: /webhook/tradingview?token=${SECRET}`);
  });

  server.on("error", (e) => console.error("❌ Webhook server error:", e.message));

  return server;
}
