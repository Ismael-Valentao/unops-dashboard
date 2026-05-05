#!/usr/bin/env node
/**
 * MAAP-Sync Admin — sincroniza delivery_balances no MySQL com MAAP.
 *
 * Uso:
 *   node scripts/maap-sync-admin.js              # dry-run (default — não escreve)
 *   node scripts/maap-sync-admin.js --dry-run    # idem
 *   node scripts/maap-sync-admin.js --apply      # aplica (NÃO IMPLEMENTADO ATÉ APROVAÇÃO)
 *   node scripts/maap-sync-admin.js --csv out.csv # exporta detalhe em CSV
 *
 * Dry-run NUNCA escreve no DB. Apenas lê e devolve relatório.
 */

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const { init } = require("../db/mysql");
const { diagnose, apply, rollbackToBackup, KNOWN_ALIASES, SKU_TO_RECIPE } = require("../lib/maap-sync");

const args = process.argv.slice(2);
const isApply = args.includes("--apply");
const isYes = args.includes("--yes") || args.includes("-y");
const rollbackIdx = args.indexOf("--rollback");
const rollbackTs = rollbackIdx >= 0 ? args[rollbackIdx + 1] : null;
const csvIdx = args.indexOf("--csv");
const csvPath = csvIdx >= 0 ? args[csvIdx + 1] : null;

function fmt(n) { return Number(n).toLocaleString("pt-PT"); }
function pad(s, n) { return String(s).padEnd(n).slice(0, n); }
function padR(s, n) { return String(s).padStart(n); }

async function promptYesNo(question) {
  if (isYes) return true;
  return new Promise((resolve) => {
    process.stdout.write(question + " [y/N]: ");
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      const answer = data.toString().trim().toLowerCase();
      process.stdin.pause();
      resolve(answer === "y" || answer === "yes" || answer === "s" || answer === "sim");
    });
  });
}

