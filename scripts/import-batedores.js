// Importa C:/Users/Ismael Chiziane/Downloads/Batedores.xlsx → tabela `batedores`.
// Colunas esperadas: #, Nome, Contacto, Email (1 row por batedor).
// Idempotente: UPSERT por email.
const path = require("path");
const ExcelJS = require("exceljs");

const FILE = process.argv[2] || "C:/Users/Ismael Chiziane/Downloads/Batedores.xlsx";

(async () => {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  const { query } = require("../db/mysql");

  // Garante migração do schema (chama o módulo se ainda não foi inicializado)
  // — quando rodado standalone, o pool inicia sem a tabela; força a migração.
  try { await require("../db/mysql").migrate?.(); } catch { /* ok */ }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.worksheets[0];

  let processed = 0, inserted = 0, updated = 0, skipped = 0;
  const errors = [];

  for (let r = 2; r <= ws.actualRowCount; r++) {
    const row = ws.getRow(r);
    const name = String(row.getCell(2).value || "").trim();
    let contact = row.getCell(3).value;
    if (contact && typeof contact === "object" && contact.text) contact = contact.text;
    contact = String(contact || "").trim();
    let email = row.getCell(4).value;
    if (email && typeof email === "object" && email.text) email = email.text;
    email = String(email || "").trim().toLowerCase();
    let contactAlt = row.getCell(5).value;
    if (contactAlt && typeof contactAlt === "object" && contactAlt.text) contactAlt = contactAlt.text;
    contactAlt = String(contactAlt || "").trim() || null;

    if (!email || !name) { skipped++; continue; }
    processed++;

    try {
      // Verifica se já existe
      const existing = await query("SELECT email FROM batedores WHERE email = ?", [email]);
      if (existing.length) {
        await query(
          "UPDATE batedores SET name = ?, contact = ?, contact_alt = ? WHERE email = ?",
          [name, contact || null, contactAlt, email]
        );
        updated++;
      } else {
        await query(
          "INSERT INTO batedores (email, name, contact, contact_alt) VALUES (?, ?, ?, ?)",
          [email, name, contact || null, contactAlt]
        );
        inserted++;
      }
    } catch (e) {
      errors.push({ email, error: e.message });
    }
  }

  console.log("=== Import resultado ===");
  console.log("  Processadas:", processed);
  console.log("  Inseridas: ", inserted);
  console.log("  Actualizadas:", updated);
  console.log("  Skipped:    ", skipped);
  if (errors.length) {
    console.log("  Erros:", errors.length);
    errors.forEach((e) => console.log("    ", e.email, "→", e.error));
  }

  // Mostra os primeiros 5 da tabela final
  const sample = await query("SELECT email, name, contact FROM batedores ORDER BY name LIMIT 5");
  console.log();
  console.log("=== Primeiras 5 entries em batedores ===");
  sample.forEach((b) => console.log("  ", b.name.padEnd(35), "·", b.email.padEnd(40), "·", b.contact || "—"));

  process.exit(0);
})();
