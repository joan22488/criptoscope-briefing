import React, { useState } from "react";
import { TrendingUp, Crosshair, Megaphone, Settings2 } from "lucide-react";
import Dashboard from "./screens/Dashboard.jsx";
import Signals from "./screens/Signals.jsx";
import Publish from "./screens/Publish.jsx";
import Admin from "./screens/Admin.jsx";

const TABS = [
  { id: "dashboard", label: "Mercado",  Icon: TrendingUp  },
  { id: "signals",   label: "Señales",  Icon: Crosshair   },
  { id: "publish",   label: "Publicar", Icon: Megaphone   },
  { id: "admin",     label: "Admin",    Icon: Settings2   },
];

const SCREENS = { dashboard: Dashboard, signals: Signals, publish: Publish, admin: Admin };

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const Screen = SCREENS[tab];

  const handleTab = (id) => {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred("light");
    setTab(id);
  };

  return (
    <div className="flex flex-col" style={{ height: "100dvh" }}>
      {/* Contenido scrollable */}
      <div className="flex-1 overflow-y-auto pb-16 min-h-0">
        <Screen />
      </div>

      {/* Barra de navegación inferior */}
      <nav
        className="fixed bottom-0 left-0 right-0 flex border-t"
        style={{
          backgroundColor: "var(--tg-theme-secondary-bg-color, #1a1a24)",
          borderColor: "rgba(255,255,255,0.07)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {TABS.map(({ id, label, Icon }) => {
          const active = tab === id;
          const color = active
            ? "var(--tg-theme-button-color, #6366f1)"
            : "var(--tg-theme-hint-color, #64748b)";
          return (
            <button
              key={id}
              onClick={() => handleTab(id)}
              className="flex-1 flex flex-col items-center py-2 gap-1 transition-all duration-150"
              style={{ opacity: active ? 1 : 0.45 }}
            >
              <Icon size={20} color={color} strokeWidth={active ? 2.2 : 1.8} />
              <span
                className="text-[10px] font-semibold"
                style={{ color }}
              >
                {label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
