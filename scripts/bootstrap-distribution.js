#!/usr/bin/env node
/**
 * CLI runner for the distribution bootstrap.
 *
 *   node scripts/bootstrap-distribution.js <planning.xlsx> [services.xlsx] [por-cumprir.xlsx]
 *
 *   --balances-only <por-cumprir.xlsx>    importa só o saldo (re-baseline)
 *
 * Idempotente — pode correr-se de novo. Todas as operações são UPSERT.
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { init } = require("../db/mysql");
const { importPlanning, importServices, importBalances, cleanAll } = require("../lib/distribution-bootstrap");

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const cleanFlag = args.includes("--clean");
  const balancesOnlyIdx = args.indexOf("--balances-only");
  const positional = args.filter((a, i) => !a.startsWith("--") && (i !== balancesOnlyIdx + 1 || balancesOnlyIdx < 0));

  console.log(`[bootstrap] Mode: ${dryRun ? "DRY-RUN" : "LIVE"}${cleanFlag ? " (CLEAN)" : ""}`);
  console.log("[bootstrap] Connecting to MySQL...");
  await init();

  if (cleanFlag && !dryRun) {
    console.log("[bootstrap] Limpando todas as tabelas distribution…");
    const r = await cleanAll();
    console.log("  ", r);
  }

  // Modo --balances-only: só re-importa o saldo (não toca em planning/services)
  if (balancesOnlyIdx >= 0) {
    const file = path.resolve(args[balancesOnlyIdx + 1]);
    if (!fs.existsSync(file)) { console.error("[ERR] file not found:", file); process.exit(2); }
    console.log(`[bootstrap] === IMPORTING BALANCES (por cumprir) ===\n  File: ${file}`);
    const t = Date.now();
    const r = await importBalances(file, { dryRun });
    console.log(JSON.stringify(r, null, 2));
    console.log(`Took ${((Date.now() - t) / 1000).toFixed(1)}s`);
    process.exit(0);
  }

  let planningPath, servicesPath, balancesPath;
  if (positional.length >= 1) planningPath = path.resolve(positional[0]);
  if (positional.length >= 2) servicesPath = path.resolve(positional[1]);
  if (positional.length >= 3) balancesPath = path.resolve(positional[2]);
  if (!planningPath) {
    planningPath = path.join(__dirname, "..", "data", "Planeamento_Actualizado.xlsx");
    const homeDownloads = path.join(process.env.USERPROFILE || process.env.HOME || "", "Downloads");
    servicesPath = servicesPath || path.join(homeDownloads, "servicos (53).xlsx");
  }

  if (!fs.existsSync(planningPath)) {
    console.error(`[ERR] Planning file not found: ${planningPath}`);
    process.exit(2);
  }

  console.log(`[bootstrap] Planning: ${planningPath}`);
  if (servicesPath) console.log(`[bootstrap] Services: ${servicesPath}`);
  if (balancesPath) console.log(`[bootstrap] Balances:  ${balancesPath}`);

  console.log("\n[bootstrap] === IMPORTING PLANNING (metadata) ===");
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
  }

  if (balancesPath && fs.existsSync(balancesPath)) {
    console.log("\n[bootstrap] === IMPORTING BALANCES (por cumprir, fonte de verdade) ===");
    const t2 = Date.now();
    const r3 = await importBalances(balancesPath, { dryRun });
    console.log(JSON.stringify(r3, null, 2));
    console.log(`Took ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  }

  console.log("\n[bootstrap] Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error("[bootstrap] FAILED:", e.message);
  console.error(e.stack);
  process.exit(1);
});
