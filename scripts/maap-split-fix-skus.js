/**
 * Repara o erro do scripts/maap-split-collisions.js que criou rows com SKUs
 * errados para Emamectin (AGRIEMAMECTIN em vez de AGRIFEMMA01L) e
 * Imidacloprid (AGRIIMIDACLO em vez de AGRIMIDACLORP1L).
 *
 * 1. Apaga as 30 rows criadas com SKUs errados
 * 2. UPDATE in-place as rows existentes (com SKU correcto) para os valores
 *    finais correctos, baseados no kit1 final de cada P1/P2.
 *
 * Uso:
 *   node scripts/maap-split-fix-skus.js --apply
 */

require("dotenv").config();
const m = require("../db/mysql");

// IDs afectados pelos splits
const FINAL_KIT1 = {
  // P1 (mantêm ID original)
  "0509-0006": { name: "Mouza Galatia",            kit1: 7,   kit2: 0, district: "Changara",   province: "Tete"   },
  "0514-0001": { name: "Almiro António Aleque",     kit1: 5,   kit2: 0, district: "Maravia",    province: "Tete"   },
  "0514-0002": { name: "Chone Matias Chacumalane",  kit1: 10,  kit2: 0, district: "Maravia",    province: "Tete"   },
  "0514-0003": { name: "Flora Atiana Manteiga",     kit1: 20,  kit2: 0, district: "Maravia",    province: "Tete"   },
  "0514-0004": { name: "Neto Narcisa Jacinto António", kit1: 5, kit2: 0, district: "Maravia",   province: "Tete"   },
  "0514-0005": { name: "Timotio Clementino Daniel", kit1: 10,  kit2: 0, district: "Maravia",    province: "Tete"   },
  "0210-0001": { name: "Viegas Andre Robate",       kit1: 0,   kit2: 0, district: "Vanduzi",    province: "Manica" },
  "0210-0002": { name: "Chenguetai Quichine",       kit1: 13,  kit2: 0, district: "Barue",      province: "Manica" },
  // P2 (novos IDs)
  "0510-0008": { name: "Albertina Reis Martinho",   kit1: 21,  kit2: 0, district: "Chifunde",   province: "Tete"   },
  "0515-0001": { name: "Antonio Osvaldo Ausse",     kit1: 56,  kit2: 0, district: "Mutarara",   province: "Tete"   },
  "0515-0002": { name: "Carlito Jose Angola",       kit1: 56,  kit2: 0, district: "Mutarara",   province: "Tete"   },
  "0515-0003": { name: "Isaquel Amilcar Andate-Fanessi", kit1: 56, kit2: 0, district: "Mutarara", province: "Tete" },
  "0515-0004": { name: "Julio Vasco Chimica",       kit1: 56,  kit2: 0, district: "Mutarara",   province: "Tete"   },
  "0515-0005": { name: "Meque Nhamitambo",          kit1: 56,  kit2: 0, district: "Mutarara",   province: "Tete"   },
  "0212-0001": { name: "Antonio J. Azeite",         kit1: 329, kit2: 0, district: "Sussundenga", province: "Manica" },
  "0212-0002": { name: "Guilherme Mardez",          kit1: 231, kit2: 0, district: "Sussundenga", province: "Manica" },
};

// SKUs CORRECTOS (os usados no resto do sistema)
const CORRECT_SKUS = [
  { product: "Milho",            sku: "MXIXMILHOKG",     unit: "kg", kit1: 12.5, kit2: 0   },
  { product: "Feijão",           sku: "MXIXFEIJAOKG",    unit: "kg", kit1: 15,   kit2: 15  },
  { product: "Arroz",            sku: "MXIXARROZKG",     unit: "kg", kit1: 0,    kit2: 50  },
  { product: "Sacos Hermeticos", sku: "SUSSACO",         unit: "un", kit1: 20,   kit2: 0   },
  { product: "Emamectin",        sku: "AGRIFEMMA01L",    unit: "L",  kit1: 0.5,  kit2: 0.5 },
  { product: "Imidacloprid",     sku: "AGRIMIDACLORP1L", unit: "L",  kit1: 0.5,  kit2: 0   },
  { product: "MCPA",             sku: "AGRIMHMCPA1L",    unit: "L",  kit1: 0,    kit2: 1.5 },
];

