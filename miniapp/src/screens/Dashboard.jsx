import React, { useState, useEffect, useCallback } from "react";
import { getPrices, getMarket } from "../api.js";

// ── Subcomponentes ───────────────────────────────────────────

function Skeleton({ className }) {
  return <div className={`rounded-xl bg-white/5 animate-pulse ${className}`} />;
}

function PriceCard({ symbol, data, accentColor }) {
  if (!data) return <Skeleton className="h-[76px]" />;
  const pct = data.cambio24h_pct ?? 0;
  const positivo = pct >= 0;
  return (
    <div
      className="rounded-xl p-3"
      style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-bold" style={{ color: accentColor, opacity: 0.9 }}>
          {symbol}
        </span>
        <span
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
            positivo ? "text-green-400 bg-green-400/10" : "text-red-400 bg-red-400/10"
          }`}
        >
          {positivo ? "+" : ""}{pct.toFixed(2)}%
        </span>
      </div>
      <div className="text-[15px] font-bold leading-tight">
        ${data.precio?.toLocaleString("en-US", { maximumFractionDigits: data.precio > 1000 ? 0 : 2 })}
      </div>
      <div className="text-[9px] opacity-30 mt-0.5">
        H {data.maximo24h?.toLocaleString("en-US", { maximumFractionDigits: 0 })} ·
        L {data.minimo24h?.toLocaleString("en-US", { maximumFractionDigits: 0 })}
      </div>
    </div>
  );
}

function FearGreedGauge({ valor, clasificacion, ayer }) {
  const mathAngle = Math.PI * (1 - valor / 100);
  const nx = 50 + 30 * Math.cos(mathAngle);
  const ny = 50 - 30 * Math.sin(mathAngle);
  const filled = (valor / 100) * 125.66;
  const color =
    valor >= 75 ? "#10b981" :
    valor >= 55 ? "#22c55e" :
    valor >= 45 ? "#f59e0b" :
    valor >= 25 ? "#f97316" : "#ef4444";

  return (
    <div className="flex flex-col items-center">
      <div className="w-28 h-14">
        <svg viewBox="0 0 100 50" className="w-full h-full overflow-visible">
          <path
            d="M 10 50 A 40 40 0 0 1 90 50"
            fill="none"
            stroke="rgba(255,255,255,0.07)"
            strokeWidth="8"
            strokeLinecap="round"
          />
          <path
            d="M 10 50 A 40 40 0 0 1 90 50"
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${filled} 125.66`}
          />
          <line x1="50" y1="50" x2={nx} y2={ny} stroke="white" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="50" cy="50" r="4" fill="var(--tg-theme-secondary-bg-color, #1a1a24)" />
          <circle cx="50" cy="50" r="2.5" fill="white" />
        </svg>
      </div>
      <div className="text-xl font-bold -mt-1" style={{ color }}>{valor}</div>
      <div className="text-[11px] opacity-55">{clasificacion}</div>
      {ayer != null && (
        <div className="text-[9px] opacity-30 mt-0.5">ayer {ayer}</div>
      )}
    </div>
  );
}

// ── Pantalla principal ───────────────────────────────────────

