/**
 * Diagnóstico: detalha o fornecedor "Mahomed Agro Investimentos" — vê
 * todas as variantes do nome, account numbers, e soma por status para
 * identificar onde estão os ~75t em falta dos 125t reais.
 */
require("dotenv").config();
const api = require("../lib/adicional-api");

(async () => {
  const fromDate = process.argv[2] || "2026-01-01";
  const toDate   = process.argv[3] || "2026-12-31";
  console.log(`\n=== Mahomed Agro — fetch ${fromDate} a ${toDate} ===\n`);

  const r = await api.listProjectsChunked({ fromDate, toDate, chunkDays: 7, noCache: true });
  console.log(`Total API rows no período: ${r.rows.length}\n`);

  // Procura todas as variantes que contenham "MAHOMED" no ShipFromName ou Address
  const matches = r.rows.filter((x) => {
    const name = String(x.ShipFromName || "").toUpperCase();
    const addr = String(x.ShipFromAddress || "").toUpperCase();
    return name.includes("MAHOMED") || addr.includes("MAHOMED");
  });

  if (!matches.length) {
    console.log("Nenhuma row encontrada com MAHOMED no ShipFromName/Address.");
    console.log("Listo todas as variantes distintas de ShipFromName que existem:");
    const seen = new Set();
    for (const x of r.rows) seen.add(String(x.ShipFromName || "").trim());
    [...seen].sort().forEach((n) => console.log("  · " + n));
    return;
  }

  console.log(`Matches: ${matches.length} rows\n`);

  // Agrupa por (ShipAcountNumber, ShipFromName) — para ver variantes/nomes
  const byKey = new Map();
  for (const x of matches) {
    const acc  = String(x.ShipAcountNumber || "").trim() || "(sem acct)";
    const name = String(x.ShipFromName || "").trim() || "(sem nome)";
    const k = acc + " || " + name;
    if (!byKey.has(k)) byKey.set(k, { acc, name, n: 0, kg: 0, byStatus: {} });
    const e = byKey.get(k);
    e.n++;
    e.kg += Number(x.Weight) || 0;
    const s = String(x.StatusName || "(sem)").toUpperCase();
    e.byStatus[s] = (e.byStatus[s] || 0) + (Number(x.Weight) || 0);
  }
  console.log("Variantes detectadas:");
  for (const e of byKey.values()) {
    console.log("  acct=" + e.acc + "  name='" + e.name + "'");
    console.log("    rows=" + e.n + "  total=" + Math.round(e.kg).toLocaleString() + " kg");
    for (const [s, kg] of Object.entries(e.byStatus)) {
      console.log("      " + s.padEnd(28) + " " + Math.round(kg).toLocaleString().padStart(10) + " kg");
    }
  }

  // Sumário global de Mahomed
  let totalKg = 0;
  const byStatus = {};
  for (const x of matches) {
    const w = Number(x.Weight) || 0;
    totalKg += w;
    const s = String(x.StatusName || "(sem)").toUpperCase();
    byStatus[s] = (byStatus[s] || 0) + w;
  }
  console.log("\nGlobal Mahomed (todas variantes):");
  for (const [s, kg] of Object.entries(byStatus).sort((a,b)=>b[1]-a[1])) {
    console.log("  " + s.padEnd(28) + " " + Math.round(kg).toLocaleString().padStart(11) + " kg");
  }
  console.log("  ───────────────────────────────────────────────");
  const traFin = (byStatus.TRANSITO || 0) + (byStatus.FINALIZADO || 0);
  console.log("  TRA+FIN                       " + Math.round(traFin).toLocaleString().padStart(11) + " kg");
  console.log("  TOTAL (com CRIADO)            " + Math.round(totalKg).toLocaleString().padStart(11) + " kg");

  // Listagem detalhada das rows (top 20 por kg)
  console.log("\nTop 20 rows individuais (por kg desc):");
  matches.sort((a, b) => (Number(b.Weight) || 0) - (Number(a.Weight) || 0)).slice(0, 20).forEach((x) => {
    console.log("  " + (x.CreateDate || "").slice(0, 10) + "  " +
      String(x.ClientBarCode || "").padEnd(20) + "  " +
      String(x.StatusName || "").padEnd(12) + "  " +
      Math.round(Number(x.Weight) || 0).toLocaleString().padStart(8) + " kg  " +
      String(x.ServiceCode || "").padEnd(22) + "  " +
      "→ " + String(x.ReceiverPostalPlace || "").padEnd(14));
  });
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
