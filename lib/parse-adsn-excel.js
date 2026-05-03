/**
 * Parses the ADICIONAL "servicos" Excel export into ADSN records.
 *
 * Format (same as public dashboard's servicos.xlsx):
 * Data Criação | Projecto | Nome Projecto | Serviço | Trabalho | Estado | Agregador |
 * Matricula | Origem | Entidade | Destinatario | Provincia | Distrito | Volumes | Peso | SKU
 *
 * Only série 98 (GTU98/...) rows are imported.
 */
const XLSX = require("xlsx");

const SKU_MAP = {
  MXIXMILHOKG: "MILHO KG",
  MXIXFEIJAOKG: "FEIJÃO KG",
  MXIXARROZKG: "ARROZ KG",
  AGRIFEMTINL: "EMAMECTIN",
  AGRIMIDACLORIPLT: "IMIDACLOPRID",
  AGRIMHMCPALT: "MCPA",
  SUSSACO: "SACOS HERMÉTICOS",
  MMRMINTER25: "SACOS HERMÉTICOS",
  SEEDARROZM50KG: "ARROZ SEMENTE 50KG",
  MSEEDFJNHB5KG: "FEIJÃO SEMENTE 5KG",
  MSEEDOPVZM523: "MILHO SEMENTE",
  AGRIFEMMA0125L: "EMAMECTIN",
};

function normGTU(raw) {
  let g = String(raw || "").trim().replace(/\\/g, "/");
  // GTUS98/... (typo do operador) → GTS98/... antes de tudo o resto
  g = g.replace(/^GTUS/i, "GTS");
  g = g.replace(/^GTS/i, "GTU");
  g = g.replace(/^(GTU\d+\/\d{4})\/(\d+)$/i, (_, prefix, num) => prefix + num.padStart(5, "0"));
  g = g.replace(/^(GTU\d+\/\d{4})(\d{4})$/i, (_, prefix, num) => prefix + "0" + num);
  return g;
}

function parseADSNExcel(fileOrBuffer) {
  const wb = typeof fileOrBuffer === "string"
    ? XLSX.readFile(fileOrBuffer)
    : XLSX.read(fileOrBuffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const out = [];
  let skipped = 0;

  for (const r of rows) {
    const adsn_code = String(r["Serviço"] || "").trim();
    if (!adsn_code) { skipped++; continue; }
    const gtu = normGTU(r["Trabalho"]);
    // Only série 98 (GTU98/... or no GTU for agregadoras with ADSE)
    if (gtu && !/^GTU98\//i.test(gtu)) { skipped++; continue; }

    // Sacos herméticos (SUSSACO): Peso no Excel é inconsistente (uns rows
    // têm count, outros têm kg). Volumes é sempre o count real. Para SUSSACO
    // armazenamos peso_kg como o NÚMERO DE SACOS (qty real), não kg, porque
    // é assim que se mensura no negócio. Outros SKUs usam Peso (kg) como antes.
    const skuStr = String(r["SKU"] || "").trim();
    const isUnitSku = skuStr === "SUSSACO";
    const volumesCol = Number(r["Volumes"]) || 0;
    const pesoCol = Number(r["Peso"]) || 0;
    out.push({
      adsn_code,
      gtu: gtu || null,
      tipo: String(r["Estado"] || "").toUpperCase() || null,
      projecto: String(r["Nome Projecto"] || "").trim() || null,
      origem: String(r["Origem"] || "").trim() || null,
      destinatario: String(r["Destinatario"] || "").trim() || null,
      destinatario_contact: null,
      provincia: String(r["Provincia"] || "").trim() || null,
      distrito: String(r["Distrito"] || "").trim() || null,
      sku: skuStr || null,
      product_name: SKU_MAP[skuStr] || skuStr || null,
      peso_kg: isUnitSku ? volumesCol : pesoCol,
      volumes: volumesCol,
    });
  }

  return { records: out, skipped, total: rows.length };
}

module.exports = { parseADSNExcel, normGTU, SKU_MAP };
