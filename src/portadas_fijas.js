// Portadas fijas: file_id de Telegram guardados en disco.
// Los file_id de Telegram no caducan (están en sus servidores).
// Para persistencia entre redeploys en Railway: copia el file_id a la variable de entorno
// BRIEFING_PORTADA_FILE_ID o SEMANAL_PORTADA_FILE_ID en el dashboard de Railway.

import { readFileSync, writeFileSync, mkdirSync } from "fs";

const PATH = "./data/portadas_fijas.json";
let cache = null;

function cargar() {
  if (cache) return cache;
  // Prioritize env vars (survive redeploys) over local file
  const desde_env = {
    briefing: process.env.BRIEFING_PORTADA_FILE_ID || null,
    semanal:  process.env.SEMANAL_PORTADA_FILE_ID  || null,
  };
  try {
    const disco = JSON.parse(readFileSync(PATH, "utf8"));
    cache = { ...desde_env, ...disco }; // disco sobreescribe env (más reciente)
  } catch {
    cache = desde_env;
  }
  return cache;
}

export function getPortadaFija(tipo) {
  return cargar()[tipo] || null;
}

export function setPortadaFija(tipo, fileId) {
  const data = { ...cargar(), [tipo]: fileId };
  cache = data;
  mkdirSync("./data", { recursive: true });
  writeFileSync(PATH, JSON.stringify(data, null, 2), "utf8");
}

export function clearPortadaFija(tipo) {
  const data = { ...cargar() };
  delete data[tipo];
  cache = data;
  mkdirSync("./data", { recursive: true });
  writeFileSync(PATH, JSON.stringify(data, null, 2), "utf8");
}
