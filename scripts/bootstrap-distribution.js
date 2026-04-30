#!/usr/bin/env node
/**
 * CLI runner for the distribution bootstrap.
 *
 *   node scripts/bootstrap-distribution.js <planning.xlsx> [services.xlsx]
 *
 * Idempotente — pode correr-se de novo. O planeamento UPSERTs;
 * o histórico de serviços salta os ADSNs já importados.
 *
 * Sem argumentos faz dry-run com os ficheiros default em data/ e Downloads/.
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { init } = require("../db/mysql");
const { importPlanning, importServices } = require("../lib/distribution-bootstrap");

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((a) => !a.startsWith("--"));

  let planningPath, servicesPath;
  if (positional.length >= 1) {
    planningPath = path.resolve(positional[0]);
    if (positional.length >= 2) servicesPath = path.resolve(positional[1]);
  } else {
    // Defaults
    planningPath = path.join(__dirname, "..", "data", "Planeamento_Actualizado.xlsx");
    const homeDownloads = path.join(process.env.USERPROFILE || process.env.HOME || "", "Downloads");
    servicesPath = path.join(homeDownloads, "servicos (53).xlsx");
  }

  if (!fs.existsSync(planningPath)) {
    console.error(`[ERR] Planning file not found: ${planningPath}`);
    process.exit(2);
  }

  console.log(`[bootstrap] Mode: ${dryRun ? "DRY-RUN" : "LIVE"}`);
  console.log(`[bootstrap] Planning: ${planningPath}`);
  if (servicesPath) console.log(`[bootstrap] Services: ${servicesPath}`);

  // DB needed even for dry-run (NUIT→extensionist_id lookup happens in importServices).
  console.log("[bootstrap] Connecting to MySQL...");
  await init();

  console.log("\n[bootstrap] === IMPORTING PLANNING ===");
  const t0 = Date.now();
  const r1 = await importPlanning(planningPath, { dryRun });
  console.log(JSON.stringify(r1, null, 2));
  console.log(`Took ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (servicesPath && fs.existsSync(servicesPath)) {
    console.log("\n[bootstrap] === IMPORTING SERVICES (HISTORIC) ===");
    const t1 = Date.now();
    const r2 = await importServices(servicesPath, { dryRun });
    console.log(JSON.stringify(r2, null, 2));
    console.log(`Took ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  } else if (servicesPath) {
    console.warn(`[bootstrap] Services file missing: ${servicesPath} — skipping`);
  }

  console.log("\n[bootstrap] Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error("[bootstrap] FAILED:", e.message);
  console.error(e.stack);
  process.exit(1);
});
