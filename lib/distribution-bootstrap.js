/**
 * Distribution bootstrap — importa o estado inicial a partir de 2 ficheiros Excel:
 *
 *   1) Planeamento (Planeamento_Actualizado_*.xlsx, sheet "Planeamento Adicional")
 *      → popula `beneficiaries` + `delivery_balances`
 *      → planned_qty = SUM(NOVA QUANTIDADE A ENTREGAR) por (extensionist_id, sku)
 *
 *   2) Histórico de serviços (servicos_*.xlsx, sheet "Sheet 1")
 *      → cria `delivery_services` agrupados por (matricula, district)
 *        e `delivery_service_items` (1 por linha do Excel = 1 ADSN)
 *      → estado: TRANSITO → 'in_transit', FINALIZADO → 'delivered', CRIADO → 'draft'
 *      → committed_qty/delivered_qty actualizados em delivery_balances
 *
 * Idempotente: re-executar não duplica. Linhas com `external_adsn` já existente
 * são saltadas. UPSERT no planeamento ajusta planned_qty se mudou.
 */
const XLSX = require("xlsx");
const path = require("path");
const { getPool } = require("../db/mysql");

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// Sacos herméticos: 1 unidade = 0.3 kg. No Excel de serviços, a coluna `Peso`
// para SUSSACO contém a CONTAGEM (ex: 7600 = 7600 sacos), não kg.
// Importamos qty=count, unit='un'. Para o peso real do camião, multiplicamos
// por 0.3 só quando totalizamos. Sementes (kg) e químicos (L) ficam como estão.
const SACO_KG_PER_UNIT = 0.3;
function qtyToKg(qty, unit) {
  const n = Number(qty) || 0;
  if (unit === "un") return n * SACO_KG_PER_UNIT;
  return n;
}

// SKU → display name + unit. Os "MSMD..."/"MJKLI..." opacos passam com SKU como nome.
const SKU_META = {
  MXIXMILHOKG:        { name: "Milho",           unit: "kg" },
  MXIXFEIJAOKG:       { name: "Feijão",          unit: "kg" },
  MXIXARROZKG:        { name: "Arroz",           unit: "kg" },
  AGRIFEMTINL:        { name: "Emamectin",       unit: "L"  },
  AGRIFEMMA01L:       { name: "Emamectin",       unit: "L"  },
  AGRIFEMMA0125L:     { name: "Emamectin",       unit: "L"  },
  AGRIMIDACLORIPLT:   { name: "Imidacloprid",    unit: "L"  },
  AGRIMHMCPALT:       { name: "MCPA",            unit: "L"  },
  SUSSACO:            { name: "Sacos Hermeticos",unit: "un" },
  SEEDARROZM50KG:     { name: "Arroz (saco 50kg)", unit: "kg" },
  MSEEDFJNHB5KG:      { name: "Feijão Nhemba",   unit: "kg" },
  MSEEDOPVZM523:      { name: "Milho variedade", unit: "kg" },
  MMRMINTER25:        { name: "Marmite",         unit: "kg" },
};
function skuMeta(sku) {
  const code = String(sku || "").trim();
  if (!code) return { name: "—", unit: "kg" };
  if (SKU_META[code]) return SKU_META[code];
  return { name: code, unit: "kg" }; // fallback: nome = SKU, assume kg
}

// Mapeamento Artigo PT (nome amigável usado no ficheiro de validação
// "planeamento_por_cumprir") → SKU canónico (sempre os do planeamento).
const ARTIGO_TO_SKU = {
  "Feijão":           "MXIXFEIJAOKG",
  "Feijao":           "MXIXFEIJAOKG",
  "Milho":            "MXIXMILHOKG",
  "Arroz":            "MXIXARROZKG",
  "Sacos Herméticos": "SUSSACO",
  "Sacos Hermeticos": "SUSSACO",
  "Saco Hermético":   "SUSSACO",
  "Emamectin":        "AGRIFEMMA01L",
  "Imidacloprid":     "AGRIMIDACLORP1L",
  "Imadocloprid":     "AGRIMIDACLORP1L",
  "MCPA":             "AGRIMHMCPA1L",
};

