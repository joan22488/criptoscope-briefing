// ============================================================
// webhook.js — Servidor HTTP
//   POST /webhook/tradingview?token=...  → alertas de TradingView
//   /api/*                               → REST API para Mini App
// ============================================================

import { createServer } from "http";
import { procesarAlertaTradingView } from "./bot.js";
import { manejarAPI } from "./api.js";

const PORT   = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || "criptoscope-tv";

export function iniciarWebhookServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Leer body una sola vez para todos los métodos que lo necesiten
    let body = "";
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks).toString("utf8").trim();
    }

    // Health check
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("CriptoScope OK");
      return;
    }

    // Mini App API
    if (url.pathname.startsWith("/api/")) {
      await manejarAPI(req, res, url, body);
      return;
    }

    // TradingView webhook
    if (req.method !== "POST") {
      res.writeHead(405); res.end(); return;
    }

    if (url.pathname !== "/webhook/tradingview") {
      res.writeHead(404); res.end(); return;
    }

    const token = url.searchParams.get("token");
    if (token !== SECRET) {
      console.warn("⚠️ Webhook: token inválido —", req.headers["x-forwarded-for"] || "IP desconocida");
      res.writeHead(401); res.end("Unauthorized"); return;
    }

    // Responder 200 inmediatamente (TradingView reintenta si no recibe respuesta rápida)
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");

    if (!body) return;
    console.log(`🔔 TradingView webhook recibido: ${body.slice(0, 120)}`);

    procesarAlertaTradingView(body).catch((e) =>
      console.error("⚠️ Error procesando alerta TV:", e.message)
    );
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🔗 Webhook server en puerto ${PORT}`);
    console.log(`   TradingView: /webhook/tradingview?token=${SECRET}`);
    console.log(`   Mini App API: /api/*`);
  });

  server.on("error", (e) => console.error("❌ Webhook server error:", e.message));

  return server;
}
