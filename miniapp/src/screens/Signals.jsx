import React, { useState, useEffect } from "react";
import { getSignals, aprobarSenal, descartarSenal } from "../api.js";

function Skeleton({ className }) {
  return <div className={`rounded-xl bg-white/5 animate-pulse ${className}`} />;
}

function StatPill({ label, value, color = "text-white" }) {
  return (
    <div className="text-center">
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-[9px] opacity-35 mt-0.5">{label}</div>
    </div>
  );
}

function SignalCard({ s }) {
  const fecha = new Date(s.fecha).toLocaleDateString("es-ES", {
    day: "numeric", month: "short",
    timeZone: "Europe/Madrid",
  });
  const res =
    s.resultado === "PENDIENTE" ? "⏳" :
    s.resultado === "EXPIRADO"  ? "⌛" :
    s.resultado?.includes("TP2") ? "✅✅" :
    s.resultado?.includes("TP1") ? "✅" :
    s.resultado?.includes("SL")  ? "❌" : "❓";

  return (
    <div
      className="rounded-xl p-3"
      style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm">{s.symbol}</span>
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
              s.op === "LONG"
                ? "bg-green-400/10 text-green-400"
                : "bg-red-400/10 text-red-400"
            }`}
          >
            {s.op}
          </span>
        </div>
        <span className="text-xs">
          {res} <span className="opacity-30 text-[10px]">{fecha}</span>
        </span>
      </div>
      {s.entrada && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] opacity-55">
          <span>Entrada <b className="opacity-100">{s.entrada}</b></span>
          {s.tp1 && <span>TP1 <b className="opacity-100">{s.tp1}</b></span>}
          {s.tp2 && <span>TP2 <b className="opacity-100">{s.tp2}</b></span>}
          {s.sl  && <span>SL <b className="opacity-100">{s.sl}</b></span>}
          {s.rr  && <span>R:R <b className="opacity-100">{s.rr}</b></span>}
        </div>
      )}
    </div>
  );
}

export default function Signals() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("activas");
  const [actionPid, setActionPid] = useState(null); // pid con acción en curso

  const load = async () => {
    try {
      setData(await getSignals());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAprobar = async (pid) => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("medium");
    setActionPid(pid);
    try {
      await aprobarSenal(pid);
      await load();
    } catch (e) {
      alert("Error al publicar: " + e.message);
    } finally {
      setActionPid(null);
    }
  };

  const handleDescartar = async (pid) => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
    setActionPid(pid);
    try {
      await descartarSenal(pid);
      await load();
    } catch (e) {
      setActionPid(null);
    }
  };

  const stats       = data?.stats;
  const todas       = data?.senales || [];
  const pendientes  = data?.pendientesReview || [];
  const activas     = todas.filter((s) => s.resultado === "PENDIENTE");
  const lista       = activeTab === "activas" ? activas : todas;

  return (
    <div className="p-3 space-y-3">
      <h1 className="text-[15px] font-bold py-1">Señales</h1>

      {/* Stats semana */}
      {!loading && stats && (
        <div
          className="rounded-xl p-3"
          style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
        >
          <div className="text-[10px] font-bold opacity-40 mb-3">Esta semana</div>
          <div className="flex justify-around">
            <StatPill label="Total"    value={stats.total}           color="text-white" />
            <StatPill label="TP1"      value={stats.tp1}             color="text-green-400" />
            <StatPill label="TP2"      value={stats.tp2}             color="text-green-300" />
            <StatPill label="SL"       value={stats.sl}              color="text-red-400" />
            <StatPill label="Win rate" value={`${stats.winrate}%`}   color="text-purple-400" />
          </div>
        </div>
      )}

      {/* Pendientes de revisión del owner */}
      {pendientes.length > 0 && (
        <div>
          <div className="text-[10px] font-bold opacity-55 mb-2 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block animate-pulse" />
            Pendientes de revisión ({pendientes.length})
          </div>
          {pendientes.map(({ pid, mensaje }) => (
            <div
              key={pid}
              className="rounded-xl p-3 mb-2 border border-amber-400/20"
              style={{ backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)" }}
            >
              <p className="text-[11px] opacity-60 mb-3 leading-relaxed line-clamp-4">
                {mensaje.replace(/<[^>]+>/g, "")}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleAprobar(pid)}
                  disabled={actionPid === pid}
                  className="flex-1 py-2 rounded-lg text-[12px] font-bold bg-green-400/10 text-green-400 active:bg-green-400/20 disabled:opacity-40"
                >
                  {actionPid === pid ? "..." : "📢 Publicar"}
                </button>
                <button
                  onClick={() => handleDescartar(pid)}
                  disabled={actionPid === pid}
                  className="flex-1 py-2 rounded-lg text-[12px] font-bold bg-red-400/10 text-red-400 active:bg-red-400/20 disabled:opacity-40"
                >
                  🗑 Descartar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs activas / historial */}
      <div className="flex gap-1 p-0.5 rounded-xl" style={{ backgroundColor: "rgba(255,255,255,0.04)" }}>
        {["activas", "historial"].map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold capitalize transition-all ${
              activeTab === t ? "text-white shadow" : "opacity-35"
            }`}
            style={activeTab === t ? { backgroundColor: "var(--tg-theme-button-color, #6366f1)" } : {}}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Lista de señales */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}
        </div>
      ) : lista.length > 0 ? (
        <div className="space-y-2">
          {lista.map((s) => <SignalCard key={s.id} s={s} />)}
        </div>
      ) : (
        <p className="text-center text-[13px] opacity-30 py-10">
          Sin señales {activeTab === "activas" ? "activas ahora" : "registradas"}
        </p>
      )}
    </div>
  );
}
