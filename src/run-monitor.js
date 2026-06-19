// ============================================================
// run-monitor.js — Prueba del monitor de noticias RSS
// Ejecuta: npm run monitor
// ============================================================

import "dotenv/config";

const FUENTES_RSS = [
  { nombre: "CoinDesk",      url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { nombre: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { nombre: "The Block",     url: "https://www.theblock.co/rss.xml" },
  { nombre: "Decrypt",       url: "https://decrypt.co/feed" },
];

const keywords = (process.env.MONITOR_KEYWORDS || "ETF,BlackRock,SEC,Fed,FOMC,Bitcoin,halving,Ethereum,crash,pump,liquidaciones,Binance,Coinbase")
  .split(",").map((k) => k.trim().toLowerCase());

console.log("═══════════════════════════════════════");
console.log("  MONITOR RSS — Prueba aislada");
console.log(`  Keywords: ${keywords.slice(0, 5).join(", ")}...`);
console.log(`  Owner ID: ${process.env.TELEGRAM_OWNER_ID ? "✓ configurado" : "✗ TELEGRAM_OWNER_ID vacío"}`);
console.log("═══════════════════════════════════════\n");

let totalNoticias = 0;
let noticiasEnviadas = 0;

for (const fuente of FUENTES_RSS) {
  try {
    process.stdout.write(`📡 ${fuente.nombre.padEnd(16)} `);
    const res = await fetch(fuente.url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { console.log(`❌ HTTP ${res.status}`); continue; }

    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const get = (tag) => m[1].match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, "s"))?.[1]?.trim() || "";
      return { titulo: get("title"), link: get("link") };
    });

    const coinciden = items.filter((item) =>
      keywords.some((k) => item.titulo.toLowerCase().includes(k))
    );

    console.log(`✓ ${items.length} titulares — ${coinciden.length} con keywords`);
    totalNoticias += items.length;

    for (const item of coinciden.slice(0, 2)) {
      console.log(`   🔔 [${fuente.nombre}] ${item.titulo.slice(0, 80)}`);
      noticiasEnviadas++;

      if (process.env.TELEGRAM_OWNER_ID && process.env.TELEGRAM_BOT_TOKEN) {
        const body = {
          chat_id: process.env.TELEGRAM_OWNER_ID,
          text: `📰 <b>${fuente.nombre}</b>\n\n<b>${item.titulo}</b>\n\n<a href="${item.link}">Ver artículo</a>`,
          parse_mode: "HTML",
          disable_web_page_preview: false,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "⚡ Flash", callback_data: `news_flash:${encodeURIComponent(item.titulo)}` },
                { text: "📝 Hilo", callback_data: `news_hilo:${encodeURIComponent(item.titulo)}` },
              ],
              [
                { text: "🐦 Tweet X", callback_data: `news_tweet:${encodeURIComponent(item.titulo)}` },
                { text: "🙈 Ignorar", callback_data: "nopub" },
              ],
            ],
          },
        };
        const telegramRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const telegramJson = await telegramRes.json();
        if (telegramJson.ok) {
          console.log(`   ✅ Enviada a Telegram con botones`);
        } else {
          console.log(`   ❌ Telegram error: ${telegramJson.description}`);
        }
      }
    }
  } catch (e) {
    console.log(`❌ ${e.message}`);
  }
}

console.log("\n═══════════════════════════════════════");
console.log(`  Total titulares leídos: ${totalNoticias}`);
console.log(`  Noticias con keywords:  ${noticiasEnviadas}`);
if (!process.env.TELEGRAM_OWNER_ID) {
  console.log("\n  ⚠️  Falta TELEGRAM_OWNER_ID en .env");
  console.log("  Los mensajes no se enviarán a Telegram.");
} else if (noticiasEnviadas > 0) {
  console.log("\n  📱 Revisa tu Telegram — los mensajes ya llegaron.");
} else {
  console.log("\n  ℹ️  No había noticias con tus keywords en este momento.");
  console.log("  El monitor funciona — prueba añadiendo más keywords a MONITOR_KEYWORDS.");
}
console.log("═══════════════════════════════════════");
