/**
 * MAAP-Sync — sincroniza delivery_balances no MySQL com os ficheiros
 * oficiais MAAP. Pode correr em modo:
 *
 *   diagnose()  → não escreve nada, devolve plano de mudanças
 *   apply()     → aplica mudanças em transacção (NÃO IMPLEMENTADO AINDA)
 *
 * Decisões implementadas (confirmadas pelo user):
 *   - Duplicados de ID: usam coluna `alias_for` (Opção B)
 *     Os 5 aliases conhecidos:
 *       0104-0006 → 0104-0005 (Jorge Pascoal/Mario Pascoal)
 *       0106-0013 → 0106-0012 (Vania Macula/Dulce Macula)
 *       0109-0007 → 0109-0006 (Nunucha Nhanombe/Florentino)
 *       0114-0008 → 0114-0007 (Miranda Nhantumbo/Damião Nhatumbo)
 *       0609-0004 → 0609-0011 (Honória Eugénia Perua)
 *
 *   - MAAP-PEND-* (rows MAAP sem ID): criados como beneficiários reais,
 *     com nota "Pending official ID assignment".
 *
 *   - Saldo "negativo virtual" (committed > MAAP plan): plan = 0,
 *     committed mantém. Sinaliza no relatório.
 *
 * NUNCA toca em committed_qty, delivered_qty, delivery_services ou items.
 */

const { loadMAAP, KIT_RECIPE } = require("./parse-maap");
const { query, getPool } = require("../db/mysql");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");

// Mapa Referencia (Excel) → SKU canónico (sistema)
// Espelha a lógica de canonSku() em distribution-bootstrap mas mais simples.
const REF_TO_SKU = {
  "Milho":         "MXIXMILHOKG",
  "Feijão":        "MXIXFEIJAOKG",
  "Arroz":         "MXIXARROZKG",
  "Emamectin":     "AGRIFEMMA01L",
  "Imadocloprid":  "AGRIMIDACLORP1L",
  "MCPA":          "AGRIMHMCPA1L",
};

/**
 * Carrega o Excel "Planeamento Pós Realocação" e devolve mapa
 *   (ext_id, sku) → { nqae, realocado, qtd_pos }
 * Útil para preservar realocado_recebido ao sync com MAAP — evitar
 * perder essa info nos benefs que serão re-criados.
 */
function loadExcelRealocacoes() {
  const fp = path.join(__dirname, "..", "data", "Planeamento_Actualizado.xlsx");
  if (!fs.existsSync(fp)) return new Map();
  const wb = XLSX.readFile(fp);
  const ws = wb.Sheets["Planeamento Pós Realocação"];
  if (!ws) return new Map();
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const map = new Map();
  for (const r of rows) {
    const ref = String(r["Referencia"] || "").trim();
    const sku = REF_TO_SKU[ref];
    if (!sku) continue;
    const extId = String(r["Extensionist_ID"] || "").trim();
    if (!extId) continue;
    const nqae = Number(r["NOVA QUANTIDADE A ENTREGAR"]) || 0;
    const realoc = Number(r["Realocado Recebido"]) || 0;
    const qtdPos = Number(r["Qtd Pós Realocação"]) || 0;
    if (nqae <= 0 && realoc <= 0) continue;
    const key = `${extId}|${sku}`;
    // Múltiplas rows por (ext_id, sku) — somar todos
    const existing = map.get(key) || { nqae: 0, realocado: 0, qtd_pos: 0 };
    existing.nqae += nqae;
    existing.realocado += realoc;
    existing.qtd_pos += qtdPos;
    map.set(key, existing);
  }
  return map;
}

// SKU-canónicos do sistema → label do KIT_RECIPE.
// O sistema usa SKUs canónicos (MXIXMILHOKG etc.); MAAP recipe usa labels
// portugueses (Milho, Feijão Vulgar). Este mapa faz a ponte.
const SKU_TO_RECIPE = {
  MXIXMILHOKG:    { label: "Milho",              unit: "kg" },
  MXIXFEIJAOKG:   { label: "Feijão Vulgar",      unit: "kg" },
  MXIXARROZKG:    { label: "Arroz",              unit: "kg" },
  AGRIFEMMA01L:   { label: "Emamectim Benzoato", unit: "L"  },
  AGRIMHMCPA1L:   { label: "MCPA",               unit: "L"  },
  AGRIMIDACLORP1L:{ label: "Imidacloprid",       unit: "L"  },
};

