/**
 * Resolve as 8 colisões de IDs MAAP detectadas (mesma chave usada para 2
 * pessoas distintas) + deduplica casos com mesma pessoa em 2 linhas.
 *
 * Para cada par P1/P2:
 *   - P1 mantém o ID original (Mouza, Almiro, Chone, ...)
 *   - P2 recebe um ID NOVO confirmado pelo coordenador (Albertina, Antonio
 *     Ausse, Carlito Angola, ...)
 *   - planned_original / planned_qty são recalculados para cada um a partir
 *     do kit1 correcto × KIT_RECIPE.
 *   - delivery_service_items existentes são re-atribuídos a P2 ou P1 com
 *     base na qty (se qty == kit1_P2 × recipe[product].kit1 → P2).
 *   - committed_qty / delivered_qty são recalculados nas balances a partir
 *     dos items que ficam em cada lado.
 *
 * Para Diniz Malemia (Gaza 0103-0004): 2 linhas idênticas no Excel. Halve
 *   o planned (32 kit1 → 16 kit1).
 *
 * Para Ruth (Sofala 0408-0006): no-op (linha 1 qty=0 + linha 2 qty=709 = 709
 *   coincidentemente o valor correcto).
 *
 * Uso:
 *   node scripts/maap-split-collisions.js --dry-run     (default)
 *   node scripts/maap-split-collisions.js --apply --yes
 */

require("dotenv").config();
const m = require("../db/mysql");
const { KIT_RECIPE } = require("../lib/parse-maap");

// SKU canónico por nome de produto. Os SKUs aqui têm de bater EXACTAMENTE
// com os usados pela importação principal (`distribution-bootstrap.js` e
// `app.js → SKU_MAP`) — uma divergência cria rows duplicadas em
// `delivery_balances` (a FK composta {ext_id, sku} é a única protecção).
// Confirmado no schema actual:
const PRODUCT_TO_SKU = {
  "Milho":            { sku: "MXIXMILHOKG",     unit: "kg" },
  "Feijão":           { sku: "MXIXFEIJAOKG",    unit: "kg" },
  "Arroz":            { sku: "MXIXARROZKG",     unit: "kg" },
  "Sacos Hermeticos": { sku: "SUSSACO",         unit: "un" },
  "Emamectin":        { sku: "AGRIFEMMA01L",    unit: "L"  },
  "Imidacloprid":     { sku: "AGRIMIDACLORP1L", unit: "L"  },
  "MCPA":             { sku: "AGRIMHMCPA1L",    unit: "L"  },
};

// Recipe por nome de produto. KIT_RECIPE em parse-maap usa nomes como
// "Feijão Vulgar" e "Emamectim Benzoato" — aqui mapeamos os nomes da DB.
const RECIPE_BY_DB_NAME = {
  "Milho":            { kit1: 12.5, kit2: 0    },
  "Feijão":           { kit1: 15,   kit2: 15   },
  "Arroz":            { kit1: 0,    kit2: 50   },
  "Sacos Hermeticos": { kit1: 20,   kit2: 0    },
  "Emamectin":        { kit1: 0.5,  kit2: 0.5  },
  "Imidacloprid":     { kit1: 0.5,  kit2: 0    },
  "MCPA":             { kit1: 0,    kit2: 1.5  },
};

