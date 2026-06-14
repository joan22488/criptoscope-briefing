// ============================================================
// run-once.js - Ejecuta el briefing UNA vez, ahora mismo.
// Úsalo para probar: npm run once
// ============================================================

import "dotenv/config";
import { ejecutarBriefing } from "./pipeline.js";

ejecutarBriefing()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌ Error:", e.message);
    process.exit(1);
  });
