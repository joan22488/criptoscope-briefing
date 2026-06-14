// ============================================================
// output.js - Guarda el contenido del día en /output/AAAA-MM-DD/
// Así tienes el guion y el thread listos para grabar/publicar.
// ============================================================

import { mkdir, writeFile } from "fs/promises";
import path from "path";

export async function guardarPaquete(paquete) {
  const hoy = new Date().toLocaleDateString("sv-SE", {
    timeZone: process.env.TIMEZONE || "Europe/Madrid",
  }); // sv-SE da formato AAAA-MM-DD

  const dir = path.join(process.cwd(), "output", hoy);
  await mkdir(dir, { recursive: true });

  // 1. Briefing completo
  await writeFile(
    path.join(dir, "briefing.md"),
    `# ${paquete.titular}\n\n**Narrativa caliente:** ${paquete.narrativa_caliente}\n\n${paquete.briefing.replace(/<\/?b>/g, "**")}`,
    "utf8"
  );

  // 2. Guion de vídeo listo para grabar
  await writeFile(
    path.join(dir, "guion-video.md"),
    `# Guion vídeo - ${hoy}\n\n${paquete.guion_video}`,
    "utf8"
  );

  // 3. Thread para X / Binance Square
  const thread = (paquete.thread || [])
    .map((t, i) => `--- Tweet ${i + 1} ---\n${t}`)
    .join("\n\n");
  await writeFile(path.join(dir, "thread.md"), `# Thread - ${hoy}\n\n${thread}`, "utf8");

  // 4. Pregunta para la comunidad
  await writeFile(
    path.join(dir, "pregunta-comunidad.txt"),
    paquete.pregunta_comunidad || "",
    "utf8"
  );

  console.log(`📁 Contenido guardado en output/${hoy}/`);
  return dir;
}