// Os 8 splits, cada um descrevendo P1 (mantém o ID) e P2 (NOVO ID)
const SPLITS = [
  // ── Tete ────────────────────────────────────────────────────
  {
    province: "Tete",
    p1: { ext_id: "0509-0006", name: "Mouza Galatia",            kit1: 7,  kit2: 0,
          district: "Changara", location: "Mazoe",
          contact: "870490007", supervisor: "Gentil Afuala", supervisor_phone: "874930632" },
    p2: { ext_id: "0510-0008", name: "Albertina Reis Martinho",  kit1: 21, kit2: 0,
          district: "Chifunde", location: "Angombe",
          contact: "866276402", supervisor: "Jerson Francisco Saguate", supervisor_phone: "873584824" },
  },
  {
    province: "Tete",
    p1: { ext_id: "0514-0001", name: "Almiro António Aleque",     kit1: 5,  kit2: 0,
          district: "Maravia", location: "Malowera",
          contact: "865133516", supervisor: "Endro P.A Vicente", supervisor_phone: "876440285" },
    p2: { ext_id: "0515-0001", name: "Antonio Osvaldo Ausse",     kit1: 56, kit2: 0,
          district: "Mutarara", location: "Canhungue",
          contact: "", supervisor: "Toto Araujo Macajo", supervisor_phone: "846916018" },
  },
  {
    province: "Tete",
    p1: { ext_id: "0514-0002", name: "Chone Matias Chacumalane",  kit1: 10, kit2: 0,
          district: "Maravia", location: "Chipumgu",
          contact: "867663502", supervisor: "Endro P.A Vicente", supervisor_phone: "876440285" },
    p2: { ext_id: "0515-0002", name: "Carlito Jose Angola",       kit1: 56, kit2: 0,
          district: "Mutarara", location: "Vila Nova da Fronteira",
          contact: "841484730", supervisor: "Toto Araujo Macajo", supervisor_phone: "846916018" },
  },
  {
    province: "Tete",
    p1: { ext_id: "0514-0003", name: "Flora Atiana Manteiga",     kit1: 20, kit2: 0,
          district: "Maravia", location: "Fingoe",
          contact: "868993740", supervisor: "Endro P.A Vicente", supervisor_phone: "876440285" },
    p2: { ext_id: "0515-0003", name: "Isaquel Amilcar Andate-Fanessi", kit1: 56, kit2: 0,
          district: "Mutarara", location: "Inhangoma-Sede",
          contact: "", supervisor: "Toto Araujo Macajo", supervisor_phone: "846916018" },
  },
  {
    province: "Tete",
    p1: { ext_id: "0514-0004", name: "Neto Narcisa Jacinto António", kit1: 5,  kit2: 0,
          district: "Maravia", location: "Malowera",
          contact: "869087380", supervisor: "Endro P.A Vicente", supervisor_phone: "876440285" },
    p2: { ext_id: "0515-0004", name: "Julio Vasco Chimica",       kit1: 56, kit2: 0,
          district: "Mutarara", location: "Nhamayabwe-Sede",
          contact: "840200222", supervisor: "Toto Araujo Macajo", supervisor_phone: "846916018" },
  },
  {
    province: "Tete",
    p1: { ext_id: "0514-0005", name: "Timotio Clementino Daniel", kit1: 10, kit2: 0,
          district: "Maravia", location: "Uncanha",
          contact: "879205324", supervisor: "Endro P.A Vicente", supervisor_phone: "876440285" },
    p2: { ext_id: "0515-0005", name: "Meque Nhamitambo",          kit1: 56, kit2: 0,
          district: "Mutarara", location: "Canámua",
          contact: "844148631", supervisor: "Toto Araujo Macajo", supervisor_phone: "846916018" },
  },
  // ── Manica ──────────────────────────────────────────────────
  {
    province: "Manica",
    p1: { ext_id: "0210-0001", name: "Viegas Andre Robate",       kit1: 0,  kit2: 0,
          district: "Vanduzi", location: "",
          contact: "879736774", supervisor: "", supervisor_phone: "" },
    p2: { ext_id: "0212-0001", name: "Antonio J. Azeite",         kit1: 329, kit2: 0,
          district: "Sussundenga", location: "Darue- Maquina",
          contact: "862412585", supervisor: "", supervisor_phone: "" },
  },
  {
    province: "Manica",
    p1: { ext_id: "0210-0002", name: "Chenguetai Quichine",       kit1: 13, kit2: 0,
          district: "Barue", location: "Chuala",
          contact: "862441603", supervisor: "", supervisor_phone: "" },
    p2: { ext_id: "0212-0002", name: "Guilherme Mardez",          kit1: 231, kit2: 0,
          district: "Sussundenga", location: "Bunga",
          contact: "861570025", supervisor: "", supervisor_phone: "" },
  },
];

// Caso especial: deduplicação (mesma pessoa duplicada no Excel)
const DEDUP = [
  {
    ext_id: "0103-0004", name: "Diniz Malemia",
    actual_kit1: 16, // o real, segundo o Excel (1 linha, não soma de 2)
    note: "2 linhas Excel idênticas (qty=16 cada) somadas erradamente para 32",
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: !args.includes("--apply"),
    yes: args.includes("--yes"),
  };
}