export default function Dashboard() {
  const [prices, setPrices] = useState(null);
  const [market, setMarket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [p, m] = await Promise.all([getPrices(), getMarket()]);
      setPrices(p);
      setMarket(m);
      setLastUpdate(new Date());
    } catch (e) {
      console.error("Dashboard:", e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const p   = prices?.precios || {};
  const gl  = prices?.gainersLosers;
  const fg  = market?.fearGreed;
  const gm  = market?.globalMarket;
  const liq = market?.liquidaciones;

  const COINS = [
    { key: "BTC-USD", sym: "BTC", color: "#F7931A" },
    { key: "ETH-USD", sym: "ETH", color: "#627EEA" },
    { key: "SOL-USD", sym: "SOL", color: "#9945FF" },
  ];

  return (
    <div className="p-3 space-y-2.5">
      {/* Cabecera */}
      <div className="flex items-center justify-between py-1">
        <h1 className="text-[15px] font-bold">Mercado Ahora</h1>
        {lastUpdate && (
          <span className="text-[10px] opacity-30">
            ↻ {lastUpdate.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>

      {/* Precios BTC / ETH / SOL */}
      <div className="grid grid-cols-3 gap-2">
        {COINS.map(({ key, sym, color }) =>
          loading
            ? <Skeleton key={key} className="h-[76px]" />
            : <PriceCard key={key} symbol={sym} data={p[key]} accentColor={color} />
        )}
      </div>

      {/* Fear & Greed + Dominancia */}
      <div className="grid grid-cols-2 gap-2">
        {/* Fear & Greed */}
        <div
          className="rounded-xl p-3 flex flex-col items-center"
          style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
        >
          <div className="text-[10px] font-bold opacity-40 mb-2 self-start">Fear & Greed</div>
          {loading
            ? <Skeleton className="w-28 h-20" />
            : fg
              ? <FearGreedGauge valor={fg.valor} clasificacion={fg.clasificacion} ayer={fg.ayer} />
              : <p className="text-[11px] opacity-30 py-6">No disponible</p>
          }
        </div>

        {/* Dominancia BTC/ETH */}
        <div
          className="rounded-xl p-3"
          style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
        >
          <div className="text-[10px] font-bold opacity-40 mb-2">Dominancia</div>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-3" /><Skeleton className="h-3" /><Skeleton className="h-3" />
            </div>
          ) : gm ? (
            <>
              {[
                { label: "BTC", pct: gm.dominancia_btc, color: "#F7931A" },
                { label: "ETH", pct: gm.dominancia_eth, color: "#627EEA" },
              ].map(({ label, pct, color }) => (
                <div key={label} className="mb-2">
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="font-bold" style={{ color }}>{label}</span>
                    <span className="font-bold opacity-80">{pct}%</span>
                  </div>
                  <div className="w-full bg-white/5 rounded-full h-1">
                    <div className="h-1 rounded-full" style={{ width: `${pct}%`, background: color }} />
                  </div>
                </div>
              ))}
              <div className="text-[9px] opacity-30 mt-2 leading-tight">
                Cap global ${(gm.market_cap_total_usd / 1e12).toFixed(2)}T
                <span className={gm.cambio_market_cap_24h >= 0 ? " text-green-400" : " text-red-400"}>
                  {" "}{gm.cambio_market_cap_24h >= 0 ? "+" : ""}{gm.cambio_market_cap_24h}%
                </span>
              </div>
            </>
          ) : <p className="text-[11px] opacity-30">No disponible</p>}
        </div>
      </div>

      {/* Liquidaciones */}
      {(loading || liq?.total_usd > 0) && (
        <div
          className="rounded-xl p-3"
          style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
        >
          <div className="text-[10px] font-bold opacity-40 mb-2">Liquidaciones 24h</div>
          {loading ? <Skeleton className="h-8" /> : liq && (
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[17px] font-bold">${(liq.total_usd / 1e6).toFixed(1)}M</span>
                <span className="text-[9px] opacity-30 ml-1">liquidado</span>
              </div>
              <div className="text-right text-[11px]">
                <div className="text-red-400">Longs  ${(liq.longs_liq_usd / 1e6).toFixed(1)}M</div>
                <div className="text-green-400">Shorts ${(liq.shorts_liq_usd / 1e6).toFixed(1)}M</div>
              </div>
              <div
                className={`text-[10px] font-bold px-2 py-1 rounded-lg ${
                  liq.sesgo === "caza de longs"
                    ? "bg-red-400/10 text-red-400"
                    : liq.sesgo === "caza de shorts"
                      ? "bg-green-400/10 text-green-400"
                      : "bg-white/5 opacity-50"
                }`}
              >
                {liq.sesgo}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Top Movers */}
      {(loading || gl) && (
        <div
          className="rounded-xl p-3"
          style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
        >
          <div className="text-[10px] font-bold opacity-40 mb-2">Top Movers 24h</div>
          {loading ? <Skeleton className="h-12" /> : gl && (
            <div className="space-y-1.5">
              <div className="flex gap-1.5 flex-wrap">
                {gl.ganadores.map((g) => (
                  <span key={g.simbolo} className="text-[11px] px-2 py-0.5 rounded-full bg-green-400/10 text-green-400 font-bold">
                    ${g.simbolo} +{g.cambio}%
                  </span>
                ))}
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {gl.perdedores.map((p) => (
                  <span key={p.simbolo} className="text-[11px] px-2 py-0.5 rounded-full bg-red-400/10 text-red-400 font-bold">
                    ${p.simbolo} {p.cambio}%
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
