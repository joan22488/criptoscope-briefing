// Portadas fijas: file_id de Telegram guardados en disco.
// Los file_id de Telegram no caducan (están en sus servidores).
// Para persistencia entre redeploys en Railway: usa un Volume con DATA_DIR,
// o copia el file_id a la variable de entorno BRIEFING_PORTADA_FILE_ID
// o SEMANAL_PORTADA_FILE_ID en el dashboard de Railway.

import { loadJSON, saveJSON } from "./storage.js";

let cache = null;

function cargar() {
  if (cache) return cache;
  // Prioritize env vars (survive redeploys) over local file
  const desde_env = {
    briefing: process.env.BRIEFING_PORTADA_FILE_ID || null,
    semanal:  process.env.SEMANAL_PORTADA_FILE_ID  || null,
  };
  const disco = loadJSON("portadas_fijas.json", {});
  cache = { ...desde_env, ...disco }; // disco sobreescribe env (más reciente)
  return cache;
}

export function getPortadaFija(tipo) {
  return cargar()[tipo] || null;
}

export function setPortadaFija(tipo, fileId) {
  const data = { ...cargar(), [tipo]: fileId };
  cache = data;
  saveJSON("portadas_fijas.json", data);
}

export function clearPortadaFija(tipo) {
  const data = { ...cargar() };
  delete data[tipo];
  cache = data;
  saveJSON("portadas_fijas.json", data);
}
