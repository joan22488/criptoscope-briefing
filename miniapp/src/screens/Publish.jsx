import React, { useState } from "react";

const ACCIONES = [
  {
    emoji: "⚡",
    titulo: "Flash urgente",
    desc: "Noticia importante al canal de inmediato",
    cmd: "flash",
    color: "#f59e0b",
  },
  {
    emoji: "📡",
    titulo: "¿Qué pasa?",
    desc: "Resumen del mercado en este momento",
    cmd: "quepasa",
    color: "#6366f1",
  },
  {
    emoji: "🧠",
    titulo: "Opinión / Análisis",
    desc: "Analiza una noticia o imagen con Claude",
    cmd: "opinion",
    color: "#8b5cf6",
  },
  {
    emoji: "☕",
    titulo: "Briefing matinal",
    desc: "Genera y publica el briefing completo",
    cmd: "briefing",
    color: "#f97316",
  },
  {
    emoji: "📅",
    titulo: "Resumen semanal",
    desc: "Resumen de toda la semana con gráfico",
    cmd: "semanal",
    color: "#10b981",
  },
];

export default function Publish() {
  const [pressed, setPressed] = useState(null);

  const handleAction = (cmd) => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
    setPressed(cmd);
    // Abre una conversación privada con el bot para ejecutar el comando
    const botUsername = import.meta.env.VITE_BOT_USERNAME;
    if (botUsername) {
      window.Telegram?.WebApp?.openTelegramLink(`https://t.me/${botUsername}`);
    }
    setTimeout(() => setPressed(null), 600);
  };

  return (
    <div className="p-3 space-y-2.5">
      <div className="py-1">
        <h1 className="text-[15px] font-bold">Publicar</h1>
        <p className="text-[11px] opacity-35 mt-0.5">Abre el bot para lanzar la acción.</p>
      </div>

      {ACCIONES.map((a) => (
        <button
          key={a.cmd}
          onClick={() => handleAction(a.cmd)}
          className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all active:scale-[0.98]"
          style={{
            backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)",
            opacity: pressed === a.cmd ? 0.7 : 1,
          }}
        >
          {/* Icono con fondo de color */}
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-xl"
            style={{ backgroundColor: `${a.color}18` }}
          >
            {a.emoji}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold">{a.titulo}</div>
            <div className="text-[10px] opacity-45 mt-0.5">{a.desc}</div>
          </div>
          <span className="opacity-20 text-lg">›</span>
        </button>
      ))}

      {/* Nota informativa */}
      <div
        className="rounded-xl p-3 mt-1"
        style={{ backgroundColor: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.15)" }}
      >
        <p className="text-[10px] opacity-60 leading-relaxed">
          En la próxima versión podrás redactar y previsualizar el contenido directamente
          aquí antes de publicarlo.
        </p>
      </div>
    </div>
  );
}
