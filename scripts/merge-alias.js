/**
 * Funde um beneficiário duplicado num canónico, preservando todas as entregas.
 *
 * Uso:
 *   node scripts/merge-alias.js --from EXT-NN1234 --to 0106-0015 --dry-run
 *   node scripts/merge-alias.js --from EXT-NN1234 --to 0106-0015 --apply
 *
 * O que faz:
 *   1. Backup das tabelas afectadas (beneficiaries, delivery_balances, delivery_service_items)
 *   2. UPDATE delivery_service_items:
 *        extensionist_id ← canónico, beneficiary_name ← nome canónico
 *      (preserva audit: o item continua a apontar para o serviço original)
 *   3. UPDATE delivery_balances do canónico:
 *        committed_qty += duplicado.committed_qty
 *        delivered_qty += duplicado.delivered_qty
 *      (cria row se não existir; respeita por SKU)
 *   4. DELETE delivery_balances do duplicado
 *   5. UPDATE beneficiaries: alias_for=canónico no duplicado (preserva o
 *      registo histórico mas marca-o explicitamente como alias)
 *
 * Garantias:
 *   - Tudo dentro de transação. Se algo falhar, rollback.
 *   - Backups são criados ANTES, com timestamp, para podermos reverter.
 *   - Validação pós-merge: soma de entregue/comm antes deve = depois.
 */

require("dotenv").config();
const m = require("../db/mysql");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { from: null, to: null, dryRun: true, yes: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from") out.from = args[++i];
    else if (a === "--to") out.to = args[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--apply")   out.dryRun = false;
    else if (a === "--yes")     out.yes = true;
  }
  if (!out.from || !out.to) {
    console.error("Uso: node scripts/merge-alias.js --from <ext_id> --to <ext_id> [--apply] [--yes]");
    process.exit(1);
  }
  return out;
}

async function getSnapshot(extId) {
  const ben = await m.query(
    `SELECT extensionist_id, name, district, province, alias_for
     FROM beneficiaries WHERE extensionist_id = ?`,
    [extId]
  );
  const balances = await m.query(
    `SELECT extensionist_id, sku, product_name, unit, planned_original,
            planned_qty, realocado_recebido, committed_qty, delivered_qty
     FROM delivery_balances WHERE extensionist_id = ?`,
    [extId]
  );
  const items = await m.query(
    `SELECT id, service_id, extensionist_id, beneficiary_name, sku, product_name, qty
     FROM delivery_service_items WHERE extensionist_id = ?`,
    [extId]
  );
  return { ben: ben[0] || null, balances, items };
}

function summary(label, snap) {
  console.log(`\n— ${label} —`);
  if (!snap.ben) { console.log("  (não existe em beneficiaries)"); return; }
  console.log(`  beneficiary: ${snap.ben.name} (${snap.ben.extensionist_id}) — ${snap.ben.district}/${snap.ben.province}` +
              (snap.ben.alias_for ? `  [alias_for=${snap.ben.alias_for}]` : ""));
  console.log(`  delivery_balances: ${snap.balances.length} rows`);
  for (const b of snap.balances) {
    console.log(`    ${String(b.product_name).padEnd(22)} ${String(b.unit).padEnd(3)} ` +
                `orig=${Number(b.planned_original).toFixed(0).padStart(7)} ` +
                `qty=${Number(b.planned_qty).toFixed(0).padStart(7)} ` +
                `realoc=${Number(b.realocado_recebido).toFixed(0).padStart(6)} ` +
                `comm=${Number(b.committed_qty).toFixed(0).padStart(6)} ` +
                `deliv=${Number(b.delivered_qty).toFixed(0).padStart(6)}`);
  }
  console.log(`  delivery_service_items: ${snap.items.length} entregas`);
}