// Calcula qty esperada para um produto, dado kit1/kit2 do extensionista
function expectedQty(productName, kit1, kit2) {
  const r = RECIPE_BY_DB_NAME[productName];
  if (!r) return null;
  return kit1 * r.kit1 + kit2 * r.kit2;
}

// Classifica um delivery_service_item: pertence a P1 ou P2?
// Usa matching de qty (com tolerância de 0.5 unidade) contra o esperado
// para cada um.
function classifyItem(item, p1, p2) {
  const product = item.product_name;
  const e1 = expectedQty(product, p1.kit1, p1.kit2);
  const e2 = expectedQty(product, p2.kit1, p2.kit2);
  const qty = Number(item.qty);
  const tol = 0.5;
  const match1 = e1 !== null && Math.abs(qty - e1) < tol && p1.kit1 + p1.kit2 > 0;
  const match2 = e2 !== null && Math.abs(qty - e2) < tol && p2.kit1 + p2.kit2 > 0;
  if (match2 && !match1)  return "P2";
  if (match1 && !match2)  return "P1";
  if (match1 && match2)   return "ambíguo (qty=expected1=expected2)";
  // Fallback: se qty <= e1, fica P1; se qty == e1+e2 = soma para um deles?
  return "P1"; // default conservador: fica em P1 (a sair, não criar saldo P2 falso)
}

async function dryRunSplit(split) {
  const { p1, p2 } = split;
  const items = await m.query(
    `SELECT i.id AS item_id, i.service_id, s.service_number, s.status,
            i.extensionist_id, i.beneficiary_name, i.product_name, i.qty, i.unit
     FROM delivery_service_items i
     JOIN delivery_services s ON s.id = i.service_id
     WHERE i.extensionist_id = ?`,
    [p1.ext_id]
  );
  const balances = await m.query(
    `SELECT * FROM delivery_balances WHERE extensionist_id = ?`,
    [p1.ext_id]
  );

  console.log(`\n┌── ${p1.ext_id} ${p1.name}  ↔  ${p2.ext_id} ${p2.name}`);
  console.log(`│   kit1: P1=${p1.kit1} P2=${p2.kit1}`);
  console.log(`│   ${balances.length} balances · ${items.length} service_items`);

  // Classifica items
  const moveToP2 = [];
  const stayAtP1 = [];
  for (const it of items) {
    const cls = classifyItem(it, p1, p2);
    if (cls === "P2") moveToP2.push(it);
    else stayAtP1.push(it);
  }
  console.log(`│   service_items → P2: ${moveToP2.length}, → P1: ${stayAtP1.length}`);
  for (const it of moveToP2) {
    console.log(`│     [→P2] ${it.service_number} ${String(it.product_name).padEnd(20)} qty=${it.qty} ${it.unit} (${it.status})`);
  }
  for (const it of stayAtP1) {
    console.log(`│     [P1]  ${it.service_number} ${String(it.product_name).padEnd(20)} qty=${it.qty} ${it.unit} (${it.status})`);
  }

  // Computar balances novos
  console.log(`│   Balances (planned recalculados):`);
  const allProducts = ["Milho", "Feijão", "Arroz", "Sacos Hermeticos", "Emamectin", "Imidacloprid", "MCPA"];
  for (const prod of allProducts) {
    const eP1 = expectedQty(prod, p1.kit1, p1.kit2) || 0;
    const eP2 = expectedQty(prod, p2.kit1, p2.kit2) || 0;
    if (eP1 === 0 && eP2 === 0) continue;
    const cur = balances.find((b) => b.product_name === prod);
    const curStr = cur ? `cur=${Number(cur.planned_original)}` : `cur=(none)`;
    console.log(`│     ${prod.padEnd(20)}  P1: ${eP1.toString().padStart(6)}  P2: ${eP2.toString().padStart(6)}  ${curStr}`);
  }
}

