/**
 * Gera um relatório Excel com TODOS os conflitos detectados nos ficheiros
 * MAAP — colisões de ID (mesma chave para pessoas diferentes) e duplicações
 * (mesma pessoa em 2 linhas).
 *
 * O relatório serve para o coordenador AQI verificar com a equipa do MAAP
 * quais são os IDs correctos para cada extensionista "perdido".
 *
 * Saída: data/maap-conflicts-<timestamp>.xlsx
 *   Aba 1: Resumo
 *   Aba 2: Colisões (pessoas distintas com mesmo ID)
 *   Aba 3: Duplicações (mesma pessoa em 2 linhas)
 *   Aba 4: Entregas Afectadas (cruza com o admin DB)
 */

require("dotenv").config();
const XLSX = require("xlsx");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const m = require("../db/mysql");

const FILES = {
  Maputo:   "UPDATED INFORMATION FOR MAPUTO LIST.xlsx",
  Gaza:     "UPDATED INFORMATION FOR GAZA LIST.xlsx",
  Sofala:   "Copy of List Sofala.xlsx",
  Zambezia: "List Zambezia.xlsx",
  Manica:   "UPDATED INFORMATION FOR MANICA LIST.xlsx",
  Tete:     "UPDATED INFORMATION FOR TETE LIST (2).xlsx",
};

const MAAP_DIR = path.join(__dirname, "..", "data", "maap");

// Detecta colisões e duplicações em todos os ficheiros MAAP
function findConflicts() {
  const collisions = []; // ext_id partilhado por pessoas diferentes
  const duplicates = []; // mesma pessoa em ≥2 linhas

  for (const [prov, fname] of Object.entries(FILES)) {
    const fp = path.join(MAAP_DIR, fname);
    if (!fs.existsSync(fp)) continue;
    const wb = XLSX.readFile(fp);
    let sheet = null;
    for (const sn of wb.SheetNames) {
      const head = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: "", header: 1, range: 0 })[0] || [];
      if (/quantities maap|updated quantit/i.test(head.map((h) => String(h || "").trim()).join("|"))) {
        sheet = sn; break;
      }
    }
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: "" });
    // Agrupa por ext_id+kit
    const byKey = {};
    for (const r of rows) {
      const id = String(r["Extensionist_ID"] || "").trim();
      if (!id) continue;
      const kit = String(r.Kit || r.KIT || "").trim();
      const key = id + "|" + kit;
      if (!byKey[key]) byKey[key] = { id, kit, rows: [] };
      byKey[key].rows.push(r);
    }
    for (const g of Object.values(byKey)) {
      if (g.rows.length < 2) continue;
      const names = [...new Set(g.rows.map((r) => String(r.Extensionist || "").trim()))];
      const item = {
        province: prov,
        district: String(g.rows[0].District || "").trim(),
        location: String(g.rows[0].Location || "").trim(),
        ext_id: g.id,
        kit: g.kit,
        rows: g.rows.map((r) => ({
          name: String(r.Extensionist || "").trim(),
          qty: Number(r["Updated quantities"]) || 0,
          previous: Number(r["Previous Quantity"]) || 0,
          contact: String(r["Extensionist Contact"] || "").trim(),
          supervisor: String(r["Supervisor"] || "").trim(),
          supervisor_phone: String(r["Supervisor Contact"] || "").trim(),
        })),
      };
      if (names.length > 1) collisions.push(item);
      else duplicates.push(item);
    }
  }
  return { collisions, duplicates };
}

// Composição do Kit 1 e Kit 2 (necessário para calcular o impacto)
const KIT_RECIPE = {
  Milho:                { unit: "kg", kit1: 12.5, kit2: 0 },
  Arroz:                { unit: "kg", kit1: 0,    kit2: 50 },
  "Feijão":             { unit: "kg", kit1: 15,   kit2: 15 },
  "NPK 12.24.12":       { unit: "kg", kit1: 50,   kit2: 50 },
  "Sacos Hermeticos":   { unit: "un", kit1: 20,   kit2: 0 },
  Emamectim:            { unit: "L",  kit1: 0.5,  kit2: 0.5 },
  Imidacloprid:         { unit: "L",  kit1: 0.5,  kit2: 0 },
  MCPA:                 { unit: "L",  kit1: 0,    kit2: 1.5 },
};

