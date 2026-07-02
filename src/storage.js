// ============================================================
// storage.js - Persistencia JSON centralizada
//
// DATA_DIR configurable por env. En Railway, monta un Volume
// en /data y define DATA_DIR=/data para que el estado
// sobreviva a los deploys (el filesystem normal es efímero).
// ============================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export const DATA_DIR = process.env.DATA_DIR || "./data";

export function loadJSON(nombre, fallback = null) {
  try {
    const ruta = join(DATA_DIR, nombre);
    if (!existsSync(ruta)) return fallback;
    return JSON.parse(readFileSync(ruta, "utf8"));
  } catch {
    return fallback;
  }
}

export function saveJSON(nombre, data) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, nombre), JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn(`⚠️ storage: no se pudo guardar ${nombre}:`, e.message);
  }
}