async function applySplit(split, conn, ts) {
  const { p1, p2, province } = split;

  // Backups (uma vez por par; tabelas existirão; OR REPLACE)
  // (Os backups gerais são feitos uma vez no início.)

  // 1. Update P1 beneficiary (corrigir distrito/localidade/contacto)
  await conn.query(
    `INSERT INTO beneficiaries (extensionist_id, name, province, district, localidade, contact, supervisor_name, supervisor_phone, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       name=VALUES(name), province=VALUES(province), district=VALUES(district),
       localidade=VALUES(localidade), contact=VALUES(contact),
       supervisor_name=VALUES(supervisor_name), supervisor_phone=VALUES(supervisor_phone)`,
    [p1.ext_id, p1.name, province, p1.district, p1.location || null,
     p1.contact || null, p1.supervisor || null, p1.supervisor_phone || null]
  );

  // 2. Create P2 beneficiary
  await conn.query(
    `INSERT INTO beneficiaries (extensionist_id, name, province, district, localidade, contact, supervisor_name, supervisor_phone, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       name=VALUES(name), province=VALUES(province), district=VALUES(district),
       localidade=VALUES(localidade), contact=VALUES(contact),
       supervisor_name=VALUES(supervisor_name), supervisor_phone=VALUES(supervisor_phone)`,
    [p2.ext_id, p2.name, province, p2.district, p2.location || null,
     p2.contact || null, p2.supervisor || null, p2.supervisor_phone || null]
  );

  // 3. Buscar items, classificar, mover os que vão para P2
  const [items] = await conn.query(
    `SELECT i.id AS item_id, i.service_id, s.service_number, s.status,
            i.extensionist_id, i.beneficiary_name, i.sku, i.product_name, i.qty, i.unit
     FROM delivery_service_items i
     JOIN delivery_services s ON s.id = i.service_id
     WHERE i.extensionist_id = ?`,
    [p1.ext_id]
  );

  const moveToP2 = [];
  const stayAtP1 = [];
  for (const it of items) {
    if (classifyItem(it, p1, p2) === "P2") moveToP2.push(it);
    else stayAtP1.push(it);
  }

  // ── Ordem importante por causa de FK (extensionist_id, sku) ──
  //
  // delivery_service_items tem FK composta para delivery_balances. Se
  // mexermos nas balances antes de mover items (DELETE+INSERT), os items
  // que ainda apontam para o ext_id+sku ficam órfãos durante o processo.
  // E se movermos items para P2 antes de criar P2's balance row, FK falha.
  //
  // Estratégia: garantir que TODAS as balances necessárias existem ANTES
  // de mexer nos items. Depois UPDATE in-place.

  const allProducts = ["Milho", "Feijão", "Arroz", "Sacos Hermeticos", "Emamectin", "Imidacloprid", "MCPA"];
  const aggregateByProduct = (itemList) => {
    const out = {};
    for (const it of itemList) {
      const p = it.product_name;
      if (!out[p]) out[p] = { committed: 0, delivered: 0 };
      const q = Number(it.qty);
      out[p].committed += q;
      if (String(it.status) === "delivered") out[p].delivered += q;
    }
    return out;
  };
  const p1Agg = aggregateByProduct(stayAtP1);
  const p2Agg = aggregateByProduct(moveToP2);

  // Helper: INSERT ou UPDATE in-place de uma balance
  const upsertBalance = async (extId, name, district, prod, planned, comm, deliv) => {
    const meta = PRODUCT_TO_SKU[prod];
    if (!meta) return;
    if (planned <= 0 && comm <= 0 && deliv <= 0) {
      // Skip: nem cria nem actualiza (mantém estado actual ou ausente)
      // MAS se já existe e nada disso é > 0, podemos zerar ou apagar.
      return;
    }
    await conn.query(
      `INSERT INTO delivery_balances
         (extensionist_id, sku, product_name, unit, province, district, beneficiary_name,
          planned_original, realocado_recebido, planned_qty, committed_qty, delivered_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         product_name=VALUES(product_name), unit=VALUES(unit),
         province=VALUES(province), district=VALUES(district),
         beneficiary_name=VALUES(beneficiary_name),
         planned_original=VALUES(planned_original),
         planned_qty=VALUES(planned_qty),
         committed_qty=VALUES(committed_qty),
         delivered_qty=VALUES(delivered_qty)`,
      [extId, meta.sku, prod, meta.unit, province, district, name, planned, planned, comm, deliv]
    );
  };

  // 3. ANTES de mexer nos items, garante que P2 tem balance row para
  //    cada SKU que vai receber items. Inicialmente põe committed/delivered
  //    a 0 — actualizamos depois quando os items já estão movidos.
  //    Para isto, iteramos os items que VÃO mover e criamos balance para
  //    o SKU+ext_id correspondente.
  for (const it of moveToP2) {
    const meta = PRODUCT_TO_SKU[it.product_name];
    if (!meta) continue;
    const planned = expectedQty(it.product_name, p2.kit1, p2.kit2) || 0;
    // Cria placeholder com committed/delivered = 0 (será actualizado depois)
    await conn.query(
      `INSERT IGNORE INTO delivery_balances
         (extensionist_id, sku, product_name, unit, province, district, beneficiary_name,
          planned_original, realocado_recebido, planned_qty, committed_qty, delivered_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0)`,
      [p2.ext_id, meta.sku, it.product_name, meta.unit, province, p2.district, p2.name,
       planned, planned]
    );
  }

  // 4. Mover service_items para P2 (FK agora satisfeita)
  for (const it of moveToP2) {
    await conn.query(
      `UPDATE delivery_service_items SET extensionist_id = ?, beneficiary_name = ? WHERE id = ?`,
      [p2.ext_id, p2.name, it.item_id]
    );
  }

  // 5. Aplicar balances finais (P1 e P2) com committed/delivered correctos
  for (const prod of allProducts) {
    const planned = expectedQty(prod, p1.kit1, p1.kit2) || 0;
    const agg = p1Agg[prod] || { committed: 0, delivered: 0 };
    await upsertBalance(p1.ext_id, p1.name, p1.district, prod, planned, agg.committed, agg.delivered);
  }
  for (const prod of allProducts) {
    const planned = expectedQty(prod, p2.kit1, p2.kit2) || 0;
    const agg = p2Agg[prod] || { committed: 0, delivered: 0 };
    await upsertBalance(p2.ext_id, p2.name, p2.district, prod, planned, agg.committed, agg.delivered);
  }

  // 6. Limpa balances P1 que ficaram com tudo a zero (não tinham items
  //    e não fazem parte do plano de P1). Cuidado: só apagar se NÃO
  //    houver service_items a apontar (FK).
  await conn.query(
    `DELETE FROM delivery_balances
     WHERE extensionist_id = ?
       AND planned_original = 0 AND committed_qty = 0 AND delivered_qty = 0
       AND NOT EXISTS (SELECT 1 FROM delivery_service_items i
                       WHERE i.extensionist_id = delivery_balances.extensionist_id
                         AND i.sku = delivery_balances.sku)`,
    [p1.ext_id]
  );

  return { moved: moveToP2.length, stayed: stayAtP1.length };
}

