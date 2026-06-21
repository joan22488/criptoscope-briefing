// Cliente API — llama a los endpoints del servidor Railway
const BASE = import.meta.env.VITE_API_URL || "";

function getInitData() {
  return window.Telegram?.WebApp?.initData || "";
}

async function call(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${getInitData()}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const getPrices  = ()    => call("/api/prices");
export const getMarket  = ()    => call("/api/market");
export const getSignals = ()    => call("/api/signals");
export const getStatus  = ()    => call("/api/status");
export const getMacro   = ()    => call("/api/macro");

export const pauseBot       = (pausado) => call("/api/pause",             { method: "POST", body: JSON.stringify({ pausado }) });
export const aprobarSenal   = (pid)     => call("/api/signals/aprobar",   { method: "POST", body: JSON.stringify({ pid }) });
export const descartarSenal = (pid)     => call("/api/signals/descartar", { method: "POST", body: JSON.stringify({ pid }) });
