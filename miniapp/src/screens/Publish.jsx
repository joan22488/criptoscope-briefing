import React, { useState } from "react";
import { Zap, Radio, BrainCircuit, Coffee, CalendarDays, ChevronRight } from "lucide-react";

const ACCIONES = [
  {
    Icon: Zap,
    titulo: "Flash urgente",
    desc: "Noticia importante al canal de inmediato",
    cmd: "flash",
    color: "#f59e0b",
  },
  {
    Icon: Radio,
    titulo: "¿Qué pasa?",
    desc: "Resumen del mercado en este momento",
    cmd: "quepasa",
    color: "#6366f1",
  },
  {
    Icon: BrainCircuit,
    titulo: "Opinión / Análisis",
    desc: "Analiza una noticia o imagen con Claude",
    cmd: "opinion",
    color: "#8b5cf6",
  },
  {
    Icon: Coffee,
    titulo: "Briefing matinal",
    desc: "Genera y publica el briefing completo",
    cmd: "briefing",
    color: "#f97316",
  },
  {
    Icon: CalendarDays,
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

      {ACCIONES.map(({ Icon, titulo, desc, cmd, color }) => (
        <button
          key={cmd}
          onClick={() => handleAction(cmd)}
          className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all active:scale-[0.98]"
          style={{
            backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)",
            opacity: pressed === cmd ? 0.7 : 1,
          }}
        >
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: `${color}18` }}
          >
            <Icon size={18} color={color} strokeWidth={2} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold">{titulo}</div>
            <div className="text-[10px] opacity-45 mt-0.5">{desc}</div>
          </div>
          <ChevronRight size={16} className="opacity-20 flex-shrink-0" />
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