async function applyDedup(d, conn) {
  // Para o Diniz: re-calcula planned baseado em kit1=16 (não 32)
  const allProducts = ["Milho", "Feijão", "Arroz", "Sacos Hermeticos", "Emamectin", "Imidacloprid", "MCPA"];
  const ben = await m.query(`SELECT * FROM beneficiaries WHERE extensionist_id = ?`, [d.ext_id]);
  if (!ben.length) {
    console.log(`  ⚠ ${d.ext_id} não existe — saltado`);
    return { halved: 0 };
  }
  const b = ben[0];
  let n = 0;
  for (const prod of allProducts) {
    const r = RECIPE_BY_DB_NAME[prod];
    if (!r) continue;
    const newPlanned = d.actual_kit1 * r.kit1; // assumindo kit2=0 (Diniz tem só kit1)
    const meta = PRODUCT_TO_SKU[prod];
    if (!meta) continue;
    // Update se existir, senão skip (não cria do zero — mantém só os existentes)
    const [res] = await conn.query(
      `UPDATE delivery_balances
       SET planned_original = ?, planned_qty = planned_original - realocado_recebido
       WHERE extensionist_id = ? AND sku = ?`,
      [newPlanned, d.ext_id, meta.sku]
    );
    if (res.affectedRows > 0) n++;
  }
  return { halved: n };
}