// Aliases conhecidos (descobertos durante análise: nomes parecidos com IDs
// sequenciais). Old ID → new ID (canónico do MAAP).
const KNOWN_ALIASES = {
  "0104-0006": "0104-0005", // Jorge Pascoal → Jorge Mario Pascoal
  "0106-0013": "0106-0012", // Vania Macula → Vania Dulce Macula
  "0109-0007": "0109-0006", // Nunucha Nhanombe → Nunucha Florentino
  "0114-0008": "0114-0007", // Miranda Nhantumbo → Miranda Damião Nhatumbo
  "0609-0004": "0609-0011", // Honória Eugénia Perua (mesmo nome, IDs sequenciais)
};

/**
 * Calcula plano de mudanças sem escrever nada.
 * Retorna estatísticas + listas detalhadas para revisão.
 */
async function diagnose() {
  const maap = loadMAAP();
  const productionAliases = new Map(Object.entries(KNOWN_ALIASES));

  // 1. Estado actual: todos os benefs do MySQL + saldos
  const dbBenefs = await query(
    `SELECT extensionist_id, name, province, district, posto, localidade,
            contact, supervisor_name, supervisor_phone, alias_for
     FROM beneficiaries`
  );
  const dbInfo = new Map(dbBenefs.map((b) => [b.extensionist_id, b]));

  const dbBalances = await query(
    `SELECT extensionist_id, sku, product_name, unit, planned_qty,
            planned_original, realocado_recebido, committed_qty, delivered_qty
     FROM delivery_balances`
  );
  const balanceMap = new Map();
  for (const r of dbBalances) {
    balanceMap.set(`${r.extensionist_id}|${r.sku}`, r);
  }

  // 2. Plano novo: para cada extensionist do MAAP, gerar (sku → qty)
  const targetBalances = new Map(); // "ext_id|sku" → { qty, unit, label }
  for (const [extId, maapEnt] of maap.extensionists) {
    for (const [sku, info] of Object.entries(SKU_TO_RECIPE)) {
      const recipe = KIT_RECIPE[info.label];
      const qty = maapEnt.kit1 * recipe.kit1 + maapEnt.kit2 * recipe.kit2;
      if (qty > 0) {
        targetBalances.set(`${extId}|${sku}`, {
          qty, unit: info.unit, label: info.label,
          ext_id: extId, sku, ext_info: maapEnt,
        });
      }
    }
  }

  // 3. Análise de mudanças
  //
  // LÓGICA CORRECTA (corrigida):
  //   - MAAP × recipe = `planned_original` (NQAE oficial total)
  //   - `realocado_recebido` MANTÉM-SE (realocações já aplicadas em campo)
  //   - `planned_qty` = planned_original − realocado_recebido (recomputar)
  //
  // A diferença visível em planned_qty no fim será só ~156T para Milho
  // (não os 430T anteriormente reportados — esses incluíam realocações
  // já aplicadas, que NÃO devem ser desfeitas).
  const stats = {
    benefs_to_add: [],         // ext_ids no MAAP mas não no DB (excluindo aliases)
    benefs_to_alias: [],       // 5 aliases a marcar
    benefs_to_zero: [],        // ext_ids no DB mas não no MAAP (e não-EXT-, não-aliases)
    balances_to_create: [],    // novas (ext_id, sku) rows
    balances_to_update: [],    // mesmo (ext_id, sku) com qty diferente
    balances_to_zero: [],      // (ext_id, sku) no DB mas não no novo plano
    balances_unchanged: 0,     // contadores
    negative_virtual: [],      // committed > novo planned (atenção)
    totals_per_sku: {},        // sku → { current_orig, new_orig, current_qty, new_qty, realoc, ... }
  };

  // Calcular benefs to add / to alias / to zero
  const maapIds = new Set(maap.extensionists.keys());
  const dbExtIds = new Set(dbBenefs.filter((b) => !b.extensionist_id.startsWith("EXT-")).map((b) => b.extensionist_id));

  for (const id of maapIds) {
    if (dbExtIds.has(id)) continue;
    const m = maap.extensionists.get(id);
    stats.benefs_to_add.push({
      id, name: m.name, prov: m.prov, district: m.district,
      location: m.location, contact: m.contact, supervisor: m.supervisor,
      supervisor_phone: m.supervisor_phone,
      kit1: m.kit1, kit2: m.kit2, is_pending_id: id.startsWith("MAAP-PEND-"),
    });
  }

  for (const [oldId, newId] of productionAliases) {
    if (!dbExtIds.has(oldId)) continue;
    const oldB = dbInfo.get(oldId);
    const newM = maap.extensionists.get(newId);
    stats.benefs_to_alias.push({
      old_id: oldId, new_id: newId,
      old_name: oldB?.name, new_name: newM?.name,
      already_aliased: oldB?.alias_for === newId,
    });
  }

  for (const id of dbExtIds) {
    if (maapIds.has(id)) continue;
    if (productionAliases.has(id)) continue; // será aliased, não removido
    const b = dbInfo.get(id);
    // Saldo total deste benef (qualquer SKU)
    const bals = dbBalances.filter((r) => r.extensionist_id === id);
    const totalCommitted = bals.reduce((s, r) => s + Number(r.committed_qty), 0);
    const totalPlanned = bals.reduce((s, r) => s + Number(r.planned_qty), 0);
    stats.benefs_to_zero.push({
      id, name: b?.name, prov: b?.province, district: b?.district,
      total_planned_old: totalPlanned, total_committed: totalCommitted,
      n_skus: bals.length,
    });
  }

  // Calcular balances: create / update / zero / unchanged + negative_virtual
  //
  // FÓRMULA CORRECTA:
  //   new_planned_original = target.qty (do MAAP × recipe)
  //   realocado            = current.realocado_recebido (preserva)
  //   new_planned_qty      = new_planned_original − realocado
  const seenKeys = new Set();
  for (const [key, target] of targetBalances) {
    seenKeys.add(key);
    const current = balanceMap.get(key);
    if (!current) {
      // Nova row — sem realocado (não havia nada antes)
      stats.balances_to_create.push({
        ext_id: target.ext_id, sku: target.sku, label: target.label,
        unit: target.unit,
        new_planned_original: target.qty,
        realocado_kept: 0,
        new_planned_qty: target.qty,
      });
    } else {
      const oldQty = Number(current.planned_qty);
      const oldOrig = Number(current.planned_original);
      const realoc = Number(current.realocado_recebido);
      const committed = Number(current.committed_qty);
      const newOrig = target.qty;
      const newQty = Math.max(0, newOrig - realoc); // não permite negativo
      if (Math.abs(oldOrig - newOrig) >= 0.01 || Math.abs(oldQty - newQty) >= 0.01) {
        stats.balances_to_update.push({
          ext_id: target.ext_id, sku: target.sku, label: target.label,
          unit: target.unit,
          old_planned_original: oldOrig,
          new_planned_original: newOrig,
          realocado_kept: realoc,
          old_planned_qty: oldQty,
          new_planned_qty: newQty,
          diff_orig: newOrig - oldOrig,
          diff_qty: newQty - oldQty,
          committed,
        });
        if (committed > newQty + 0.01) {
          stats.negative_virtual.push({
            ext_id: target.ext_id, sku: target.sku,
            new_planned: newQty, committed,
            excess: committed - newQty,
            name: dbInfo.get(target.ext_id)?.name || "?",
          });
        }
      } else {
        stats.balances_unchanged++;
      }
    }
  }
  // Balances no DB mas não no plano novo → zero
  for (const [key, current] of balanceMap) {
    if (seenKeys.has(key)) continue;
    if (current.extensionist_id.startsWith("EXT-")) continue;  // não tocar em extras
    // Se é alias, vai ser tratado no aliasing — não zera aqui
    if (productionAliases.has(current.extensionist_id)) continue;
    const recipeInfo = SKU_TO_RECIPE[current.sku];
    if (!recipeInfo) continue;  // só zerar SKUs cobertos pelo MAAP
    const oldQty = Number(current.planned_qty);
    const committed = Number(current.committed_qty);
    if (oldQty <= 0.01) continue;  // já está zero, skip
    stats.balances_to_zero.push({
      ext_id: current.extensionist_id, sku: current.sku,
      qty_old: oldQty, committed,
    });
  }

  // Totais por SKU — current vs new para PLANNED_ORIGINAL e PLANNED_QTY
  for (const sku of Object.keys(SKU_TO_RECIPE)) {
    let currOrig = 0, currQty = 0, currRealoc = 0;
    let newOrig = 0;
    for (const r of dbBalances) {
      if (r.sku === sku) {
        currOrig += Number(r.planned_original);
        currQty += Number(r.planned_qty);
        currRealoc += Number(r.realocado_recebido);
      }
    }
    for (const [, t] of targetBalances) {
      if (t.sku === sku) newOrig += t.qty;
    }
    // O newQty depende do realocado QUE FICAR após sync. Para benefs em ambos:
    // mantém o realocado actual. Para benefs novos (no MAAP): realocado = 0.
    // Para benefs zerados (no DB mas não no MAAP): planned_original e _qty = 0
    // (mas realocado também — porque o ID é "removido" do plano).
    // Aproximação: assumir que realocado total mantém-se ≈ currRealoc.
    const newQty = newOrig - currRealoc;
    stats.totals_per_sku[sku] = {
      label: SKU_TO_RECIPE[sku].label,
      unit: SKU_TO_RECIPE[sku].unit,
      current_original: currOrig,
      new_original: newOrig,
      diff_original: newOrig - currOrig,
      realocado_total: currRealoc,
      current_qty: currQty,
      new_qty: newQty,
      diff_qty: newQty - currQty,
    };
  }

  return {
    maap_loaded: maap.extensionists.size,
    db_benefs: dbExtIds.size,
    db_balances: dbBalances.length,
    target_balances: targetBalances.size,
    ...stats,
  };
}

