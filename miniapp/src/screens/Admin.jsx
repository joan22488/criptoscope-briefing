import React, { useState, useEffect } from "react";
import { Activity, Image, LayoutList, ChevronRight, Play, Pause } from "lucide-react";
import { getStatus, pauseBot } from "../api.js";

function Skeleton({ className }) {
  return <div className={`rounded-xl bg-white/5 animate-pulse ${className}`} />;
}

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function nextRunLabel(cronExpr, timezone) {
  if (!cronExpr) return "—";
  // Parseamos "0 7 * * *" → extrae la hora
  const parts = cronExpr.split(" ");
  const min = parseInt(parts[0]);
  const hr  = parseInt(parts[1]);
  if (isNaN(hr)) return cronExpr;
  const now  = new Date();
  const next = new Date();
  next.setHours(hr, min, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toLocaleTimeString("es-ES", {
    weekday: "short", hour: "2-digit", minute: "2-digit",
    timeZone: timezone || "Europe/Madrid",
  });
}

export default function Admin() {
  const [status, setStatus]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  const load = async () => {
    try {
      setStatus(await getStatus());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const togglePause = async () => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
    setToggling(true);
    try {
      const res = await pauseBot(!status.pausado);
      setStatus((s) => ({ ...s, pausado: res.pausado }));
    } catch (e) {
      window.Telegram?.WebApp?.showAlert?.("Error: " + e.message);
    } finally {
      setToggling(false);
    }
  };

  const macroEventos = [
    ...(status?.macro?.hoy    || []).map((e) => ({ ...e, cuando: "HOY" })),
    ...(status?.macro?.manana || []).map((e) => ({ ...e, cuando: "MAÑANA" })),
  ];

  return (
    <div className="p-3 space-y-3">
      <h1 className="text-[15px] font-bold py-1">Panel Admin</h1>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-28" />
          <Skeleton className="h-20" />
        </div>
      ) : status ? (
        <>
          {/* Estado del bot */}
          <div
            className="rounded-xl p-4"
            style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-[13px] font-bold">Estado del bot</div>
                <div
                  className={`text-[11px] font-bold mt-0.5 ${
                    status.pausado ? "text-amber-400" : "text-green-400"
                  }`}
                >
                  {status.pausado ? "⏸ Pausado" : "🟢 Activo"}
                </div>
              </div>
              <button
                onClick={togglePause}
                disabled={toggling}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-[12px] font-bold transition-all active:scale-95 disabled:opacity-40 ${
                  status.pausado
                    ? "bg-green-400/15 text-green-400"
                    : "bg-amber-400/15 text-amber-400"
                }`}
              >
                {toggling ? (
                  "..."
                ) : status.pausado ? (
                  <><Play size={13} strokeWidth={2.5} /> Reactivar</>
                ) : (
                  <><Pause size={13} strokeWidth={2.5} /> Pausar</>
                )}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-y-2 text-[11px]">
              <div>
                <span className="opacity-35">Uptime</span>
                <span className="ml-1.5 font-semibold">{formatUptime(status.uptimeSegundos)}</span>
              </div>
              <div>
                <span className="opacity-35">Zona</span>
                <span className="ml-1.5 font-semibold">{status.timezone}</span>
              </div>
              <div>
                <span className="opacity-35">Briefing</span>
                <span className="ml-1.5 font-semibold">{nextRunLabel(status.cronBriefing, status.timezone)}</span>
              </div>
              <div>
                <span className="opacity-35">Portadas</span>
                <span className="ml-1.5 font-semibold">
                  {status.portadas?.briefing ? "✅" : "—"} B ·{" "}
                  {status.portadas?.semanal  ? "✅" : "—"} S
                </span>
              </div>
            </div>
          </div>

          {/* Eventos macro */}
          {macroEventos.length > 0 && (
            <div
              className="rounded-xl p-3"
              style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
            >
              <div className="text-[10px] font-bold opacity-40 mb-2">⚠️ Macro a vigilar</div>
              {macroEventos.map((e, i) => (
                <div
                  key={i}
                  className="py-2 border-b last:border-0"
                  style={{ borderColor: "rgba(255,255,255,0.05)" }}
                >
                  <div className="text-[12px] font-bold">{e.titulo}</div>
                  <div className="text-[10px] opacity-35 mt-0.5">
                    {e.cuando} · {e.hora} ET
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Accesos rápidos */}
          <div
            className="rounded-xl p-3"
            style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
          >
            <div className="text-[10px] font-bold opacity-40 mb-2">Accesos rápidos</div>
            {[
              { label: "Portada del briefing",  Icon: Image,      cmd: "/setportada briefing" },
              { label: "Portada del semanal",   Icon: Image,      cmd: "/setportada semanal"  },
              { label: "Ver estado del bot",    Icon: Activity,   cmd: "/estado"              },
              { label: "Historial de señales",  Icon: LayoutList, cmd: "/historial"           },
            ].map(({ label, Icon, cmd }) => (
              <button
                key={cmd}
                onClick={() => {
                  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
                  const botUsername = import.meta.env.VITE_BOT_USERNAME;
                  if (botUsername) window.Telegram?.WebApp?.openTelegramLink(`https://t.me/${botUsername}`);
                }}
                className="w-full text-left py-2.5 border-b last:border-0 flex items-center gap-2.5 active:opacity-60"
                style={{ borderColor: "rgba(255,255,255,0.05)" }}
              >
                <Icon size={14} className="opacity-40 flex-shrink-0" />
                <span className="text-[12px] flex-1">{label}</span>
                <ChevronRight size={14} className="opacity-20 flex-shrink-0" />
              </button>
            ))}
          </div>
        </>
      ) : (
        <div
          className="rounded-xl p-4 text-center"
          style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
        >
          <p className="text-[13px] opacity-40">Error al cargar estado del bot</p>
          <button
            onClick={load}
            className="mt-3 text-[11px] opacity-60 underline"
          >
            Reintentar
          </button>
        </div>
      )}
    </div>
  );
}