async function main() {
  const opts = parseArgs();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19).replace(/-/g, "").replace("_", "_");

  console.log("=".repeat(80));
  console.log(`MAAP SPLIT COLLISIONS — ${opts.dryRun ? "DRY-RUN" : "APPLY"}`);
  console.log("=".repeat(80));

  // Pré-validação: todos os P1 existem?
  const allP1 = SPLITS.map((s) => s.p1.ext_id);
  const allP2 = SPLITS.map((s) => s.p2.ext_id);
  const allDedup = DEDUP.map((d) => d.ext_id);
  const exists = await m.query(
    `SELECT extensionist_id FROM beneficiaries WHERE extensionist_id IN (${[...allP1, ...allP2, ...allDedup].map(() => "?").join(",")})`,
    [...allP1, ...allP2, ...allDedup]
  );
  const existsSet = new Set(exists.map((x) => x.extensionist_id));
  const missingP1 = allP1.filter((id) => !existsSet.has(id));
  if (missingP1.length) {
    console.log(`⚠ P1 não existe na DB: ${missingP1.join(", ")} — abortar`);
    process.exit(1);
  }
  const newP2 = allP2.filter((id) => !existsSet.has(id));
  console.log(`✓ Validação OK: ${allP1.length} P1 existentes, ${newP2.length} P2 novos a criar (${allP2.length - newP2.length} já existem)`);

  // Dry-run: mostra plano detalhado de cada split
  for (const split of SPLITS) await dryRunSplit(split);

  // Dedup: mostra plano
  console.log("\n— DEDUPLICAÇÕES —");
  for (const d of DEDUP) {
    const allProducts = ["Milho", "Feijão", "Arroz", "Sacos Hermeticos", "Emamectin", "Imidacloprid", "MCPA"];
    console.log(`  ${d.ext_id} ${d.name} — kit1: 32 → ${d.actual_kit1} (${d.note})`);
    for (const prod of allProducts) {
      const r = RECIPE_BY_DB_NAME[prod];
      if (!r) continue;
      const newP = d.actual_kit1 * r.kit1;
      const oldP = 32 * r.kit1;
      if (oldP > 0) console.log(`    ${prod.padEnd(20)} ${oldP} → ${newP}`);
    }
  }

  if (opts.dryRun) {
    console.log("\n[DRY-RUN] Re-corre com --apply --yes para executar.");
    process.exit(0);
  }

  if (!opts.yes) {
    process.stdout.write("\nConfirmas? [yes/no] > ");
    const ans = await new Promise((r) => process.stdin.once("data", (d) => r(String(d).trim().toLowerCase())));
    if (ans !== "yes" && ans !== "y") { console.log("Cancelado."); process.exit(0); }
  }

  // === APPLY ===
  const conn = await m.getPool().getConnection();
  try {
    await conn.beginTransaction();

    // 1. Backups
    const idsAffected = [...new Set([...allP1, ...allP2, ...allDedup])];
    const placeholders = idsAffected.map(() => "?").join(",");
    await conn.query(`CREATE TABLE backup_split_beneficiaries_${ts} AS SELECT * FROM beneficiaries WHERE extensionist_id IN (${placeholders})`, idsAffected);
    await conn.query(`CREATE TABLE backup_split_delivery_balances_${ts} AS SELECT * FROM delivery_balances WHERE extensionist_id IN (${placeholders})`, idsAffected);
    await conn.query(`CREATE TABLE backup_split_delivery_service_items_${ts} AS SELECT * FROM delivery_service_items WHERE extensionist_id IN (${placeholders})`, idsAffected);
    console.log(`✓ Backups: backup_split_*_${ts}`);

    // 2. Splits
    let totalMoved = 0;
    for (const split of SPLITS) {
      const r = await applySplit(split, conn, ts);
      console.log(`✓ Split ${split.p1.ext_id} → ${split.p2.ext_id}: ${r.moved} items movidos, ${r.stayed} ficam`);
      totalMoved += r.moved;
    }

    // 3. Dedups
    for (const d of DEDUP) {
      const r = await applyDedup(d, conn);
      console.log(`✓ Dedup ${d.ext_id} (${d.name}): ${r.halved} balances ajustadas`);
    }

    await conn.commit();
    console.log(`\n✓ COMMITTED. Total: ${SPLITS.length} splits, ${DEDUP.length} dedups, ${totalMoved} items re-atribuídos.`);
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