// SKUs errados a apagar (criados pelo script anterior)
const WRONG_SKUS = ["AGRIEMAMECTIN", "AGRIIMIDACLO"];

const dryRun = !process.argv.includes("--apply");

async function main() {
  console.log("=".repeat(70));
  console.log(`MAAP SPLIT — fix SKUs ${dryRun ? "(DRY-RUN)" : "(APPLY)"}`);
  console.log("=".repeat(70));

  const ids = Object.keys(FINAL_KIT1);
  const placeholders = ids.map(() => "?").join(",");

  // 1. Mostrar/apagar rows com SKUs errados
  const wrongRows = await m.query(
    `SELECT extensionist_id, sku, product_name, planned_original, committed_qty, delivered_qty
     FROM delivery_balances
     WHERE extensionist_id IN (${placeholders}) AND sku IN (?, ?)
     ORDER BY extensionist_id, sku`,
    [...ids, ...WRONG_SKUS]
  );
  console.log(`\n${wrongRows.length} rows com SKU errado a apagar:`);
  for (const r of wrongRows) {
    console.log(`  DELETE  ${r.extensionist_id} ${r.sku.padEnd(15)} ${r.product_name.padEnd(15)} orig=${r.planned_original}`);
  }

  // 2. Mostrar UPDATEs necessários nas rows com SKU correcto
  const updates = []; // { ext_id, sku, planned, comm, deliv, source }
  for (const ext of ids) {
    const f = FINAL_KIT1[ext];
    // Buscar items existentes deste ext_id (committed/delivered correctos)
    const items = await m.query(
      `SELECT i.product_name, i.qty, s.status
       FROM delivery_service_items i JOIN delivery_services s ON s.id = i.service_id
       WHERE i.extensionist_id = ?`,
      [ext]
    );
    const aggByProd = {};
    for (const it of items) {
      const p = it.product_name;
      if (!aggByProd[p]) aggByProd[p] = { c: 0, d: 0 };
      aggByProd[p].c += Number(it.qty);
      if (String(it.status) === "delivered") aggByProd[p].d += Number(it.qty);
    }
    for (const c of CORRECT_SKUS) {
      const planned = f.kit1 * c.kit1 + f.kit2 * c.kit2;
      const agg = aggByProd[c.product] || { c: 0, d: 0 };
      // Só processa SKUs onde algo precisa ser actualizado
      const exists = await m.query(
        `SELECT planned_original, committed_qty, delivered_qty FROM delivery_balances WHERE extensionist_id = ? AND sku = ?`,
        [ext, c.sku]
      );
      if (planned <= 0 && agg.c <= 0 && agg.d <= 0) {
        // Se existe row mas tudo deveria ser 0, vamos zerar / marcar para apagar depois
        if (exists.length > 0) {
          updates.push({ ext_id: ext, sku: c.sku, name: f.name, prov: f.province, district: f.district, product: c.product, unit: c.unit, planned: 0, comm: 0, deliv: 0, action: "ZERO" });
        }
        continue;
      }
      if (exists.length > 0) {
        const cur = exists[0];
        if (Number(cur.planned_original) !== planned || Number(cur.committed_qty) !== agg.c || Number(cur.delivered_qty) !== agg.d) {
          updates.push({ ext_id: ext, sku: c.sku, name: f.name, prov: f.province, district: f.district, product: c.product, unit: c.unit, planned, comm: agg.c, deliv: agg.d, action: "UPDATE", was: cur });
        }
      } else if (planned > 0 || agg.c > 0 || agg.d > 0) {
        updates.push({ ext_id: ext, sku: c.sku, name: f.name, prov: f.province, district: f.district, product: c.product, unit: c.unit, planned, comm: agg.c, deliv: agg.d, action: "INSERT" });
      }
    }
  }
  console.log(`\n${updates.length} updates a aplicar:`);
  for (const u of updates.slice(0, 30)) {
    if (u.action === "UPDATE") {
      console.log(`  UPDATE ${u.ext_id} ${u.sku.padEnd(15)} ${u.product.padEnd(15)} planned: ${u.was.planned_original} → ${u.planned}, comm: ${u.was.committed_qty} → ${u.comm}, deliv: ${u.was.delivered_qty} → ${u.deliv}`);
    } else if (u.action === "INSERT") {
      console.log(`  INSERT ${u.ext_id} ${u.sku.padEnd(15)} ${u.product.padEnd(15)} planned=${u.planned} comm=${u.comm} deliv=${u.deliv}`);
    } else if (u.action === "ZERO") {
      console.log(`  ZERO   ${u.ext_id} ${u.sku.padEnd(15)} ${u.product.padEnd(15)}`);
    }
  }
  if (updates.length > 30) console.log(`  ... e mais ${updates.length - 30}`);

  if (dryRun) {
    console.log("\n[DRY-RUN] Re-corre com --apply para executar.");
    process.exit(0);
  }

  // ── APPLY ──
  const conn = await m.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // Backup
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19).replace(/-/g, "").replace("_", "_");
    await conn.query(
      `CREATE TABLE backup_split_fix_skus_${ts} AS SELECT * FROM delivery_balances WHERE extensionist_id IN (${placeholders})`,
      ids
    );
    console.log(`✓ Backup: backup_split_fix_skus_${ts}`);

    // 1. Delete wrong-SKU rows
    const [delRes] = await conn.query(
      `DELETE FROM delivery_balances WHERE extensionist_id IN (${placeholders}) AND sku IN (?, ?)`,
      [...ids, ...WRONG_SKUS]
    );
    console.log(`✓ Apagadas ${delRes.affectedRows} rows com SKUs errados`);

    // 2. Apply updates
    let nUpd = 0, nIns = 0, nZero = 0;
    for (const u of updates) {
      if (u.action === "INSERT") {
        await conn.query(
          `INSERT INTO delivery_balances
             (extensionist_id, sku, product_name, unit, province, district, beneficiary_name,
              planned_original, realocado_recebido, planned_qty, committed_qty, delivered_qty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          [u.ext_id, u.sku, u.product, u.unit, u.prov, u.district, u.name, u.planned, u.planned, u.comm, u.deliv]
        );
        nIns++;
      } else {
        // UPDATE ou ZERO — ambos via UPDATE
        await conn.query(
          `UPDATE delivery_balances
           SET planned_original = ?, planned_qty = ? - realocado_recebido,
               committed_qty = ?, delivered_qty = ?,
               beneficiary_name = ?, district = ?, province = ?
           WHERE extensionist_id = ? AND sku = ?`,
          [u.planned, u.planned, u.comm, u.deliv, u.name, u.district, u.prov, u.ext_id, u.sku]
        );
        if (u.action === "ZERO") nZero++; else nUpd++;
      }
    }
    console.log(`✓ ${nUpd} UPDATE, ${nIns} INSERT, ${nZero} ZERO`);

    // 3. Cleanup: remove balances totalmente zeradas e sem service_items a apontar
    const [cleanRes] = await conn.query(
      `DELETE FROM delivery_balances
       WHERE extensionist_id IN (${placeholders})
         AND planned_original = 0 AND committed_qty = 0 AND delivered_qty = 0
         AND NOT EXISTS (SELECT 1 FROM delivery_service_items i
                         WHERE i.extensionist_id = delivery_balances.extensionist_id
                           AND i.sku = delivery_balances.sku)`,
      ids
    );
    console.log(`✓ Limpeza: ${cleanRes.affectedRows} rows zeradas removidas`);

    await conn.commit();
    console.log("\n✓ FIX COMMITTED");
  } catch (e) {
    await conn.rollback();
    console.error("✗ ROLLBACK:", e.message);
    throw e;
  } finally {
    conn.release();
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