async function fetchDeliveries(extIds) {
  if (!extIds.length) return [];
  return await m.query(
    `SELECT extensionist_id, beneficiary_name, sku, product_name, unit,
            planned_original, planned_qty, committed_qty, delivered_qty
     FROM delivery_balances
     WHERE extensionist_id IN (${extIds.map(() => "?").join(",")})
       AND (committed_qty > 0 OR delivered_qty > 0)`,
    extIds
  );
}

async function main() {
  console.log("Analisando ficheiros MAAP...");
  const { collisions, duplicates } = findConflicts();
  console.log(`Encontradas: ${collisions.length} colisões, ${duplicates.length} duplicações`);

  const allIds = [...new Set([...collisions.map((c) => c.ext_id), ...duplicates.map((d) => d.ext_id)])];
  console.log(`Buscando entregas existentes para ${allIds.length} IDs...`);
  const deliveries = await fetchDeliveries(allIds);
  console.log(`${deliveries.length} entregas com committed/delivered > 0`);

  // Indexa entregas por ext_id
  const delivByExt = {};
  for (const d of deliveries) {
    if (!delivByExt[d.extensionist_id]) delivByExt[d.extensionist_id] = [];
    delivByExt[d.extensionist_id].push(d);
  }

  // ── Cria workbook com 4 abas ────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "AQI Distribution Dashboard";
  wb.created = new Date();

  // ─── Aba 1: Resumo ──────────────────────────────────────────
  const ws1 = wb.addWorksheet("Resumo", {
    properties: { defaultColWidth: 20 },
  });
  ws1.columns = [
    { header: "Província", key: "prov", width: 14 },
    { header: "Tipo", key: "tipo", width: 18 },
    { header: "Nº Conflitos", key: "n", width: 14 },
    { header: "Pessoas afectadas", key: "pessoas", width: 16 },
    { header: "Kit1 total disputado", key: "kit1", width: 22 },
    { header: "Tem entregas?", key: "entregas", width: 16 },
  ];
  // Estilo do header
  ws1.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F4C75" } };
    c.alignment = { vertical: "middle", horizontal: "center" };
  });
  // Sumário por província
  const provs = [...new Set([...collisions, ...duplicates].map((x) => x.province))].sort();
  for (const prov of provs) {
    const cInProv = collisions.filter((c) => c.province === prov);
    const dInProv = duplicates.filter((d) => d.province === prov);
    if (cInProv.length) {
      const allIds = cInProv.map((c) => c.ext_id);
      const hasDeliv = allIds.some((id) => delivByExt[id]);
      const totalKit1 = cInProv.reduce((s, c) => s + c.rows.reduce((s2, r) => s2 + r.qty, 0), 0);
      ws1.addRow({
        prov, tipo: "Colisão (pessoas distintas)",
        n: cInProv.length, pessoas: cInProv.length * 2,
        kit1: totalKit1, entregas: hasDeliv ? "SIM ⚠" : "Não",
      });
    }
    if (dInProv.length) {
      const allIds = dInProv.map((d) => d.ext_id);
      const hasDeliv = allIds.some((id) => delivByExt[id]);
      const totalKit1 = dInProv.reduce((s, d) => s + d.rows.reduce((s2, r) => s2 + r.qty, 0), 0);
      ws1.addRow({
        prov, tipo: "Duplicação (mesma pessoa)",
        n: dInProv.length, pessoas: dInProv.length,
        kit1: totalKit1, entregas: hasDeliv ? "SIM ⚠" : "Não",
      });
    }
  }
  // Linha total
  const totalRow = ws1.addRow({
    prov: "TOTAL", tipo: "",
    n: collisions.length + duplicates.length,
    pessoas: collisions.length * 2 + duplicates.length,
    kit1: [...collisions, ...duplicates].reduce((s, c) => s + c.rows.reduce((s2, r) => s2 + r.qty, 0), 0),
    entregas: "",
  });
  totalRow.eachCell((c) => {
    c.font = { bold: true };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
  });

  // ─── Aba 2: Colisões (pessoas distintas) ────────────────────
  const ws2 = wb.addWorksheet("Colisões");
  ws2.columns = [
    { header: "Província", key: "province", width: 12 },
    { header: "Distrito", key: "district", width: 14 },
    { header: "Localidade", key: "location", width: 14 },
    { header: "ID partilhado", key: "ext_id", width: 13 },
    { header: "Kit", key: "kit", width: 8 },
    { header: "Pessoa", key: "name", width: 32 },
    { header: "Kit1 (qty)", key: "qty", width: 10 },
    { header: "Milho (kg)", key: "milho", width: 11 },
    { header: "Feijão (kg)", key: "feijao", width: 11 },
    { header: "Contacto", key: "contact", width: 14 },
    { header: "Supervisor", key: "supervisor", width: 22 },
    { header: "Tel. Supervisor", key: "sup_phone", width: 14 },
    { header: "Tem entregas?", key: "deliveries", width: 14 },
    { header: "ID correcto (preencher)", key: "id_correct", width: 22 },
    { header: "Notas (preencher)", key: "notes", width: 30 },
  ];
  ws2.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDC2626" } };
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });

  // Ordena por província, distrito, ext_id
  collisions.sort((a, b) =>
    a.province.localeCompare(b.province) ||
    a.district.localeCompare(b.district) ||
    a.ext_id.localeCompare(b.ext_id)
  );
  for (const c of collisions) {
    const hasDeliv = delivByExt[c.ext_id] ? "SIM ⚠" : "Não";
    for (let i = 0; i < c.rows.length; i++) {
      const r = c.rows[i];
      const isFirst = i === 0;
      const milho = r.qty * (KIT_RECIPE.Milho.kit1);
      const feijao = r.qty * (KIT_RECIPE["Feijão"].kit1);
      const row = ws2.addRow({
        province: isFirst ? c.province : "",
        district: isFirst ? c.district : "",
        location: isFirst ? c.location : "",
        ext_id: isFirst ? c.ext_id : "",
        kit: isFirst ? c.kit : "",
        name: r.name,
        qty: r.qty,
        milho, feijao,
        contact: r.contact || "",
        supervisor: r.supervisor,
        sup_phone: r.supervisor_phone,
        deliveries: isFirst ? hasDeliv : "",
        id_correct: "", notes: "",
      });
      // Destaca a linha "perdida" (a 2ª) em amarelo
      if (i > 0) {
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
        });
      }
      // Destaca col "Tem entregas?" se SIM
      if (isFirst && hasDeliv === "SIM ⚠") {
        row.getCell("deliveries").font = { bold: true, color: { argb: "FFDC2626" } };
      }
    }
    // Linha separadora
    ws2.addRow({});
  }

  // ─── Aba 3: Duplicações (mesma pessoa) ──────────────────────
  const ws3 = wb.addWorksheet("Duplicações");
  ws3.columns = [
    { header: "Província", key: "province", width: 12 },
    { header: "Distrito", key: "district", width: 14 },
    { header: "Localidade", key: "location", width: 14 },
    { header: "ID", key: "ext_id", width: 13 },
    { header: "Kit", key: "kit", width: 8 },
    { header: "Pessoa", key: "name", width: 32 },
    { header: "Linha", key: "line", width: 8 },
    { header: "Kit1 (qty)", key: "qty", width: 10 },
    { header: "Quantity Anterior", key: "prev", width: 16 },
    { header: "Tem entregas?", key: "deliveries", width: 14 },
    { header: "Acção sugerida", key: "action", width: 28 },
  ];
  ws3.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD97706" } };
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  duplicates.sort((a, b) =>
    a.province.localeCompare(b.province) || a.district.localeCompare(b.district)
  );
  for (const d of duplicates) {
    const hasDeliv = delivByExt[d.ext_id] ? "SIM ⚠" : "Não";
    const allEqual = d.rows.every((r) => r.qty === d.rows[0].qty);
    const someZero = d.rows.some((r) => r.qty === 0);
    const action = allEqual ? "Pegar 1 linha (qtds iguais)"
      : someZero ? "Pegar a linha não-zero"
      : "Verificar manualmente";
    for (let i = 0; i < d.rows.length; i++) {
      const r = d.rows[i];
      const isFirst = i === 0;
      ws3.addRow({
        province: isFirst ? d.province : "",
        district: isFirst ? d.district : "",
        location: isFirst ? d.location : "",
        ext_id: isFirst ? d.ext_id : "",
        kit: isFirst ? d.kit : "",
        name: r.name,
        line: i + 1,
        qty: r.qty,
        prev: r.previous,
        deliveries: isFirst ? hasDeliv : "",
        action: isFirst ? action : "",
      });
    }
    ws3.addRow({});
  }

  // ─── Aba 4: Entregas Afectadas ──────────────────────────────
  const ws4 = wb.addWorksheet("Entregas Afectadas");
  ws4.columns = [
    { header: "Província", key: "province", width: 12 },
    { header: "Distrito", key: "district", width: 14 },
    { header: "ID", key: "ext_id", width: 13 },
    { header: "Pessoa no admin (P1)", key: "p1", width: 28 },
    { header: "Kit1 P1", key: "qty1", width: 10 },
    { header: "Pessoa real provável (P2)", key: "p2", width: 28 },
    { header: "Kit1 P2", key: "qty2", width: 10 },
    { header: "Produto", key: "product", width: 16 },
    { header: "Comprometido", key: "committed", width: 14 },
    { header: "Entregue", key: "delivered", width: 12 },
    { header: "Bate Kit1 de quem?", key: "match", width: 22 },
  ];
  ws4.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C3AED" } };
    c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  for (const c of collisions) {
    const dels = delivByExt[c.ext_id];
    if (!dels || !dels.length) continue;
    const p1 = c.rows[0]; // a que está no admin
    const p2 = c.rows[1]; // a "perdida"
    for (const d of dels) {
      const recipe = KIT_RECIPE[d.product_name];
      let match = "Não bate em nenhum";
      if (recipe) {
        const kit1Factor = recipe.kit1;
        const totalCommitted = Number(d.committed_qty);
        const expectedP1 = p1.qty * kit1Factor;
        const expectedP2 = p2.qty * kit1Factor;
        if (kit1Factor > 0) {
          if (Math.abs(totalCommitted - expectedP2) < 0.5) match = `P2 (${p2.name})`;
          else if (Math.abs(totalCommitted - expectedP1) < 0.5) match = `P1 (${p1.name})`;
          else if (Math.abs(totalCommitted - (expectedP1 + expectedP2)) < 0.5) match = "Soma P1+P2";
        }
      }
      const row = ws4.addRow({
        province: c.province,
        district: c.district,
        ext_id: c.ext_id,
        p1: p1.name, qty1: p1.qty,
        p2: p2.name, qty2: p2.qty,
        product: d.product_name,
        committed: Number(d.committed_qty),
        delivered: Number(d.delivered_qty),
        match,
      });
      if (match.startsWith("P2")) {
        row.getCell("match").font = { bold: true, color: { argb: "FFDC2626" } };
        row.getCell("p2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" } };
      }
    }
  }

  // Adiciona nota explicativa na aba Resumo
  ws1.addRow({});
  ws1.addRow({}); ws1.addRow({});
  const noteStart = ws1.rowCount + 1;
  ws1.mergeCells(`A${noteStart}:F${noteStart}`);
  const cell = ws1.getCell(`A${noteStart}`);
  cell.value = "Notas:";
  cell.font = { bold: true, size: 11 };
  ws1.mergeCells(`A${noteStart+1}:F${noteStart+1}`);
  ws1.getCell(`A${noteStart+1}`).value = "1. COLISÃO = mesmo ID atribuído a 2 pessoas distintas (erro grave). Ver aba 'Colisões'.";
  ws1.mergeCells(`A${noteStart+2}:F${noteStart+2}`);
  ws1.getCell(`A${noteStart+2}`).value = "2. DUPLICAÇÃO = mesma pessoa em 2 linhas (erro de copy-paste). Ver aba 'Duplicações'.";
  ws1.mergeCells(`A${noteStart+3}:F${noteStart+3}`);
  ws1.getCell(`A${noteStart+3}`).value = "3. Para corrigir: preencher coluna 'ID correcto' na aba 'Colisões' com o ID real do sistema MAAP.";
  ws1.mergeCells(`A${noteStart+4}:F${noteStart+4}`);
  ws1.getCell(`A${noteStart+4}`).value = "4. Aba 'Entregas Afectadas' mostra cruzamento com entregas já feitas — útil para perceber se as entregas foram para P1 ou P2.";

  // ── Save ────────────────────────────────────────────────────
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const outDir = path.join(__dirname, "..", "data");
  const outPath = path.join(outDir, `maap-conflitos-${ts}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log(`\n✓ Relatório gerado: ${outPath}`);
  console.log(`  Abas: Resumo, Colisões (${collisions.length}), Duplicações (${duplicates.length}), Entregas Afectadas`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