// Canonicalização de SKUs entre o planeamento e o ficheiro de serviços.
// O sistema externo usa códigos diferentes para o mesmo produto. Mapeamos
// SEMPRE para os do planeamento (são os "oficiais" para nós).
//
// IMPORTANTE: este projecto é APENAS séries GTU98 e GTS98.
// Os SKUs MSEEDOPVZM523, MSEEDFJNHB5KG, MJKLIAOHG09, MSERTU09I, MSMDACAJU,
// MASSD12, MSSLMC119, MSSAM119, MADSE56, MSSDFAR78, MSSDRAT09, MSDALICH23
// e MSMDAMANG23 são EXCLUSIVOS da série GTU99 (outro projecto) — NÃO
// pertencem ao plano e são filtrados pelo guard /^GT[US]98\// em
// importServices. Não os mapeamos aqui propositadamente.
const SKU_CANON = {
  // Sementes core (já canónicas no planeamento)
  MXIXFEIJAOKG: "MXIXFEIJAOKG",
  MXIXMILHOKG:  "MXIXMILHOKG",
  MXIXARROZKG:  "MXIXARROZKG",
  SUSSACO:      "SUSSACO",
  // Químicos — canónicos do planeamento
  AGRIFEMMA01L:    "AGRIFEMMA01L",
  AGRIMIDACLORP1L: "AGRIMIDACLORP1L",
  AGRIMHMCPA1L:    "AGRIMHMCPA1L",
  // Variantes (alias) do ficheiro de serviços → canónico do planeamento
  AGRIFEMTINL:      "AGRIFEMMA01L",
  AGRIFEMMA0125L:   "AGRIFEMMA01L",
  AGRIMIDACLORIPLT: "AGRIMIDACLORP1L",
  AGRIMHMCPALT:     "AGRIMHMCPA1L",
  SEEDARROZM50KG:   "MXIXARROZKG",  // saco 50kg de arroz, mesmo produto base
};
function canonSku(sku) {
  const code = String(sku || "").trim();
  if (!code) return null;
  return SKU_CANON[code] || code; // se não conhecemos, mantém — aparecerá como SKU à parte
}

// Display metadata para os SKUs canónicos do planeamento
const PLANNING_SKU_META = {
  MXIXFEIJAOKG:    { name: "Feijão",       unit: "kg" },
  MXIXMILHOKG:     { name: "Milho",        unit: "kg" },
  MXIXARROZKG:     { name: "Arroz",        unit: "kg" },
  SUSSACO:         { name: "Sacos Hermeticos", unit: "un" },
  AGRIFEMMA01L:    { name: "Emamectin",    unit: "L"  },
  AGRIMIDACLORP1L: { name: "Imidacloprid", unit: "L"  },
  AGRIMHMCPA1L:    { name: "MCPA",         unit: "L"  },
};
function planSkuMeta(sku) {
  if (PLANNING_SKU_META[sku]) return PLANNING_SKU_META[sku];
  return skuMeta(sku); // fallback
}
function artigoToSku(artigo) {
  if (!artigo) return null;
  const k = String(artigo).trim();
  if (ARTIGO_TO_SKU[k]) return ARTIGO_TO_SKU[k];
  // Tenta normalizar acentos
  const norm = k.normalize("NFD").replace(/[̀-ͯ]/g, "");
  for (const [key, val] of Object.entries(ARTIGO_TO_SKU)) {
    if (key.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() === norm.toLowerCase()) {
      return val;
    }
  }
  return null;
}