async function main() {
  console.log("\n=========================================================");
  console.log("  MAAP-SYNC ADMIN  ·  " + (rollbackTs ? "ROLLBACK" : isApply ? "MODO APPLY (FAZ ESCRITAS)" : "DRY-RUN (não escreve nada)"));
  console.log("=========================================================\n");

  await init();

  // ─── ROLLBACK MODE ────────────────────────────────────────────
  if (rollbackTs) {
    console.log(`Vai restaurar backup_*_${rollbackTs}`);
    console.log(`⚠️  Isto vai SOBRESCREVER beneficiaries e delivery_balances actuais!`);
    const ok = await promptYesNo("Continuar?");
    if (!ok) { console.log("Cancelado."); process.exit(0); }
    const r = await rollbackToBackup(rollbackTs);
    console.log(`✓ Restaurado: ${r.restored.beneBackup}, ${r.restored.balBackup}`);
    process.exit(0);
  }

  const r = await diagnose();

  console.log("📊 Sumário\n──────────");
  console.log(`MAAP carregado:               ${fmt(r.maap_loaded)} extensionistas`);
  console.log(`Beneficiários no DB (não-EXT):${fmt(r.db_benefs)}`);
  console.log(`Saldos no DB:                  ${fmt(r.db_balances)}`);
  console.log(`Saldos-alvo (MAAP × recipe):   ${fmt(r.target_balances)}`);
  console.log("");

  console.log("👥 BENEFICIÁRIOS\n────────────────");
  console.log(`A ADICIONAR (no MAAP, não no DB):  ${fmt(r.benefs_to_add.length)}`);
  console.log(`  → com kits > 0:                  ${fmt(r.benefs_to_add.filter((b) => b.kit1 + b.kit2 > 0).length)}`);
  console.log(`  → MAAP-PEND-* (sem ID oficial):  ${fmt(r.benefs_to_add.filter((b) => b.is_pending_id).length)}`);
  console.log(`A MARCAR ALIAS (duplicados):       ${fmt(r.benefs_to_alias.length)}`);
  console.log(`  → já marcados antes:             ${fmt(r.benefs_to_alias.filter((b) => b.already_aliased).length)}`);
  console.log(`A ZERAR (no DB, não no MAAP):      ${fmt(r.benefs_to_zero.length)}`);
  console.log("");

  console.log("💰 SALDOS (delivery_balances)\n──────────────────────────────");
  console.log(`A CRIAR (novas (ext_id, sku)):     ${fmt(r.balances_to_create.length)}`);
  console.log(`A ACTUALIZAR (qty diferente):      ${fmt(r.balances_to_update.length)}`);
  console.log(`A ZERAR (no DB, não no MAAP):      ${fmt(r.balances_to_zero.length)}`);
  console.log(`Inalterados:                       ${fmt(r.balances_unchanged)}`);
  console.log("");

  if (r.negative_virtual.length > 0) {
    console.log("⚠️  ATENÇÃO: Saldos 'negativos virtuais' (já entregue MAIS que o novo plano)");
    console.log("─────────────────────────────────────────────────────────────");
    console.log("Estes benefs já receberam mais kg do que o plano oficial actualizado");
    console.log("indica que devem receber. O committed_qty mantém-se, planned passa a 0.");
    console.log("");
    console.log(pad("ext_id", 12) + " " + pad("nome", 35) + " " + pad("sku", 18) + padR("plan novo", 12) + padR("committed", 12) + padR("excesso", 10));
    for (const v of r.negative_virtual.slice(0, 30)) {
      console.log(
        pad(v.ext_id, 12) + " " +
        pad(v.name || "?", 35) + " " +
        pad(v.sku, 18) +
        padR(fmt(v.new_planned), 12) +
        padR(fmt(v.committed), 12) +
        padR("+" + fmt(v.excess.toFixed(0)), 10)
      );
    }
    if (r.negative_virtual.length > 30) console.log(`  ... e mais ${r.negative_virtual.length - 30}`);
    console.log("");
  }

  console.log("📦 TOTAIS POR PRODUTO");
  console.log("──────────────────────");
  console.log("(planned_original = NQAE; realocado mantém-se; planned_qty = original − realocado)");
  console.log("");
  console.log(pad("Produto", 22) + " " + padR("Original atual", 16) + padR("Original novo", 16) + padR("Δ orig", 13) + padR("Realocado", 13) + padR("Qty atual", 13) + padR("Qty novo", 13) + padR("Δ qty", 12));
  for (const [sku, t] of Object.entries(r.totals_per_sku)) {
    const arrowOrig = t.diff_original > 0.5 ? "↑" : t.diff_original < -0.5 ? "↓" : "=";
    const arrowQty = t.diff_qty > 0.5 ? "↑" : t.diff_qty < -0.5 ? "↓" : "=";
    console.log(
      pad(t.label, 22) + " " +
      padR(fmt(t.current_original), 16) +
      padR(fmt(t.new_original), 16) +
      padR(arrowOrig + fmt(Math.abs(t.diff_original).toFixed(0)), 13) +
      padR(fmt(t.realocado_total), 13) +
      padR(fmt(t.current_qty), 13) +
      padR(fmt(t.new_qty), 13) +
      padR(arrowQty + fmt(Math.abs(t.diff_qty).toFixed(0)), 12)
    );
  }
  console.log("");
  console.log("📌 Δ qty = MUDANÇA REAL no plano operacional");
  console.log("  Δ orig = mudança no plano oficial NQAE (inclui realocações já aplicadas)");
  console.log("  Realocado = kg JÁ entregues a outros benefs via realocação (mantém-se)");
  console.log("");

  // Listar primeiros aliases
  if (r.benefs_to_alias.length > 0) {
    console.log("🔗 ALIASES A MARCAR (duplicados conhecidos)");
    console.log("───────────────────────────────────────────");
    console.log(pad("ID antigo", 12) + " → " + pad("ID novo", 12) + " " + pad("Nome (antigo)", 30) + " " + pad("Nome (novo)", 30) + " já?");
    for (const a of r.benefs_to_alias) {
      console.log(
        pad(a.old_id, 12) + " → " + pad(a.new_id, 12) + " " +
        pad(a.old_name || "?", 30) + " " +
        pad(a.new_name || "?", 30) + " " +
        (a.already_aliased ? "SIM" : "não")
      );
    }
    console.log("");
  }

  // Top adicionar com kits > 0
  const addsWithKits = r.benefs_to_add.filter((b) => b.kit1 + b.kit2 > 0);
  if (addsWithKits.length > 0) {
    console.log(`➕ EXTENSIONISTAS A ADICIONAR (com kits > 0): ${addsWithKits.length}`);
    console.log("──────────────────────────────────────────────");
    console.log(pad("ext_id", 22) + " " + pad("Província", 12) + " " + pad("Distrito", 18) + " " + pad("Nome", 32) + padR("kit1", 6) + padR("kit2", 6));
    for (const b of addsWithKits.slice(0, 20)) {
      console.log(
        pad(b.id, 22) + " " +
        pad(b.prov, 12) + " " +
        pad(b.district || "—", 18) + " " +
        pad(b.name || "—", 32) +
        padR(b.kit1, 6) +
        padR(b.kit2, 6)
      );
    }
    if (addsWithKits.length > 20) console.log(`  ... e mais ${addsWithKits.length - 20}`);
    console.log("");
  }

  // Top zerar com committed > 0
  const zerosWithComm = r.benefs_to_zero.filter((b) => b.total_committed > 0);
  if (zerosWithComm.length > 0) {
    console.log(`⚠️  EXTENSIONISTAS A ZERAR (já têm entregas): ${zerosWithComm.length}`);
    console.log("──────────────────────────────────────────────");
    console.log(pad("ext_id", 12) + " " + pad("Nome", 32) + " " + pad("Província", 12) + padR("plan antigo", 14) + padR("já entregue", 14));
    for (const b of zerosWithComm.slice(0, 20)) {
      console.log(
        pad(b.id, 12) + " " +
        pad(b.name || "—", 32) + " " +
        pad(b.prov || "—", 12) +
        padR(fmt(b.total_planned_old), 14) +
        padR(fmt(b.total_committed), 14)
      );
    }
    if (zerosWithComm.length > 20) console.log(`  ... e mais ${zerosWithComm.length - 20}`);
    console.log("");
  }

  // Optional CSV export
  if (csvPath) {
    const lines = ["tipo,ext_id,sku,detalhe,qty_old,qty_new,diff"];
    for (const b of r.benefs_to_add) lines.push(`add,${b.id},,${(b.name||"").replace(/,/g," ")} (${b.prov}/${b.district}),0,${b.kit1+b.kit2},${b.kit1+b.kit2}`);
    for (const a of r.benefs_to_alias) lines.push(`alias,${a.old_id},,${(a.old_name||"").replace(/,/g," ")} → ${a.new_id},,,`);
    for (const b of r.benefs_to_zero) lines.push(`zero_benef,${b.id},,${(b.name||"").replace(/,/g," ")} (${b.prov}/${b.district}),${b.total_planned_old},0,${-b.total_planned_old}`);
    for (const u of r.balances_to_update) lines.push(`update,${u.ext_id},${u.sku},${u.label},${u.old_planned_qty},${u.new_planned_qty},${u.diff_qty}`);
    for (const c of r.balances_to_create) lines.push(`create,${c.ext_id},${c.sku},${c.label},0,${c.new_planned_qty},${c.new_planned_qty}`);
    for (const z of r.balances_to_zero) lines.push(`zero_bal,${z.ext_id},${z.sku},,${z.qty_old},0,${-z.qty_old}`);
    fs.writeFileSync(csvPath, lines.join("\n"));
    console.log(`📄 CSV detalhado escrito em: ${csvPath}`);
    console.log("");
  }

  console.log("─────────────────────────────────────────────────────────");

  if (!isApply) {
    console.log("✅ Dry-run completo. NADA foi escrito no DB.");
    console.log("");
    console.log("Para aplicar (depois de revisão):");
    console.log("  node scripts/maap-sync-admin.js --apply");
    console.log("");
    console.log("Para CSV detalhado:");
    console.log("  node scripts/maap-sync-admin.js --csv out.csv");
    console.log("─────────────────────────────────────────────────────────\n");
    process.exit(0);
  }

  // ─── APPLY MODE ───────────────────────────────────────────────
  console.log("");
  console.log("⚠️  MODO APPLY — vai ESCREVER no DB");
  console.log("  - Backup automático será criado primeiro");
  console.log("  - Tudo corre numa transacção (rollback se falhar)");
  console.log("  - committed_qty, delivered_qty NÃO são tocados");
  console.log("");
  const proceed = await promptYesNo("Aplicar mudanças agora?");
  if (!proceed) {
    console.log("Cancelado pelo utilizador.\n");
    process.exit(0);
  }

  console.log("");
  const result = await apply({ onLog: (s) => console.log(s) });
  console.log("");
  console.log("=========================================================");
  console.log("✅ APPLY COMPLETO");
  console.log("=========================================================");
  console.log("Beneficiários adicionados:    ", fmt(result.stats.nBenefAdded));
  console.log("Beneficiários marcados alias: ", fmt(result.stats.nBenefAliased));
  console.log("Saldos criados:               ", fmt(result.stats.nBalCreated));
  console.log("Saldos actualizados:          ", fmt(result.stats.nBalUpdated));
  console.log("Saldos zerados:               ", fmt(result.stats.nBalZeroed));
  console.log("");
  console.log("Backups criados:");
  console.log(`  ${result.backup.beneBackup}`);
  console.log(`  ${result.backup.balBackup}`);
  console.log("");
  console.log("Para REVERTER (caso descubras algo errado):");
  console.log(`  node scripts/maap-sync-admin.js --rollback ${result.tsStr}`);
  console.log("─────────────────────────────────────────────────────────\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("ERRO:", err.message);
  console.error(err.stack);
  process.exit(1);
});
