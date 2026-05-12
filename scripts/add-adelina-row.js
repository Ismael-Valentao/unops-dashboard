// Adiciona a linha SUSSACO em falta para 0402-0015 Adelina Massora (Buzi)
// no ficheiro data/Planeamento_Actualizado.xlsx, sheet "Planeamento Adicional".
//
// Estratégia: copia a row 197 (SUSSACO do Alberto Marceta) como template,
// ajusta extensionist_id, nome, contacto, posto e quantidade (8980 un).
// Mantém os formulas e formatação intactos.
const path = require("path");
const ExcelJS = require("exceljs");

const FILE = path.join(__dirname, "..", "data", "Planeamento_Actualizado.xlsx");
const SHEET = "Planeamento Adicional";

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.getWorksheet(SHEET);

  // 1. Verifica se já existe alguma row SUSSACO para 0402-0015 (defensivo)
  for (let r = 2; r <= ws.actualRowCount; r++) {
    const ext = String(ws.getRow(r).getCell(61).value || "").trim();
    const art = String(ws.getRow(r).getCell(19).value || "").trim();
    if (ext === "0402-0015" && art === "SUSSACO") {
      console.log("Já existe SUSSACO para 0402-0015 na row", r, "— a abortar para não duplicar.");
      process.exit(0);
    }
  }

  // 2. Encontra a row template (Alberto Marceta SUSSACO)
  let templateRow = null;
  for (let r = 2; r <= ws.actualRowCount; r++) {
    const ext = String(ws.getRow(r).getCell(61).value || "").trim();
    const art = String(ws.getRow(r).getCell(19).value || "").trim();
    if (ext === "0402-0002" && art === "SUSSACO") {
      templateRow = r;
      break;
    }
  }
  if (!templateRow) {
    console.error("Template (0402-0002 SUSSACO) não encontrado!");
    process.exit(1);
  }
  console.log("Template row:", templateRow);

  // 3. Adiciona nova row no fim copiando os valores da template
  const newRowNum = ws.actualRowCount + 1;
  const tpl = ws.getRow(templateRow);
  const newRow = ws.getRow(newRowNum);

  // Copia todos os 61 campos do template
  for (let c = 1; c <= 61; c++) {
    const tplCell = tpl.getCell(c);
    const newCell = newRow.getCell(c);
    // value (sem fórmulas; pegamos no resultado calculado)
    let v = tplCell.value;
    if (v && typeof v === "object" && v.result != null) v = v.result;
    newCell.value = v;
    // Style (font, fill, border, alignment, numFmt)
    if (tplCell.style) newCell.style = { ...tplCell.style };
  }

  // 4. Aplica os ajustes da Adelina (449 kits Kit 1, Buzi/Inharongue)
  //    Refª colunas: 7=Peso, 8=QtdAct, 9=NovaQtd, 12=Qtdkit1, 21=NUITorigem,
  //    23=NUITdest, 24=NomeDest, 27=Posto, 31=Extensionista, 32=Contact,
  //    33=Supervisor, 34=SupContact, 52=Var, 55=QtdCriado, 56=QTDENTREG, 61=ExtID
  const SACOS = 8980; // = 449 × 20
  // Ratio peso/qty do Alberto: 3740/6800 = 0.55 (uso para preservar consistência da coluna Peso)
  const PESO_RATIO = 3740 / 6800;
  const peso = Math.round(SACOS * PESO_RATIO * 100) / 100;

  newRow.getCell(7).value  = peso;                  // Peso do Volume Kg
  newRow.getCell(8).value  = SACOS;                 // Qtd Actualizada (FONTE DE VERDADE)
  newRow.getCell(9).value  = SACOS;                 // NOVA QUANTIDADE A ENTREGAR
  newRow.getCell(23).value = null;                  // Cod Destino NUIT (não tenho — deixar vazio)
  newRow.getCell(24).value = "Adelina Massora";     // Nome Destino
  newRow.getCell(27).value = "Inharongue";          // Posto Administrativo
  newRow.getCell(31).value = "Adelina Massora";     // Nome do Extensionista
  newRow.getCell(32).value = "867878815";           // Contacto
  newRow.getCell(33).value = "Ayrton Mael";         // Supervisor
  newRow.getCell(34).value = 879095867;             // Supervisor Contact
  newRow.getCell(52).value = peso - SACOS;          // Var (peso - qty)
  newRow.getCell(53).value = null;                  // QtdEntregue
  newRow.getCell(54).value = null;                  // QtdTransito
  newRow.getCell(55).value = null;                  // QtdCriado
  newRow.getCell(56).value = 0;                     // QUANTIDADE ENTREGUE
  newRow.getCell(57).value = -SACOS;                // QUANTIDADE ENTREGUE +/-
  newRow.getCell(58).value = "Sem registo";         // Estado Entrega
  newRow.getCell(60).value = null;                  // VAR
  newRow.getCell(61).value = "0402-0015";           // Extensionist_ID

  newRow.commit();

  // 5. Salva o ficheiro
  await wb.xlsx.writeFile(FILE);
  console.log("✓ Linha", newRowNum, "adicionada com sucesso.");
  console.log("  Ext ID: 0402-0015 · Adelina Massora · Buzi/Inharongue");
  console.log("  Artigo: SUSSACO · Qtd: " + SACOS + " un · Peso: " + peso);
})();