/**
 * Aplica as mudanças no MySQL com:
 *   1. Backup automático das tabelas afectadas (CREATE TABLE backup_*_<ts>)
 *   2. Transacção atómica — rollback se algo falhar
 *   3. NUNCA toca em committed_qty, delivered_qty, delivery_services, items
 *
 * Devolve { tsStr, stats: {...} }.
 */
async function apply(opts = {}) {
  const onLog = opts.onLog || ((s) => console.log(s));
  const tsStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  // Re-corre diagnose para data fresca
  onLog("[apply] A correr diagnose para apanhar estado actual...");
  const plan = await diagnose();

  // Carrega o Excel "Planeamento Pós Realocação" para apanhar realocações
  // que existem mas não estão no admin (porque o importer skipa rows com
  // Qtd Pós Realocação = 0 — perdendo a info de realocado).
  onLog("[apply] A ler Excel \"Planeamento Pós Realocação\" para preservar realocações...");
  const excelRealoc = loadExcelRealocacoes();
  onLog(`[apply] ${excelRealoc.size} (ext_id, sku) com info de realocação no Excel`);

  // 1. Backups (CREATE TABLE auto-commits, não pode estar em transacção)
  const pool = getPool();
  onLog("[apply] A criar backups das tabelas...");
  const beneBackup = `backup_beneficiaries_${tsStr}`;
  const balBackup = `backup_delivery_balances_${tsStr}`;
  await pool.query(`CREATE TABLE \`${beneBackup}\` AS SELECT * FROM beneficiaries`);
  await pool.query(`CREATE TABLE \`${balBackup}\` AS SELECT * FROM delivery_balances`);
  onLog(`[apply] ✓ Backup criado: ${beneBackup}`);
  onLog(`[apply] ✓ Backup criado: ${balBackup}`);

  // 2. Transacção
  const conn = await pool.getConnection();
  const stats = {
    nBenefAdded: 0, nBenefAliased: 0,
    nBalCreated: 0, nBalUpdated: 0, nBalZeroed: 0,
  };
  try {
    await conn.beginTransaction();

    // 2a. ADICIONAR novos beneficiários
    onLog(`[apply] A adicionar ${plan.benefs_to_add.length} beneficiários novos...`);
    for (const b of plan.benefs_to_add) {
      // Para MAAP-PEND-* ou nomes vazios, usar fallback
      const name = b.name && b.name.trim() ? b.name.trim() : (b.is_pending_id ? `(Pending ID — ${b.id})` : `(sem nome — ${b.id})`);
      await conn.query(
        `INSERT INTO beneficiaries
           (extensionist_id, nuit, name, province, district, posto, localidade,
            contact, supervisor_name, supervisor_phone, imported_at, alias_for)
         VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NOW(), NULL)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           province = VALUES(province),
           district = VALUES(district),
           localidade = VALUES(localidade),
           contact = COALESCE(NULLIF(VALUES(contact), ''), contact),
           supervisor_name = COALESCE(NULLIF(VALUES(supervisor_name), ''), supervisor_name),
           supervisor_phone = COALESCE(NULLIF(VALUES(supervisor_phone), ''), supervisor_phone)`,
        [b.id, name, b.prov || null, b.district || null, b.location || null,
         b.contact || null, b.supervisor || null, b.supervisor_phone || null]
      );
      stats.nBenefAdded++;
    }

    // 2b. MARCAR aliases (Jorge, Vania, Nunucha, Miranda, Honória)
    // Para cada alias: 1) marca alias_for; 2) zera planned dos saldos do
    // ID antigo (o canónico vai receber o plano via 2c/2d). committed_qty
    // mantém-se intacto — preserva histórico de entregas sob o ID antigo.
    onLog(`[apply] A marcar ${plan.benefs_to_alias.length} aliases...`);
    for (const a of plan.benefs_to_alias) {
      await conn.query(
        `UPDATE beneficiaries SET alias_for = ? WHERE extensionist_id = ?`,
        [a.new_id, a.old_id]
      );
      // Zerar saldos do ID antigo (mas só os SKUs cobertos pelo MAAP)
      const skuList = Object.keys(SKU_TO_RECIPE);
      const placeholders = skuList.map(() => "?").join(",");
      await conn.query(
        `UPDATE delivery_balances
         SET planned_original = 0, planned_qty = 0
         WHERE extensionist_id = ? AND sku IN (${placeholders})`,
        [a.old_id, ...skuList]
      );
      stats.nBenefAliased++;
    }

    // 2c. CRIAR novos saldos (delivery_balances)
    // Busca info de TODOS os benefs uma vez para evitar N queries
    onLog(`[apply] A criar ${plan.balances_to_create.length} saldos novos...`);
    const [allBenefs] = await conn.query(`SELECT extensionist_id, name, province, district FROM beneficiaries`);
    const benefMap = new Map(allBenefs.map((b) => [b.extensionist_id, b]));

    for (const c of plan.balances_to_create) {
      const benef = benefMap.get(c.ext_id) || { name: c.ext_id, province: null, district: null };
      // Apanha realocado do Excel "Pós Realocação" se existir.
      // Para benefs novos do MAAP (que tinham row no Excel com Qtd Pós Realocação=0
      // e foram skipados pelo importer original), isto traz de volta a info.
      const excelInfo = excelRealoc.get(`${c.ext_id}|${c.sku}`);
      const realocado = excelInfo ? excelInfo.realocado : 0;
      const newQty = Math.max(0, c.new_planned_original - realocado);
      await conn.query(
        `INSERT INTO delivery_balances
           (extensionist_id, sku, product_name, unit, province, district,
            beneficiary_name, planned_original, realocado_recebido, planned_qty,
            committed_qty, delivered_qty, bean_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL)
         ON DUPLICATE KEY UPDATE
           planned_original = VALUES(planned_original),
           realocado_recebido = VALUES(realocado_recebido),
           planned_qty = GREATEST(0, VALUES(planned_original) - VALUES(realocado_recebido))`,
        [c.ext_id, c.sku, c.label, c.unit,
         benef.province, benef.district, benef.name || c.ext_id,
         c.new_planned_original, realocado, newQty]
      );
      stats.nBalCreated++;
    }

    // 2d. ACTUALIZAR saldos existentes (planned_original, realocado, planned_qty)
    // Para benefs em ambos: o Excel "Pós Realocação" é a fonte de verdade para
    // realocado_recebido. Se o admin tinha realocado=0 mas Excel tem >0 (porque
    // o importer original skipou rows com QtdPos=0 — perdendo a info), agora
    // recuperamos. Para outros: Excel reflecte o estado actual oficial, idem.
    onLog(`[apply] A actualizar ${plan.balances_to_update.length} saldos...`);
    for (const u of plan.balances_to_update) {
      const excelInfo = excelRealoc.get(`${u.ext_id}|${u.sku}`);
      const realocado = excelInfo ? excelInfo.realocado : 0;
      const newQty = Math.max(0, u.new_planned_original - realocado);
      await conn.query(
        `UPDATE delivery_balances
         SET planned_original = ?,
             realocado_recebido = ?,
             planned_qty = ?
         WHERE extensionist_id = ? AND sku = ?`,
        [u.new_planned_original, realocado, newQty, u.ext_id, u.sku]
      );
      stats.nBalUpdated++;
    }

    // 2d.bis. SWEEP — para todos os outros (ext_id, sku) com row no admin que
    // estavam "unchanged" pelo planned_original mas podem ter realocado errado:
    // sincroniza com Excel também. Cobre casos onde:
    //   - admin já tinha planned_original = MAAP, mas realocado divergia
    //   - benefs antigos com realocado capturado parcialmente
    onLog(`[apply] A sincronizar realocado_recebido para todos os benefs com Excel...`);
    let nRealocSync = 0;
    for (const [key, info] of excelRealoc) {
      const [extId, sku] = key.split("|");
      // Pular se já tratado em update/create acima
      if (plan.balances_to_update.find((u) => u.ext_id === extId && u.sku === sku)) continue;
      if (plan.balances_to_create.find((c) => c.ext_id === extId && c.sku === sku)) continue;
      // Pular aliases (são tratados em 2b)
      if (Object.prototype.hasOwnProperty.call(KNOWN_ALIASES, extId)) continue;

      const [existing] = await conn.query(
        `SELECT planned_original, realocado_recebido FROM delivery_balances WHERE extensionist_id = ? AND sku = ?`,
        [extId, sku]
      );
      if (!existing.length) continue;
      const cur = existing[0];
      const curRealoc = Number(cur.realocado_recebido);
      const excelRealocVal = info.realocado;
      if (Math.abs(curRealoc - excelRealocVal) < 0.01) continue;
      const newQty = Math.max(0, Number(cur.planned_original) - excelRealocVal);
      await conn.query(
        `UPDATE delivery_balances
         SET realocado_recebido = ?, planned_qty = ?
         WHERE extensionist_id = ? AND sku = ?`,
        [excelRealocVal, newQty, extId, sku]
      );
      nRealocSync++;
    }
    onLog(`[apply] Realocado sincronizado para ${nRealocSync} rows extra`);
    stats.nRealocSynced = nRealocSync;

    // 2e. ZERAR saldos órfãos (ext_id no DB mas não no MAAP, e não-aliases)
    onLog(`[apply] A zerar ${plan.balances_to_zero.length} saldos órfãos...`);
    for (const z of plan.balances_to_zero) {
      await conn.query(
        `UPDATE delivery_balances
         SET planned_original = 0, planned_qty = 0
         WHERE extensionist_id = ? AND sku = ?`,
        [z.ext_id, z.sku]
      );
      stats.nBalZeroed++;
    }

    // 2f. AUDIT LOG
    await conn.query(
      `INSERT INTO audit_log
         (user_id, action, entity_type, entity_id, details, ip, created_at)
       VALUES (NULL, 'maap_sync_apply', 'system', NULL, ?, 'CLI', NOW())`,
      [JSON.stringify({ tsStr, ...stats, backup: { beneBackup, balBackup } })]
    );

    await conn.commit();
    onLog(`[apply] ✓ Transacção commitada com sucesso`);

    return {
      ok: true,
      tsStr,
      backup: { beneBackup, balBackup },
      stats,
    };
  } catch (err) {
    onLog(`[apply] ⚠️  ERRO — a fazer rollback...`);
    try { await conn.rollback(); } catch (_) {}
    onLog(`[apply] Rollback OK. Backups ainda existem: ${beneBackup}, ${balBackup}`);
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Reverte uma aplicação anterior — restaura backup_<table>_<tsStr>.
 * Útil se descobrirmos que a aplicação correu mas algo está mal.
 */
async function rollbackToBackup(tsStr) {
  const beneBackup = `backup_beneficiaries_${tsStr}`;
  const balBackup = `backup_delivery_balances_${tsStr}`;
  const pool = getPool();
  // Validar que os backups existem
  const [b1] = await pool.query(`SHOW TABLES LIKE ?`, [beneBackup]);
  const [b2] = await pool.query(`SHOW TABLES LIKE ?`, [balBackup]);
  if (!b1.length) throw new Error(`Backup ${beneBackup} não existe`);
  if (!b2.length) throw new Error(`Backup ${balBackup} não existe`);

  const conn = await pool.getConnection();
  try {
    // Desactivar FKs temporariamente para permitir DELETE+INSERT
    // (delivery_service_items tem FK para delivery_balances).
    await conn.query(`SET FOREIGN_KEY_CHECKS = 0`);
    await conn.beginTransaction();
    // Restaurar — DELETE + INSERT (preserva FKs depois)
    await conn.query(`DELETE FROM delivery_balances`);
    await conn.query(`INSERT INTO delivery_balances SELECT * FROM \`${balBackup}\``);
    await conn.query(`DELETE FROM beneficiaries`);
    await conn.query(`INSERT INTO beneficiaries SELECT * FROM \`${beneBackup}\``);
    await conn.commit();
    await conn.query(`SET FOREIGN_KEY_CHECKS = 1`);
    return { ok: true, restored: { beneBackup, balBackup } };
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    try { await conn.query(`SET FOREIGN_KEY_CHECKS = 1`); } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { diagnose, apply, rollbackToBackup, KNOWN_ALIASES, SKU_TO_RECIPE };
