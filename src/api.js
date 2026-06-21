// ============================================================
// api.js — REST API para la CriptoScope Mini App
// Todos los endpoints bajo /api/* requieren auth via Telegram initData
// ============================================================

import { createHmac } from "crypto";
import { getPrices, getFearGreed, getGlobalMarket, getLiquidaciones, getGainersLosers } from "./coindesk.js";
import { generarEstadisticasSemana, obtenerTodasLasSenales } from "./tracker.js";
import { getPortadaFija } from "./portadas_fijas.js";
import { isPausado, setPausado, getSenalesPendientesReview, publicarSenalPendiente, descartarSenalPendiente } from "./bot.js";
import { getEventosMacro } from "./calendar.js";

// ── Autenticación via Telegram WebApp initData ───────────────

function verificarInitData(initDataStr) {
  try {
    const params = new URLSearchParams(initDataStr);
    const hash = params.get("hash");
    if (!hash) return false;
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secretKey = createHmac("sha256", "WebAppData")
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();
    const expectedHash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");
    return expectedHash === hash;
  } catch {
    return false;
  }
}

function esOwner(initDataStr) {
  try {
    const params = new URLSearchParams(initDataStr);
    const user = JSON.parse(params.get("user") || "{}");
    return String(user.id) === String(process.env.TELEGRAM_OWNER_ID);
  } catch {
    return false;
  }
}

function autenticar(req) {
  const auth = req.headers["authorization"] || "";
  if (!auth.startsWith("tma ")) return null;
  const initDataStr = auth.slice(4);
  return verificarInitData(initDataStr) ? initDataStr : null;
}

// ── Helpers HTTP ─────────────────────────────────────────────

function setCORS(res) {
  const origin = process.env.MINIAPP_URL || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Router ───────────────────────────────────────────────────

export async function manejarAPI(req, res, url, body) {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  const initDataStr = autenticar(req);
  if (!initDataStr) return json(res, { error: "Unauthorized" }, 401);

  const path = url.pathname;

  try {
    // GET /api/prices — precios BTC/ETH/SOL + top movers
    if (path === "/api/prices" && req.method === "GET") {
      const [precios, gainersLosers] = await Promise.all([
        getPrices().catch(() => ({})),
        getGainersLosers().catch(() => null),
      ]);
      return json(res, { precios, gainersLosers, ts: Date.now() });
    }

    // GET /api/market — Fear&Greed, dominancia, liquidaciones
    if (path === "/api/market" && req.method === "GET") {
      const [fearGreed, globalMarket, liquidaciones] = await Promise.all([
        getFearGreed().catch(() => null),
        getGlobalMarket().catch(() => null),
        getLiquidaciones().catch(() => null),
      ]);
      return json(res, { fearGreed, globalMarket, liquidaciones, ts: Date.now() });
    }

    // GET /api/signals — señales activas, historial y señales pendientes de revisión
    if (path === "/api/signals" && req.method === "GET") {
      const [stats, senales] = await Promise.all([
        generarEstadisticasSemana().catch(() => null),
        obtenerTodasLasSenales(50).catch(() => []),
      ]);
      const pendientesReview = getSenalesPendientesReview();
      return json(res, { stats, senales, pendientesReview });
    }

    // GET /api/status — estado del bot, portadas, próximas crons, macro
    if (path === "/api/status" && req.method === "GET") {
      const macro = await getEventosMacro().catch(() => ({ hoy: [], manana: [], semana: [] }));
      return json(res, {
        pausado: isPausado(),
        portadas: {
          briefing: !!getPortadaFija("briefing"),
          semanal: !!getPortadaFija("semanal"),
        },
        cronBriefing: process.env.CRON_SCHEDULE || "0 7 * * *",
        cronSemanal: process.env.WEEKLY_SCHEDULE || "0 9 * * 0",
        timezone: process.env.TIMEZONE || "Europe/Madrid",
        uptimeSegundos: Math.floor(process.uptime()),
        macro,
      });
    }

    // GET /api/macro — eventos macro de la semana
    if (path === "/api/macro" && req.method === "GET") {
      const macro = await getEventosMacro().catch(() => ({ hoy: [], manana: [], semana: [] }));
      return json(res, macro);
    }

    // POST /api/pause — pausar o reactivar el bot (solo owner)
    if (path === "/api/pause" && req.method === "POST") {
      if (!esOwner(initDataStr)) return json(res, { error: "Forbidden" }, 403);
      const data = JSON.parse(body || "{}");
      setPausado(!!data.pausado);
      return json(res, { pausado: isPausado() });
    }

    // POST /api/signals/aprobar — publica una señal pendiente en el canal (solo owner)
    if (path === "/api/signals/aprobar" && req.method === "POST") {
      if (!esOwner(initDataStr)) return json(res, { error: "Forbidden" }, 403);
      const { pid } = JSON.parse(body || "{}");
      if (!pid) return json(res, { error: "Falta pid" }, 400);
      const ok = await publicarSenalPendiente(pid);
      return json(res, { ok });
    }

    // POST /api/signals/descartar — descarta una señal pendiente (solo owner)
    if (path === "/api/signals/descartar" && req.method === "POST") {
      if (!esOwner(initDataStr)) return json(res, { error: "Forbidden" }, 403);
      const { pid } = JSON.parse(body || "{}");
      if (!pid) return json(res, { error: "Falta pid" }, 400);
      return json(res, { ok: descartarSenalPendiente(pid) });
    }

    return json(res, { error: "Not Found" }, 404);
  } catch (e) {
    console.error("❌ API error en", path, ":", e.message);
    return json(res, { error: "Internal Server Error" }, 500);
  }
}