// Normaliza nome de distrito (consistente com app.js)
function normalizeDistrict(d) {
  if (!d) return "";
  const s = String(d).trim();
  if (!s) return "";
  // Title case simples (preserva acentos)
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Matrícula do tipo "AAB 450 MP//" ou "AAV 077 MC/AB672MC/" → { primary, secondary }
function normalizePlate(raw) {
  if (!raw) return { primary: null, secondary: null };
  const cleaned = String(raw).trim().toUpperCase().replace(/\s+/g, " ");
  // Split por / removendo entradas vazias
  const parts = cleaned.split(/\/+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { primary: null, secondary: null };
  return {
    primary: parts[0] || null,
    secondary: parts[1] || null,
  };
}

// Group key for an imported row → 1 service per (matricula primary + district + status)
// CRIADO sem matricula → cada linha vira o seu próprio "serviço" (key único pelo ADSN)
function serviceGroupKey(row) {
  const plate = normalizePlate(row.Matricula).primary;
  const district = normalizeDistrict(row.Distrito);
  const state = mapState(row.Estado);
  if (!plate) return `solo:${row.Serviço || row.Servico || ""}`;
  return `truck:${plate}|${district}|${state}`;
}

function mapState(estado) {
  const s = String(estado || "").trim().toUpperCase();
  if (s === "FINALIZADO") return "delivered";
  if (s === "TRANSITO" || s === "TRÂNSITO") return "in_transit";
  return "draft"; // CRIADO + qualquer outro
}

// ── Planning import ─────────────────────────────────────────
// Usa a sheet "Planeamento Pós Realocação" e a coluna "Qtd Pós Realocação"
// como `planned_qty`. Esta coluna já tem a Realocado Recebido subtraída
// (NQAE − Realocado Recebido). Saldo final = planned − (servicos TRANS+FIN).
async function importPlanning(filePath, opts = {}) {
  const dryRun = !!opts.dryRun;
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets["Planeamento Pós Realocação"] || wb.Sheets["Planeamento Adicional"];
  if (!sheet) throw new Error("Sheet 'Planeamento Pós Realocação' (ou 'Planeamento Adicional') não encontrada em " + filePath);
  const rows = XLSX.utils.sheet_to_json(sheet);

  // Aggregate per (extensionist_id, sku)
  const benefMap = new Map(); // ext_id → benef record
  const balanceMap = new Map(); // `${ext_id}|${sku}` → balance record

  // Prefer "Qtd Pós Realocação" (post-reallocation plan); fallback to NQAE
  // for sheets that don't have the post-reallocation column.
  function plannedFor(r) {
    if (r["Qtd Pós Realocação"] != null) return Number(r["Qtd Pós Realocação"]) || 0;
    return Number(r["NOVA QUANTIDADE A ENTREGAR"]) || 0;
  }

  let skipped = 0;
  for (const r of rows) {
    const extId = String(r["Extensionist_ID"] || "").trim();
    const sku = String(r["Artigo"] || "").trim();
    const qty = plannedFor(r);
    if (!extId || !sku || qty <= 0) { skipped++; continue; }

    if (!benefMap.has(extId)) {
      benefMap.set(extId, {
        extensionist_id: extId,
        nuit: String(r["Cod Destino ( NUIT)"] || r["Cod Destino (NUIT)"] || "").trim() || null,
        name: String(r["Nome Destino"] || "").trim(),
        province: String(r["Morada Destino (Provincia)"] || "").trim() || null,
        district: normalizeDistrict(r["Distrito"]) || null,
        posto: String(r["Posto Administrativo"] || "").trim() || null,
        contact: String(r["Num Contacto Destino (Contacto do extensionista)"] || "").trim() || null,
        supervisor_name: String(r["Nome do Supervisor"] || "").trim() || null,
        supervisor_phone: String(r["Contacto do Supervisor"] || "").trim() || null,
      });
    }

    // Canonicaliza o SKU (assegura mesmo SKU usado pelo serviço posterior)
    const cSku = canonSku(sku);
    const k = `${extId}|${cSku}`;
    const meta = planSkuMeta(cSku);
    if (!balanceMap.has(k)) {
      const b = benefMap.get(extId);
      balanceMap.set(k, {
        extensionist_id: extId,
        sku: cSku,
        product_name: meta.name,
        unit: meta.unit,
        province: b.province,
        district: b.district,
        beneficiary_name: b.name,
        planned_original: 0,
        realocado_recebido: 0,
        planned_qty: 0,
      });
    }
    const bal = balanceMap.get(k);
    bal.planned_original   += Number(r["NOVA QUANTIDADE A ENTREGAR"]) || 0;
    bal.realocado_recebido += Number(r["Realocado Recebido"])         || 0;
    bal.planned_qty        += qty; // = Qtd Pós Realocação (ou NQAE se a coluna não existir)
  }

  if (dryRun) {
    return { source_rows: rows.length, beneficiaries: benefMap.size, balances: balanceMap.size, skipped };
  }

  const ts = now();
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    // Upsert beneficiaries
    const benefList = [...benefMap.values()];
    for (let i = 0; i < benefList.length; i += 200) {
      const chunk = benefList.slice(i, i + 200);
      const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
      const params = [];
      chunk.forEach((b) => params.push(
        b.extensionist_id, b.nuit, b.name, b.province, b.district,
        b.posto, b.contact, b.supervisor_name, b.supervisor_phone, ts
      ));
      await conn.query(
        `INSERT INTO beneficiaries
         (extensionist_id, nuit, name, province, district, posto, contact,
          supervisor_name, supervisor_phone, imported_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           nuit=VALUES(nuit), name=VALUES(name), province=VALUES(province),
           district=VALUES(district), posto=VALUES(posto), contact=VALUES(contact),
           supervisor_name=VALUES(supervisor_name), supervisor_phone=VALUES(supervisor_phone)`,
        params
      );
    }

    // Upsert balances — careful: planned_qty refresh, but DON'T touch committed/delivered
    const balList = [...balanceMap.values()];
    for (let i = 0; i < balList.length; i += 200) {
      const chunk = balList.slice(i, i + 200);
      const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,0,0)").join(",");
      const params = [];
      chunk.forEach((b) => params.push(
        b.extensionist_id, b.sku, b.product_name, b.unit,
        b.province, b.district, b.beneficiary_name,
        b.planned_original, b.realocado_recebido, b.planned_qty
      ));
      await conn.query(
        `INSERT INTO delivery_balances
         (extensionist_id, sku, product_name, unit, province, district,
          beneficiary_name, planned_original, realocado_recebido, planned_qty,
          committed_qty, delivered_qty)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           product_name=VALUES(product_name), unit=VALUES(unit),
           province=VALUES(province), district=VALUES(district),
           beneficiary_name=VALUES(beneficiary_name),
           planned_original=VALUES(planned_original),
           realocado_recebido=VALUES(realocado_recebido),
           planned_qty=VALUES(planned_qty)`,
        params
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  return {
    source_rows: rows.length,
    beneficiaries: benefMap.size,
    balances: balanceMap.size,
    skipped,
  };
}

// ── Services import (histórico) ─────────────────────────────
async function importServices(filePath, opts = {}) {
  const dryRun = !!opts.dryRun;
  const fileName = path.basename(filePath);
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]]; // "Sheet 1" no ficheiro fornecido
  if (!sheet) throw new Error("Folha não encontrada em " + filePath);
  const rows = XLSX.utils.sheet_to_json(sheet);

  // 1. Resolve extensionist_id by NUIT
  const conn = await getPool().getConnection();
  let nuitToExt;
  try {
    const [benefRows] = await conn.query("SELECT extensionist_id, nuit FROM beneficiaries WHERE nuit IS NOT NULL");
    nuitToExt = new Map(benefRows.map((b) => [String(b.nuit).trim(), b.extensionist_id]));
  } finally {
    conn.release();
  }

  // 2. Group rows by service group key
  const groups = new Map(); // key → { state, plate1, plate2, district, province, supplier, rows: [] }
  const extraBenefs = new Map(); // ext_id → benef record (auto-criados)
  let skipped_no_qty = 0;
  let skipped_invalid = 0;

  // Filtro: por instrução do operador, só TRANSITO e FINALIZADO contam como
  // entregue/comprometido. CRIADO ainda não saiu (irrelevante para saldo);
  // DESCARTADO/CANCELADO ignoram-se (eventos cancelados no sistema externo).
  // Adicionalmente: só séries GTU98 e GTS98 (GTU99 é uma série paralela de
  // kits que NÃO faz parte do plano principal — bate com a coluna do
  // ficheiro de validação "Entregue/Trânsito (GTU/GTS98)").
  const RELEVANT_STATES = new Set(["TRANSITO", "FINALIZADO", "TRÂNSITO"]);
  const GTU_RE = /^GT[US]98\//;
  let skipped_gtu99 = 0;
  let auto_created_benefs = 0;

  for (const r of rows) {
    const adsn = String(r["Serviço"] || r["Servico"] || "").trim();
    const nuit = String(r["Entidade"] || "").trim();
    const skuRaw = String(r["SKU"] || "").trim();
    const sku = canonSku(skuRaw); // ← canonicaliza para o SKU do planeamento
    const peso = Number(r["Peso"]) || 0;
    const estado = String(r.Estado || "").trim().toUpperCase();
    const trabalho = String(r["Trabalho"] || "").trim();
    if (!adsn || !nuit || !sku || peso <= 0) { skipped_invalid++; continue; }
    if (!RELEVANT_STATES.has(estado)) continue; // saltar CRIADO/DESCARTADO
    if (trabalho && !GTU_RE.test(trabalho)) {     // saltar GTU99 (e outras séries não-base)
      skipped_gtu99++;
      continue;
    }
    let extId = nuitToExt.get(nuit);
    if (!extId) {
      // Beneficiário não está no planeamento mas recebeu deliveries reais
      // (TRANSITO/FINALIZADO em GTU98/GTS98). Auto-cria como "extra" — usa
      // o NUIT como extensionist_id sintético com prefixo "EXT-" para
      // distinguir dos do planeamento. Ficam com planned_qty=0 (não estão
      // no plano oficial) mas recebem committed_qty pelas entregas reais.
      // Aparecem em /admin/servicos e /admin/camioes mas NÃO em
      // /admin/distribuicao (filtra por planned_qty > 0).
      extId = "EXT-" + nuit;
      if (!extraBenefs.has(extId)) {
        extraBenefs.set(extId, {
          extensionist_id: extId,
          nuit,
          name: String(r.Destinatario || "").trim() || ("NUIT " + nuit),
          province: String(r.Provincia || "").trim() || null,
          district: normalizeDistrict(r.Distrito) || null,
          posto: null,
          contact: null,
          supervisor_name: null,
          supervisor_phone: null,
        });
        auto_created_benefs++;
      }
      nuitToExt.set(nuit, extId);
    }

    const key = serviceGroupKey(r);
    if (!groups.has(key)) {
      const plate = normalizePlate(r.Matricula);
      groups.set(key, {
        key,
        state: mapState(r.Estado),
        plate1: plate.primary,
        plate2: plate.secondary,
        district: normalizeDistrict(r.Distrito),
        province: String(r.Provincia || "").trim(),
        supplier: String(r.Origem || "").trim() || null,
        created_at_excel: null,    // min Data Criação dos items deste grupo
        items: [],
      });
    }
    // "Data Criação" é a data de criação do serviço no sistema externo.
    // Em formato ISO string (ex "2026-03-31T16:07:47.4"). Pode estar
    // ausente em alguns rows — nesses casos cai-se em now() na inserção.
    const dataCriacaoRaw = r["Data Criação"] || r["Data Criacao"];
    const itemDate = dataCriacaoRaw ? new Date(dataCriacaoRaw) : null;
    if (itemDate && !isNaN(itemDate.getTime())) {
      const g = groups.get(key);
      if (!g.created_at_excel || itemDate < g.created_at_excel) {
        g.created_at_excel = itemDate;
      }
    }
    const meta = planSkuMeta(sku);
    groups.get(key).items.push({
      external_adsn: adsn,
      external_gtu: String(r["Trabalho"] || "").trim() || null,
      extensionist_id: extId,
      sku, // já canónico
      sku_raw: skuRaw,
      qty: peso,
      beneficiary_name: String(r["Destinatario"] || "").trim(),
      product_name: meta.name,
      unit: meta.unit,
      province: String(r.Provincia || "").trim(),
      district: normalizeDistrict(r.Distrito),
    });
  }

  // Helper: converte Date JS para o formato MySQL DATETIME usando a HORA
  // LOCAL do sistema (Maputo UTC+2). Não usar toISOString() — isso converte
  // para UTC e quando o servidor faz round-trip via fmtDate, perdem-se 2h.
  function toMySQLDate(d) {
    if (!d || isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  if (dryRun) {
    const counts = { draft: 0, in_transit: 0, delivered: 0 };
    let itemsTotal = 0;
    groups.forEach((g) => { counts[g.state]++; itemsTotal += g.items.length; });
    return {
      source_rows: rows.length,
      services_to_create: groups.size,
      items_to_create: itemsTotal,
      by_state: counts,
      auto_created_benefs,
      sample_extra_benefs: [...extraBenefs.values()].slice(0, 5),
      skipped_no_qty,
      skipped_invalid,
      skipped_gtu99,
    };
  }

  // 3. Insert services + items in a single transaction per group (idempotent via UNIQUE on external_adsn)
  const ts = now();
  let createdServices = 0;
  let createdItems = 0;
  let skippedDuplicate = 0;

  const conn2 = await getPool().getConnection();
  try {
    // Inserir os beneficiários extras (auto-criados a partir do servicos.xlsx)
    // ANTES de tudo o resto. Ficam com extensionist_id "EXT-{NUIT}" para se
    // distinguirem dos do planeamento. As suas balance rows são criadas no
    // pre-create por grupo, com planned_qty=0.
    if (extraBenefs.size > 0) {
      const list = [...extraBenefs.values()];
      const ph = list.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
      const params = [];
      list.forEach((b) => params.push(
        b.extensionist_id, b.nuit, b.name, b.province, b.district,
        b.posto, b.contact, b.supervisor_name, b.supervisor_phone, ts
      ));
      await conn2.query(
        `INSERT INTO beneficiaries
         (extensionist_id, nuit, name, province, district, posto, contact,
          supervisor_name, supervisor_phone, imported_at)
         VALUES ${ph}
         ON DUPLICATE KEY UPDATE
           name=VALUES(name), province=VALUES(province), district=VALUES(district)`,
        params
      );
    }

    for (const g of groups.values()) {
      // Skip if any item already imported (UNIQUE on external_adsn would error otherwise).
      // We do a quick check: if all items have an existing match, skip the whole group.
      const adsnList = g.items.map((it) => it.external_adsn);
      const placeholders = adsnList.map(() => "?").join(",");
      const [existing] = await conn2.query(
        `SELECT external_adsn FROM delivery_service_items WHERE external_adsn IN (${placeholders})`,
        adsnList
      );
      const existingSet = new Set(existing.map((e) => e.external_adsn));
      const newItems = g.items.filter((it) => !existingSet.has(it.external_adsn));
      if (!newItems.length) { skippedDuplicate += g.items.length; continue; }

      // Begin transaction for this group
      await conn2.beginTransaction();
      try {
        // Pre-create any missing balance rows (planned_qty=0) so the FK from
        // delivery_service_items resolves. These represent "entregue mas
        // fora do plano" — útil para reconciliação posterior.
        const balKeys = newItems.map((it) => [it.extensionist_id, it.sku]);
        if (balKeys.length) {
          const ph = balKeys.map(() => "(?,?)").join(",");
          const flat = balKeys.flat();
          const [existingBal] = await conn2.query(
            `SELECT extensionist_id, sku FROM delivery_balances
             WHERE (extensionist_id, sku) IN (${ph})`,
            flat
          );
          const existingBalSet = new Set(existingBal.map((b) => `${b.extensionist_id}|${b.sku}`));
          const missing = newItems.filter((it) =>
            !existingBalSet.has(`${it.extensionist_id}|${it.sku}`)
          );
          // Dedup by (ext_id, sku)
          const missingMap = new Map();
          missing.forEach((it) => {
            const k = `${it.extensionist_id}|${it.sku}`;
            if (!missingMap.has(k)) missingMap.set(k, it);
          });
          for (const it of missingMap.values()) {
            await conn2.query(
              `INSERT INTO delivery_balances
               (extensionist_id, sku, product_name, unit, province, district,
                beneficiary_name, planned_qty, committed_qty, delivered_qty)
               VALUES (?,?,?,?,?,?,?,0,0,0)
               ON DUPLICATE KEY UPDATE extensionist_id=extensionist_id`,
              [
                it.extensionist_id, it.sku, it.product_name, it.unit,
                it.province, it.district, it.beneficiary_name,
              ]
            );
          }
        }

        // Peso real do camião — sacos contam como qty × 0.3 kg
        const totalKg = newItems.reduce((s, it) => s + qtyToKg(it.qty, it.unit), 0);
        const serviceNumber = `SRV-IMP-${newItems[0].external_adsn}`.slice(0, 32);

        // created_at: usa a Data Criação do Excel (min do grupo) — fallback
        // para now() se nenhuma das linhas tiver data válida. Para serviços
        // já em trânsito ou entregues, dispatched_at e delivered_at usam
        // a mesma data como aproximação (o Excel não tem timestamps por
        // mudança de estado).
        const createdAt = toMySQLDate(g.created_at_excel) || ts;
        const inTransit = g.state === "in_transit" || g.state === "delivered";
        const dispatchedAt = inTransit ? createdAt : null;
        const deliveredAt = g.state === "delivered" ? createdAt : null;

        // Insert service
        const [svcRes] = await conn2.query(
          `INSERT INTO delivery_services
           (service_number, province, district, truck_capacity_kg, truck_plate, truck_plate_2,
            origem_supplier, status, total_kg, source, created_at, dispatched_at, delivered_at, imported_from)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            serviceNumber, g.province, g.district, 0,
            g.plate1, g.plate2, g.supplier, g.state, totalKg, "imported", createdAt,
            dispatchedAt, deliveredAt, fileName,
          ]
        );
        const serviceId = svcRes.insertId;

        // Insert items
        for (let i = 0; i < newItems.length; i += 100) {
          const chunk = newItems.slice(i, i + 100);
          const ph = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",");
          const params = [];
          chunk.forEach((it) => params.push(
            serviceId, it.extensionist_id, it.sku, it.qty, it.unit,
            it.beneficiary_name, it.product_name, it.province, it.district,
            it.external_adsn, it.external_gtu
          ));
          await conn2.query(
            `INSERT INTO delivery_service_items
             (service_id, extensionist_id, sku, qty, unit,
              beneficiary_name, product_name, province, district,
              external_adsn, external_gtu)
             VALUES ${ph}`,
            params
          );
        }

        // Update balances for committed/delivered
        // For each item, increment committed_qty (and delivered_qty if state=delivered).
        // Cancelled state already handled (mapState defaults non-final to 'draft').
        for (const it of newItems) {
          if (g.state === "delivered") {
            await conn2.query(
              `UPDATE delivery_balances
               SET committed_qty = committed_qty + ?, delivered_qty = delivered_qty + ?
               WHERE extensionist_id = ? AND sku = ?`,
              [it.qty, it.qty, it.extensionist_id, it.sku]
            );
          } else if (g.state === "in_transit") {
            await conn2.query(
              `UPDATE delivery_balances
               SET committed_qty = committed_qty + ?
               WHERE extensionist_id = ? AND sku = ?`,
              [it.qty, it.extensionist_id, it.sku]
            );
          } else {
            // draft (CRIADO) — também bloqueia saldo (committed) mas não delivered
            await conn2.query(
              `UPDATE delivery_balances
               SET committed_qty = committed_qty + ?
               WHERE extensionist_id = ? AND sku = ?`,
              [it.qty, it.extensionist_id, it.sku]
            );
          }
        }

        await conn2.commit();
        createdServices++;
        createdItems += newItems.length;
      } catch (e) {
        await conn2.rollback();
        // Não relança — podemos ter um item órfão ou unique violation; loga e continua
        console.warn(`[bootstrap] grupo ${g.key} falhou: ${e.message}`);
      }
    }
  } finally {
    conn2.release();
  }

  return {
    source_rows: rows.length,
    services_created: createdServices,
    items_created: createdItems,
    items_skipped_duplicate: skippedDuplicate,
    auto_created_benefs,
    skipped_gtu99,
    skipped_invalid,
    file: fileName,
  };
}

// ── Saldo (planeamento por cumprir) ─────────────────────────
// Importa o ficheiro "planeamento_por_cumprir_DD_MM_YYYY.xlsx" que é a
// FONTE DE VERDADE do saldo a uma data. Sobreescreve planned_qty,
// committed_qty e delivered_qty em delivery_balances.
//
// Layout esperado da sheet "Detalhe por Beneficiário":
//   Província | Distrito | Artigo | NUIT | Nome Beneficiário |
//   Qtd Actualizada | A Entregar Fisicamente | Entregue/Trânsito (GTU/GTS98) |
//   Falta Entregar | % Cumprido | Supervisor | Contacto
//
// Mapeamento para o nosso schema:
//   planned_qty   = A Entregar Fisicamente
//   committed_qty = MIN(Entregue/Trânsito, planned_qty)   ← cap p/ não ir negativo
//   delivered_qty = committed_qty (no momento do baseline assume-se que tudo
//                   o que está "Entregue/Trânsito" foi efectivamente entregue)
//   excesso = Entregue - planned (informativo, guardado em notes)
async function importBalances(filePath, opts = {}) {
  const dryRun = !!opts.dryRun;
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets["Detalhe por Beneficiário"] || wb.Sheets["Detalhe por Beneficiario"];
  if (!sheet) throw new Error("Sheet 'Detalhe por Beneficiário' não encontrada em " + filePath);
  const rows = XLSX.utils.sheet_to_json(sheet);

  // Resolve identificador → beneficiary record.
  // O ficheiro tem normalmente NUIT (ex 2601076) na coluna NUIT, mas por
  // vezes aparece um Extensionist_ID (ex 0108-0006). Lookup por ambos.
  const conn = await getPool().getConnection();
  let byNuit, byExtId;
  try {
    const [benefRows] = await conn.query("SELECT extensionist_id, nuit, name FROM beneficiaries");
    byNuit = new Map(benefRows.filter((b) => b.nuit).map((b) => [String(b.nuit).trim(), b]));
    byExtId = new Map(benefRows.map((b) => [String(b.extensionist_id).trim(), b]));
  } finally {
    conn.release();
  }
  function lookup(idRaw) {
    const id = String(idRaw || "").trim();
    if (!id) return null;
    return byNuit.get(id) || byExtId.get(id) || null;
  }

  // Pre-aggregate per (extensionist_id, sku) — alguns benefs podem ter
  // múltiplas linhas para o mesmo Artigo (ex: realocações).
  const balMap = new Map(); // key=`${ext_id}|${sku}` → { ... }
  const newBenefs = []; // beneficiários auto-criados a partir do ficheiro
  const seenNew = new Set();
  let skipped_no_sku   = 0;
  let skipped_invalid  = 0;
  const overdelivered = []; // {id, sku, planned, entregue, excesso}

  for (const r of rows) {
    const idRaw = String(r.NUIT || "").trim();
    const artigo = r.Artigo;
    const sku = artigoToSku(artigo);
    if (!idRaw) { skipped_invalid++; continue; }
    if (!sku) { skipped_no_sku++; continue; }
    let benef = lookup(idRaw);
    if (!benef) {
      // Auto-criar beneficiário a partir do ficheiro.
      // Determinar se idRaw parece NUIT (numérico ~7 dígitos) ou ext_id (XXXX-XXXX)
      const looksLikeExtId = /^\d{4}-\d{4}$/.test(idRaw);
      const newBenef = {
        extensionist_id: looksLikeExtId ? idRaw : ("NB-" + idRaw),
        nuit: looksLikeExtId ? null : idRaw,
        name: String(r["Nome Beneficiário"] || idRaw).trim(),
        province: String(r.Província || "").trim() || null,
        district: String(r.Distrito || "").trim() || null,
        contact: String(r.Contacto || "").trim() || null,
        supervisor_name: String(r.Supervisor || "").trim() || null,
      };
      const key = newBenef.extensionist_id;
      if (!seenNew.has(key)) {
        seenNew.add(key);
        newBenefs.push(newBenef);
      }
      benef = newBenef;
      // adiciona aos lookups locais para subsequentes linhas
      byExtId.set(newBenef.extensionist_id, newBenef);
      if (newBenef.nuit) byNuit.set(newBenef.nuit, newBenef);
    }

    const planned = Number(r["A Entregar Fisicamente"]) || 0;
    const entregue = Number(r["Entregue/Trânsito (GTU/GTS98)"] || r["Entregue/Trânsito"]) || 0;
    if (planned <= 0 && entregue <= 0) continue;
    // Cap committed/delivered ao planned. Se Entregue > planned, regista excesso.
    const committed = Math.min(entregue, planned);
    if (entregue > planned) {
      overdelivered.push({ nuit, sku, planned, entregue, excesso: entregue - planned });
    }

    const key = `${benef.extensionist_id}|${sku}`;
    if (!balMap.has(key)) {
      const meta = skuMeta(sku);
      balMap.set(key, {
        extensionist_id: benef.extensionist_id,
        sku,
        product_name: meta.name,
        unit: meta.unit,
        province: String(r.Província || "").trim() || null,
        district: String(r.Distrito || "").trim() || null,
        beneficiary_name: String(r["Nome Beneficiário"] || benef.name).trim(),
        planned_qty: 0,
        committed_qty: 0,
        delivered_qty: 0,
      });
    }
    const b = balMap.get(key);
    b.planned_qty   += planned;
    b.committed_qty += committed;
    b.delivered_qty += committed; // baseline: committed == delivered
  }

  if (dryRun) {
    return {
      source_rows: rows.length,
      balances: balMap.size,
      auto_created_beneficiaries: newBenefs.length,
      skipped_no_sku,
      skipped_invalid,
      overdelivered_count: overdelivered.length,
      sample_new_benefs: newBenefs.slice(0, 5),
      sample_overdelivered: overdelivered.slice(0, 5),
    };
  }

  // Re-cap por beneficiário×sku (por causa de várias linhas por par)
  for (const b of balMap.values()) {
    if (b.committed_qty > b.planned_qty) b.committed_qty = b.planned_qty;
    if (b.delivered_qty > b.committed_qty) b.delivered_qty = b.committed_qty;
  }

  // RESET + UPSERT — este ficheiro é a fonte de verdade absoluta.
  // Zeramos planned/committed/delivered de TODOS os balances primeiro;
  // depois o UPSERT só toca nos (benef, sku) presentes no ficheiro.
  // Os pares ausentes ficam a zero (não aparecem em saldo > 0). FKs
  // de delivery_service_items mantêm-se válidas (não apagamos linhas).
  const conn2 = await getPool().getConnection();
  try {
    await conn2.beginTransaction();
    // Auto-criar beneficiaries que apareceram no ficheiro mas não em DB
    if (newBenefs.length) {
      const ts = now();
      const placeholders = newBenefs.map(() => "(?,?,?,?,?,?,?,?)").join(",");
      const params = [];
      newBenefs.forEach((b) => params.push(
        b.extensionist_id, b.nuit, b.name, b.province, b.district,
        b.contact, b.supervisor_name, ts
      ));
      await conn2.query(
        `INSERT INTO beneficiaries
         (extensionist_id, nuit, name, province, district, contact, supervisor_name, imported_at)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE name=VALUES(name)`,
        params
      );
    }
    if (opts.reset !== false) {
      await conn2.query(
        "UPDATE delivery_balances SET planned_qty = 0, committed_qty = 0, delivered_qty = 0"
      );
    }
    const list = [...balMap.values()];
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      const placeholders = chunk.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
      const params = [];
      chunk.forEach((b) => params.push(
        b.extensionist_id, b.sku, b.product_name, b.unit,
        b.province, b.district, b.beneficiary_name,
        b.planned_qty, b.committed_qty, b.delivered_qty
      ));
      await conn2.query(
        `INSERT INTO delivery_balances
         (extensionist_id, sku, product_name, unit, province, district,
          beneficiary_name, planned_qty, committed_qty, delivered_qty)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           product_name=VALUES(product_name), unit=VALUES(unit),
           province=VALUES(province), district=VALUES(district),
           beneficiary_name=VALUES(beneficiary_name),
           planned_qty=VALUES(planned_qty),
           committed_qty=VALUES(committed_qty),
           delivered_qty=VALUES(delivered_qty)`,
        params
      );
    }
    await conn2.commit();
  } catch (e) {
    await conn2.rollback();
    throw e;
  } finally {
    conn2.release();
  }

  return {
    source_rows: rows.length,
    balances: balMap.size,
    auto_created_beneficiaries: newBenefs.length,
    skipped_no_sku,
    skipped_invalid,
    overdelivered_count: overdelivered.length,
    file: path.basename(filePath),
  };
}

// ── Clean wipe ──────────────────────────────────────────────
// Apaga toda a data de distribuição (em ordem para respeitar FKs).
// Usar APENAS antes de re-importar tudo do zero.
async function cleanAll() {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM delivery_service_items");
    await conn.query("DELETE FROM delivery_services");
    await conn.query("DELETE FROM delivery_balances");
    await conn.query("DELETE FROM beneficiaries");
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return { ok: true };
}

module.exports = { importPlanning, importBalances, importServices, cleanAll, normalizePlate, skuMeta, planSkuMeta, canonSku, mapState, artigoToSku };
