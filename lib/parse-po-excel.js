/**
 * Parses EFP Excel (Purchase Orders export) into PO records.
 *
 * Input format has a title header at row 0 and column headers starting at row 1.
 * Real column names live in the second row: Arm | Diário | NºDoc | NºLin | Localiz |
 *   Data | Ano | Mês | ADSN | ADSE | Nome | Estado | Referência | Qtd.Ini | Qtd.Falta |
 *   Qtd.Entr | Qtd.Disp | Pr.Unit | Moeda | Tot.Liq | Tot.Pend | Provincia | Distrito |
 *   Nºent | IVA | Lote | Processo | C.Médio | C.Total | Tot.Linha | NUIT | Origem |
 *   Mov.251 | Descrição | Lin.Susp | Tipo Ent
 *
 * Rows with the same NºDoc + supplier are grouped into one PO with multiple items.
 */
const XLSX = require("xlsx");

function parsePODate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function parseNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const s = String(v).replace(/[, ]/g, "").replace(",", ".");
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

/**
 * Parse an EFP Excel buffer or path.
 * Returns: { orders: [{ po_number, supplier, items: [...] }], total_rows, skipped }
 */
function parsePOExcel(fileOrBuffer) {
  const wb = typeof fileOrBuffer === "string"
    ? XLSX.readFile(fileOrBuffer)
    : XLSX.read(fileOrBuffer, { type: "buffer" });

  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });

  // Find header row (contains "NºDoc" or starts with "Arm")
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i];
    if (!r) continue;
    const hasDoc = r.some((c) => String(c).trim() === "NºDoc");
    if (hasDoc) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error("Formato EFP inválido: não encontrei linha de cabeçalho com 'NºDoc'");

  const header = rows[headerIdx].map((c) => String(c).trim());
  const idx = (name) => header.indexOf(name);

  const col = {
    doc: idx("NºDoc"),
    line: idx("NºLin"),
    data: idx("Data"),
    nome: idx("Nome"),
    estado: idx("Estado"),
    referencia: idx("Referência"),
    qtdIni: idx("Qtd.Ini"),
    qtdEntr: idx("Qtd.Entr"),
    provincia: idx("Provincia"),
    nent: idx("Nºent"),
    nuit: idx("NUIT"),
    descricao: idx("Descrição"),
    moeda: idx("Moeda"),
    prUnit: idx("Pr.Unit"),
  };

  const orders = new Map(); // key: po_number → { ...po, itemsByRef: {} }
  let skipped = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) { skipped++; continue; }
    const poNumber = String(r[col.doc] || "").trim();
    const supplier = String(r[col.nome] || "").trim();
    const ref = String(r[col.referencia] || "").trim();
    const qty = parseNum(r[col.qtdIni]);
    if (!poNumber || !supplier || !ref || qty <= 0) { skipped++; continue; }

    const key = poNumber + "|" + supplier;
    if (!orders.has(key)) {
      orders.set(key, {
        po_number: poNumber,
        po_date: parsePODate(r[col.data]),
        supplier: {
          name: supplier,
          nuit: String(r[col.nuit] || "").trim() || null,
          client_number: String(r[col.nent] || "").trim() || null,
        },
        projecto: "PROJECTO AQI-PROCUMENT EMERGEN",
        items: [],
        _itemsByRef: new Map(),
      });
    }
    const po = orders.get(key);

    // Aggregate by product reference (same SKU in multiple lines → sum qty)
    if (po._itemsByRef.has(ref)) {
      po._itemsByRef.get(ref).qty += qty;
    } else {
      const item = {
        product_code: ref,
        product_name: String(r[col.descricao] || "").trim() || ref,
        qty,
        unit: inferUnit(ref),
      };
      po._itemsByRef.set(ref, item);
      po.items.push(item);
    }
  }

  // Drop internal map
  const out = [...orders.values()].map((po) => {
    const { _itemsByRef, ...clean } = po;
    return clean;
  });

  return {
    orders: out,
    total_rows: rows.length - headerIdx - 1,
    skipped,
  };
}

function inferUnit(code) {
  const c = String(code || "").toUpperCase();
  if (c.endsWith("KG")) return "kg";
  if (c.endsWith("L") || c.endsWith("LT")) return "L";
  if (c.endsWith("ML")) return "mL";
  return "un";
}

module.exports = { parsePOExcel };