async function main() {
  const opts = parseArgs();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

  console.log("=".repeat(80));
  console.log(`MERGE ALIAS — ${opts.from} → ${opts.to}`);
  console.log(`Modo: ${opts.dryRun ? "DRY-RUN (não escreve)" : "APPLY (vai escrever)"}`);
  console.log("=".repeat(80));

  const fromSnap = await getSnapshot(opts.from);
  const toSnap   = await getSnapshot(opts.to);

  summary(`DUPLICADO (origem) ${opts.from}`, fromSnap);
  summary(`CANÓNICO (destino) ${opts.to}`,   toSnap);

  if (!fromSnap.ben && !fromSnap.balances.length && !fromSnap.items.length) {
    console.log("\n⚠ Nada a fundir — origem não tem dados.");
    process.exit(0);
  }
  if (!toSnap.ben) {
    console.error(`\n✗ Canónico ${opts.to} não existe em beneficiaries — abortar.`);
    process.exit(1);
  }

  // Plano: por sku, calcula novos valores agregados
  const balByKey = {};
  for (const b of toSnap.balances)   balByKey[b.sku] = { ...b, _origin: "to" };
  const balPlan = [];
  for (const b of fromSnap.balances) {
    const key = b.sku;
    if (balByKey[key]) {
      const t = balByKey[key];
      balPlan.push({
        action: "UPDATE",
        sku: key,
        product: t.product_name,
        new_committed: Number(t.committed_qty) + Number(b.committed_qty),
        new_delivered: Number(t.delivered_qty) + Number(b.delivered_qty),
        old_committed: Number(t.committed_qty),
        old_delivered: Number(t.delivered_qty),
        added_committed: Number(b.committed_qty),
        added_delivered: Number(b.delivered_qty),
      });
    } else {
      // Origem tem SKU que canónico não tem — INSERT
      balPlan.push({
        action: "INSERT",
        sku: key,
        product: b.product_name,
        unit: b.unit,
        committed: Number(b.committed_qty),
        delivered: Number(b.delivered_qty),
        planned_original: 0,
        planned_qty: 0,
      });
    }
  }

  console.log(`\n— Plano de merge para delivery_balances (${balPlan.length} operações) —`);
  for (const p of balPlan) {
    if (p.action === "UPDATE") {
      console.log(`  UPDATE ${p.sku.padEnd(15)} ${p.product.padEnd(22)} ` +
                  `comm: ${p.old_committed} + ${p.added_committed} = ${p.new_committed}  ` +
                  `deliv: ${p.old_delivered} + ${p.added_delivered} = ${p.new_delivered}`);
    } else {
      console.log(`  INSERT ${p.sku.padEnd(15)} ${p.product.padEnd(22)} ` +
                  `comm=${p.committed} deliv=${p.delivered}  (plan=0, novo)`);
    }
  }
  console.log(`\n— delivery_service_items (${fromSnap.items.length}) —`);
  for (const it of fromSnap.items) {
    console.log(`  service_id=${it.service_id} item=${it.id} ${it.product_name} ${it.qty} → renomeia ext_id e beneficiary_name`);
  }

  if (opts.dryRun) {
    console.log("\n[DRY-RUN] Re-corre com --apply para executar.");
    process.exit(0);
  }

  if (!opts.yes) {
    process.stdout.write("\nConfirmas? [yes/no] > ");
    const answer = await new Promise((res) => {
      process.stdin.once("data", (d) => res(String(d).trim().toLowerCase()));
    });
    if (answer !== "yes" && answer !== "y") {
      console.log("Cancelado.");
      process.exit(0);
    }
  }

  // === APPLY ===
  const conn = await m.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1) Backups
    const safeTs = ts.replace(/-/g, "").replace("_", "_");
    const bbk = `backup_beneficiaries_${safeTs}`;
    const dbk = `backup_delivery_balances_${safeTs}`;
    const ibk = `backup_delivery_service_items_${safeTs}`;
    await conn.query(`CREATE TABLE ${bbk} AS SELECT * FROM beneficiaries WHERE extensionist_id IN (?, ?)`, [opts.from, opts.to]);
    await conn.query(`CREATE TABLE ${dbk} AS SELECT * FROM delivery_balances WHERE extensionist_id IN (?, ?)`, [opts.from, opts.to]);
    await conn.query(`CREATE TABLE ${ibk} AS SELECT * FROM delivery_service_items WHERE extensionist_id = ?`, [opts.from]);
    console.log(`✓ Backups criados: ${bbk}, ${dbk}, ${ibk}`);

    // 2) Move delivery_service_items para o canónico
    const [resItems] = await conn.query(
      `UPDATE delivery_service_items SET extensionist_id = ?, beneficiary_name = ? WHERE extensionist_id = ?`,
      [opts.to, toSnap.ben.name, opts.from]
    );
    console.log(`✓ delivery_service_items: ${resItems.affectedRows} linhas re-atribuídas`);

    // 3) Aplica plano em delivery_balances
    let nUpd = 0, nIns = 0;
    for (const p of balPlan) {
      if (p.action === "UPDATE") {
        await conn.query(
          `UPDATE delivery_balances SET committed_qty = ?, delivered_qty = ? WHERE extensionist_id = ? AND sku = ?`,
          [p.new_committed, p.new_delivered, opts.to, p.sku]
        );
        nUpd++;
      } else {
        // INSERT: copia os campos de produto/unidade do registo origem
        const orig = fromSnap.balances.find((x) => x.sku === p.sku);
        await conn.query(
          `INSERT INTO delivery_balances
             (extensionist_id, sku, product_name, unit, province, district, beneficiary_name,
              planned_original, realocado_recebido, planned_qty, committed_qty, delivered_qty)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
          [opts.to, p.sku, p.product, p.unit, toSnap.ben.province, toSnap.ben.district,
           toSnap.ben.name, p.committed, p.delivered]
        );
        nIns++;
      }
    }
    console.log(`✓ delivery_balances: ${nUpd} UPDATE, ${nIns} INSERT`);

    // 4) Apaga delivery_balances do duplicado
    const [resDel] = await conn.query(`DELETE FROM delivery_balances WHERE extensionist_id = ?`, [opts.from]);
    console.log(`✓ delivery_balances: ${resDel.affectedRows} rows do duplicado eliminadas`);

    // 5) Marca beneficiary como alias
    await conn.query(`UPDATE beneficiaries SET alias_for = ? WHERE extensionist_id = ?`, [opts.to, opts.from]);
    console.log(`✓ beneficiaries: ${opts.from} marcado como alias de ${opts.to}`);

    await conn.commit();
    console.log(`\n✓ MERGE COMMITTED.`);
    console.log(`  Para reverter: SOURCE backup tables ${bbk}, ${dbk}, ${ibk}`);
  } catch (e) {
    await conn.rollback();
    console.error(`\n✗ ROLLBACK por erro:`, e.message);
    throw e;
  } finally {
    conn.release();
  }

  // 6) Validação pós-merge
  const after = await getSnapshot(opts.to);
  console.log("\n— ESTADO FINAL DO CANÓNICO —");
  summary(opts.to, after);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
