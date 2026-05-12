// Compara Copy of List Sofala.xlsx vs delivery_balances para SUSSACO.
// Sacos planeados = SUM(num_kits) por extensionist_id × 20.
// Mostra: per-district summary + linhas em falta + linhas com discrepancia.
const ExcelJS = require("exceljs");
const path = require("path");

const EXCEL = "C:/Users/Ismael Chiziane/Documents/AQI/Planeamentos/Actualizações/Copy of List Sofala.xlsx";
const SACOS_POR_KIT = 20;

(async () => {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  const { query } = require("../db/mysql");

  // 1. Lê Excel
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL);
  const ws = wb.worksheets[0];

  // Mapa: extensionist_id -> { name, district, num_kits_total }
  // (várias linhas por mesmo ID — uma por kit type; somar)
  const xl = new Map();
  for (let r = 2; r <= ws.actualRowCount; r++) {
    const row = ws.getRow(r);
    const ext = String(row.getCell(1).value || "").trim();
    if (!ext) continue;
    const name = String(row.getCell(2).value || "").trim();
    const district = String(row.getCell(7).value || "").trim();
    let nk = row.getCell(11).value;
    if (nk && typeof nk === "object" && nk.result != null) nk = nk.result;
    nk = Number(nk) || 0;
    if (!xl.has(ext)) xl.set(ext, { name, district, kits: 0 });
    xl.get(ext).kits += nk;
  }

  // 2. Lê DB: SUSSACO por extensionist_id em Sofala
  // (distrito vem da própria delivery_balances)
  const dbRows = await query(`
    SELECT extensionist_id, beneficiary_name, district, planned_qty
    FROM delivery_balances
    WHERE province = 'Sofala' AND sku = 'SUSSACO'
  `);
  const db = new Map();
  for (const r of dbRows) {
    db.set(r.extensionist_id, {
      name: r.beneficiary_name,
      district: r.district,
      sacos: Number(r.planned_qty) || 0,
    });
  }

  // 3. Compara
  const summary = {}; // district -> {xl_total_sacos, db_total_sacos, missing[], extra[], diff[]}
  const districtSet = new Set();
  for (const [ext, x] of xl) districtSet.add(x.district);
  for (const [ext, d] of db) districtSet.add(d.district);
  for (const dist of districtSet) summary[dist] = { xl_sacos: 0, db_sacos: 0, missing: [], extra: [], diff: [] };

  // Itera por IDs do Excel
  for (const [ext, x] of xl) {
    const xlSacos = x.kits * SACOS_POR_KIT;
    summary[x.district].xl_sacos += xlSacos;
    const dbR = db.get(ext);
    if (!dbR) {
      summary[x.district].missing.push({ ext, name: x.name, kits: x.kits, sacos: xlSacos });
    } else if (dbR.sacos !== xlSacos) {
      summary[x.district].diff.push({ ext, name: x.name, xl: xlSacos, db: dbR.sacos, gap: xlSacos - dbR.sacos });
    }
  }
  // Itera DB: marca DB-rows sem correspondência no Excel (extra)
  for (const [ext, d] of db) {
    summary[d.district].db_sacos += d.sacos;
    if (!xl.has(ext)) {
      summary[d.district].extra.push({ ext, name: d.name, sacos: d.sacos });
    }
  }

  // 4. Output
  console.log("=".repeat(80));
  console.log("COMPARAÇÃO SOFALA: Excel vs Base de Dados (SUSSACO = sacos hermeticos)");
  console.log("=".repeat(80));
  let totXl = 0, totDb = 0;
  const districts = Object.keys(summary).sort();
  const colW = (s, w) => String(s).padEnd(w);
  const numW = (n, w) => String(n).padStart(w);
  console.log(`\n${colW("Distrito", 14)}${numW("Excel", 10)}${numW("DB", 10)}${numW("Diff", 10)}${numW("Falta", 8)}${numW("Extra", 8)}  Estado`);
  console.log("-".repeat(80));
  for (const d of districts) {
    const s = summary[d];
    totXl += s.xl_sacos; totDb += s.db_sacos;
    const diff = s.xl_sacos - s.db_sacos;
    const ok = diff === 0 && s.missing.length === 0 && s.extra.length === 0 && s.diff.length === 0;
    const flag = ok ? "✓" : (diff > 0 ? "⚠ falta na DB" : diff < 0 ? "⚠ excesso na DB" : "⚠ discrepancia");
    console.log(`${colW(d, 14)}${numW(s.xl_sacos.toLocaleString("pt-PT"), 10)}${numW(s.db_sacos.toLocaleString("pt-PT"), 10)}${numW((diff>=0?"+":"") + diff.toLocaleString("pt-PT"), 10)}${numW(s.missing.length, 8)}${numW(s.extra.length, 8)}  ${flag}`);
  }
  console.log("-".repeat(80));
  console.log(`${colW("TOTAL", 14)}${numW(totXl.toLocaleString("pt-PT"), 10)}${numW(totDb.toLocaleString("pt-PT"), 10)}${numW((totXl-totDb >= 0 ? "+" : "") + (totXl-totDb).toLocaleString("pt-PT"), 10)}`);

  // Detalhe das anomalias
  console.log("\n" + "=".repeat(80));
  console.log("ANOMALIAS DETALHADAS");
  console.log("=".repeat(80));
  for (const d of districts) {
    const s = summary[d];
    if (s.missing.length === 0 && s.extra.length === 0 && s.diff.length === 0) continue;
    console.log(`\n▶ ${d} (Excel: ${s.xl_sacos}, DB: ${s.db_sacos}):`);
    if (s.missing.length) {
      console.log(`  FALTAM ${s.missing.length} extensionistas na DB:`);
      s.missing.forEach((m) => console.log(`    ✗ ${m.ext}  ${m.name.padEnd(35)}  ${m.kits} kits = ${m.sacos} sacos`));
    }
    if (s.extra.length) {
      console.log(`  EXTRAS ${s.extra.length} extensionistas na DB (não no Excel):`);
      s.extra.forEach((e) => console.log(`    + ${e.ext}  ${e.name.padEnd(35)}  ${e.sacos} sacos`));
    }
    if (s.diff.length) {
      console.log(`  DIFERENÇAS de valor ${s.diff.length}:`);
      s.diff.forEach((d) => console.log(`    ~ ${d.ext}  ${d.name.padEnd(35)}  Excel=${d.xl}  DB=${d.db}  gap=${d.gap >= 0 ? "+" : ""}${d.gap}`));
    }
  }

  process.exit(0);
})();
