/**
 * AQI Dashboard – Professional Excel Export Engine
 * Uses exceljs for full styling, colours, and formatting.
 */
const ExcelJS = require("exceljs");

// ── Colour Palette ────────────────────────────────────────────
const C = {
  brand:      "0F4C75",
  brandDark:  "0A3250",
  accent:     "1B7A5A",
  white:      "FFFFFF",
  lightGray:  "F8FAFC",
  headerBg:   "0F4C75",
  headerBg2:  "1B7A5A",
  colHeadBg:  "E2E8F0",
  colHeadTx:  "334155",
  border:     "CBD5E1",
  green:      "DCFCE7",
  greenTx:    "166534",
  amber:      "FEF3C7",
  amberTx:    "92400E",
  red:        "FEF2F2",
  redTx:      "DC2626",
  summaryBg:  "F0F9FF",
  zebraBg:    "F8FAFC",
};

const THIN_BORDER = {
  top:    { style: "thin", color: { argb: C.border } },
  bottom: { style: "thin", color: { argb: C.border } },
  left:   { style: "thin", color: { argb: C.border } },
  right:  { style: "thin", color: { argb: C.border } },
};

// ── Timestamp ─────────────────────────────────────────────────
function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return {
    display: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    file: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`,
  };
}

// ── Style a status cell ───────────────────────────────────────
function styleStatusCell(cell, value) {
  const v = (value || "").trim();
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.font = { bold: true, size: 9 };
  if (v === "Verified") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.green } };
    cell.font.color = { argb: C.greenTx };
  } else if (v === "Pending Verification") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.amber } };
    cell.font.color = { argb: C.amberTx };
  } else if (v === "#ERROR!") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.red } };
    cell.font.color = { argb: C.redTx };
  } else if (v === "Completo") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.green } };
    cell.font.color = { argb: C.greenTx };
  } else if (v === "Em progresso") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.amber } };
    cell.font.color = { argb: C.amberTx };
  } else if (v === "Sem entregas") {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.red } };
    cell.font.color = { argb: C.redTx };
  }
}

// ── Build a professional sheet ────────────────────────────────
function addSheet(wb, opts) {
  const {
    name,
    title,
    headers,       // [{label, key, width?, type?, statusCol?}]
    rows,          // array of objects or arrays
    summary,       // [{label, value, color?}] optional summary cards
    ts,
  } = opts;

  const ws = wb.addWorksheet(name, {
    properties: { defaultRowHeight: 18 },
    views: [{ state: "frozen", ySplit: summary ? 5 + (summary.length > 0 ? 1 : 0) : 5, xSplit: 0 }],
  });

  const colCount = headers.length;
  let currentRow = 1;

  // ── Title row ──────────────────────────────────────────────
  ws.mergeCells(currentRow, 1, currentRow, colCount);
  const titleCell = ws.getCell(currentRow, 1);
  titleCell.value = title || name;
  titleCell.font = { bold: true, size: 14, color: { argb: C.white } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.headerBg } };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(currentRow).height = 32;
  // Fill remaining cells in merged row for background
  for (let c = 2; c <= colCount; c++) {
    ws.getCell(currentRow, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.headerBg } };
  }
  currentRow++;

  // ── Subtitle / date row ────────────────────────────────────
  ws.mergeCells(currentRow, 1, currentRow, colCount);
  const dateCell = ws.getCell(currentRow, 1);
  dateCell.value = "Exportado em: " + ts.display + "   |   Total de registos: " + rows.length;
  dateCell.font = { size: 10, italic: true, color: { argb: C.white } };
  dateCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.accent } };
  dateCell.alignment = { horizontal: "left", vertical: "middle" };
  ws.getRow(currentRow).height = 22;
  for (let c = 2; c <= colCount; c++) {
    ws.getCell(currentRow, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.accent } };
  }
  currentRow++;

  // ── Summary cards row (optional) ───────────────────────────
  if (summary && summary.length > 0) {
    currentRow++; // blank spacer
    const sumRow = ws.getRow(currentRow);
    sumRow.height = 26;
    let col = 1;
    summary.forEach((s) => {
      const cell = ws.getCell(currentRow, col);
      cell.value = `${s.label}: ${s.value}`;
      cell.font = { bold: true, size: 10, color: { argb: s.color || C.brand } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.summaryBg } };
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      col++;
    });
    currentRow++;
  }

  currentRow++; // blank spacer

  // ── Column headers ─────────────────────────────────────────
  const headerRow = currentRow;
  ws.getRow(headerRow).height = 24;
  headers.forEach((h, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = h.label;
    cell.font = { bold: true, size: 9, color: { argb: C.colHeadTx } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.colHeadBg } };
    cell.alignment = { horizontal: h.type === "number" ? "right" : "left", vertical: "middle", wrapText: true };
    cell.border = {
      top:    { style: "thin", color: { argb: C.border } },
      bottom: { style: "medium", color: { argb: C.brand } },
      left:   { style: "thin", color: { argb: C.border } },
      right:  { style: "thin", color: { argb: C.border } },
    };
  });

  // Auto-filter
  ws.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: headerRow, column: colCount },
  };

  // Freeze panes
  ws.views = [{ state: "frozen", ySplit: headerRow, xSplit: 0 }];

  currentRow++;

  // ── Data rows ──────────────────────────────────────────────
  rows.forEach((row, rowIdx) => {
    const r = currentRow + rowIdx;
    const excelRow = ws.getRow(r);
    excelRow.height = 18;
    const isZebra = rowIdx % 2 === 1;

    headers.forEach((h, colIdx) => {
      const cell = ws.getCell(r, colIdx + 1);
      const val = Array.isArray(row) ? row[colIdx] : row[h.key];
      cell.value = val ?? "";
      cell.font = { size: 9, color: { argb: "1E293B" } };
      cell.border = THIN_BORDER;

      if (h.type === "number") {
        cell.value = Number(val) || 0;
        cell.numFmt = "#,##0.0";
        cell.alignment = { horizontal: "right", vertical: "middle" };
      } else if (h.type === "integer") {
        cell.value = Number(val) || 0;
        cell.numFmt = "#,##0";
        cell.alignment = { horizontal: "right", vertical: "middle" };
      } else {
        cell.alignment = { horizontal: "left", vertical: "middle" };
      }

      // Status column styling
      if (h.statusCol) {
        styleStatusCell(cell, String(val));
      }

      // Difference column (positive = amber, negative = red)
      if (h.diffCol) {
        const n = Number(val) || 0;
        cell.numFmt = "+#,##0.0;-#,##0.0;0";
        cell.alignment = { horizontal: "right", vertical: "middle" };
        if (n > 0) {
          cell.font = { bold: true, size: 9, color: { argb: C.amberTx } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.amber } };
        } else if (n < 0) {
          cell.font = { bold: true, size: 9, color: { argb: C.redTx } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.red } };
        }
      }

      // Zebra
      if (isZebra && !h.statusCol && !h.diffCol) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.zebraBg } };
      }

      // Highlight duplicate marker
      if (h.dupMarker && String(val).includes("duplicado")) {
        cell.font = { size: 9, italic: true, color: { argb: "94A3B8" } };
      }
    });
  });

  // ── Column widths ──────────────────────────────────────────
  headers.forEach((h, i) => {
    if (h.width) {
      ws.getColumn(i + 1).width = h.width;
    } else {
      let max = h.label.length;
      rows.forEach((row) => {
        const val = Array.isArray(row) ? row[i] : row[h.key];
        const len = String(val ?? "").length;
        if (len > max) max = len;
      });
      ws.getColumn(i + 1).width = Math.min(max + 4, 45);
    }
  });

  return ws;
}

// ── Export: Tabela principal ──────────────────────────────────
async function exportTabela(cacheData, columns) {
  const ts = getTimestamp();
  const rows = cacheData;

  const cols = columns && columns.length ? columns : [
    { key: "delivery_id", label: "Delivery ID" },
    { key: "delivery_note_number", label: "GTU" },
    { key: "beneficiary_name", label: "Beneficiario" },
    { key: "province", label: "Provincia" },
    { key: "district", label: "Distrito" },
    { key: "product", label: "Produto" },
    { key: "delivered_qty", label: "Qtd. Entregue" },
    { key: "packages", label: "Pacotes" },
    { key: "delivery_date", label: "Data Entrega" },
    { key: "submitted_by", label: "Submetido por" },
    { key: "verification_status", label: "Estado" },
  ];

  const numCols = ["delivered_qty", "packages"];
  const headers = cols.map((c) => ({
    label: c.label,
    key: c.key,
    type: numCols.includes(c.key) ? "number" : "text",
    statusCol: c.key === "verification_status",
  }));

  const verified = rows.filter((r) => r.verification_status === "Verified").length;
  const pending = rows.filter((r) => r.verification_status === "Pending Verification").length;
  const errors = rows.filter((r) => r.verification_status === "#ERROR!").length;

  const wb = new ExcelJS.Workbook();
  wb.creator = "AQI Dashboard";

  addSheet(wb, {
    name: "Entregas",
    title: "AQI Control File 2026 - Registos de Entregas",
    headers,
    rows,
    summary: [
      { label: "Total", value: rows.length, color: C.brand },
      { label: "Verified", value: verified, color: C.greenTx },
      { label: "Pending", value: pending, color: C.amberTx },
      { label: "Erro", value: errors, color: C.redTx },
    ],
    ts,
  });

  const buf = await wb.xlsx.writeBuffer();
  return { buf, filename: `Entregas_AQI_${ts.file}.xlsx` };
}

// ── Export: Duplicados ────────────────────────────────────────
async function exportDuplicados(cacheData) {
  const ts = getTimestamp();
  const gtuMap = {};
  cacheData.forEach((r) => {
    const gtu = (r.delivery_note_number || "").trim();
    if (!gtu) return;
    if (!gtuMap[gtu]) gtuMap[gtu] = [];
    gtuMap[gtu].push(r);
  });

  const dataRows = [];
  let dupCount = 0;
  for (const [gtu, entries] of Object.entries(gtuMap)) {
    if (entries.length <= 1) continue;
    dupCount++;
    entries.forEach((e, i) => {
      dataRows.push([
        i === 0 ? gtu : "  ↳ duplicado",
        i === 0 ? entries.length : "",
        e.delivery_id, e.beneficiary_name, e.district,
        e.packages, e.delivered_qty, e.verification_status,
      ]);
    });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "AQI Dashboard";

  addSheet(wb, {
    name: "GTUs Duplicados",
    title: "AQI Control File 2026 - GTUs Duplicados",
    headers: [
      { label: "GTU", dupMarker: true, width: 22 },
      { label: "Ocorrencias", type: "integer", width: 14 },
      { label: "Delivery ID", width: 14 },
      { label: "Beneficiario", width: 30 },
      { label: "Distrito", width: 16 },
      { label: "Pacotes", type: "number" },
      { label: "Qtd. Entregue", type: "number" },
      { label: "Estado", statusCol: true, width: 22 },
    ],
    rows: dataRows,
    summary: [
      { label: "GTUs duplicados", value: dupCount, color: C.redTx },
      { label: "Linhas afectadas", value: dataRows.length, color: C.amberTx },
    ],
    ts,
  });

  const buf = await wb.xlsx.writeBuffer();
  return { buf, filename: `GTUs_Duplicados_${ts.file}.xlsx` };
}

// ── Export: Discrepancias Peso ────────────────────────────────
async function exportPeso(cacheData) {
  const ts = getTimestamp();
  const UNIT = 12.5;
  const dataRows = [];
  cacheData.forEach((r) => {
    const pkgs = r.packages;
    const qty = r.delivered_qty;
    const expected = pkgs * UNIT;
    if (pkgs > 0 && Math.abs(qty - expected) > 0.01) {
      dataRows.push([
        r.delivery_note_number, r.delivery_id, r.beneficiary_name,
        r.district, pkgs, qty, expected, +(qty - expected).toFixed(2),
      ]);
    }
  });
  dataRows.sort((a, b) => Math.abs(b[7]) - Math.abs(a[7]));

  const wb = new ExcelJS.Workbook();
  wb.creator = "AQI Dashboard";

  addSheet(wb, {
    name: "Discrepancias Peso",
    title: "AQI Control File 2026 - Discrepancias de Peso (Pacotes x 12,5 kg)",
    headers: [
      { label: "GTU", width: 22 },
      { label: "Delivery ID", width: 14 },
      { label: "Beneficiario", width: 30 },
      { label: "Distrito", width: 16 },
      { label: "Pacotes", type: "number" },
      { label: "Qtd. Entregue", type: "number" },
      { label: "Esperado (x12,5)", type: "number" },
      { label: "Diferenca", type: "number", diffCol: true },
    ],
    rows: dataRows,
    summary: [
      { label: "Discrepancias", value: dataRows.length, color: C.redTx },
      { label: "Total registos", value: cacheData.length, color: C.brand },
    ],
    ts,
  });

  const buf = await wb.xlsx.writeBuffer();
  return { buf, filename: `Discrepancias_Peso_${ts.file}.xlsx` };
}

// ── Export: GTUs Fora do Padrao ───────────────────────────────
async function exportPadrao(cacheData) {
  const ts = getTimestamp();
  const GTU_PATTERN = /^GTU98\/\d{9}$/;
  const dataRows = [];
  cacheData.forEach((r) => {
    const gtu = (r.delivery_note_number || "").trim();
    if (!gtu) {
      dataRows.push(["(vazio)", r.delivery_id, r.beneficiary_name, r.district, "GTU em branco"]);
      return;
    }
    if (!GTU_PATTERN.test(gtu)) {
      let reason = "";
      if (!gtu.startsWith("GTU98/")) reason = "Prefixo incorrecto (esperado GTU98/)";
      else if (gtu.replace("GTU98/", "").length !== 9) reason = "Comprimento incorrecto (" + gtu.length + " chars, esperado 15)";
      else reason = "Caracteres invalidos";
      dataRows.push([gtu, r.delivery_id, r.beneficiary_name, r.district, reason]);
    }
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "AQI Dashboard";

  addSheet(wb, {
    name: "GTUs Fora Padrao",
    title: "AQI Control File 2026 - GTUs Fora do Padrao (esperado: GTU98/XXXXXXXXX)",
    headers: [
      { label: "GTU Actual", width: 24 },
      { label: "Delivery ID", width: 14 },
      { label: "Beneficiario", width: 30 },
      { label: "Distrito", width: 16 },
      { label: "Motivo", width: 40 },
    ],
    rows: dataRows,
    summary: [
      { label: "GTUs invalidos", value: dataRows.length, color: C.redTx },
      { label: "Total registos", value: cacheData.length, color: C.brand },
    ],
    ts,
  });

  const buf = await wb.xlsx.writeBuffer();
  return { buf, filename: `GTUs_Fora_Padrao_${ts.file}.xlsx` };
}

// ── Export: Relatorio Completo ────────────────────────────────
async function exportRelatorioCompleto(cacheData) {
  const ts = getTimestamp();
  const rows = cacheData;
  const UNIT = 12.5;
  const GTU_PATTERN = /^GTU98\/\d{9}$/;

  const verified = rows.filter((r) => r.verification_status === "Verified").length;
  const pending = rows.filter((r) => r.verification_status === "Pending Verification").length;
  const errors = rows.filter((r) => r.verification_status === "#ERROR!").length;

  const wb = new ExcelJS.Workbook();
  wb.creator = "AQI Dashboard";

  // Sheet 1: All data
  const allKeys = [
    "delivery_id", "delivery_note_number", "supplier", "province", "district",
    "beneficiary_id", "beneficiary_name", "product", "product_unit",
    "delivered_qty", "packages", "delivery_date", "submission_date",
    "submitted_by", "verification_status", "phone", "phone_alt", "is_locked",
  ];
  const allHeaders = [
    { label: "Delivery ID", key: "delivery_id", width: 14 },
    { label: "GTU", key: "delivery_note_number", width: 22 },
    { label: "Fornecedor", key: "supplier", width: 14 },
    { label: "Provincia", key: "province", width: 14 },
    { label: "Distrito", key: "district", width: 16 },
    { label: "Benef. ID", key: "beneficiary_id", width: 14 },
    { label: "Beneficiario", key: "beneficiary_name", width: 30 },
    { label: "Produto", key: "product", width: 22 },
    { label: "Unidade", key: "product_unit", width: 10 },
    { label: "Qtd. Entregue", key: "delivered_qty", type: "number" },
    { label: "Pacotes", key: "packages", type: "number" },
    { label: "Data Entrega", key: "delivery_date", width: 14 },
    { label: "Data Submissao", key: "submission_date", width: 14 },
    { label: "Submetido por", key: "submitted_by", width: 30 },
    { label: "Estado", key: "verification_status", statusCol: true, width: 22 },
    { label: "Telefone", key: "phone", width: 15 },
    { label: "Tel. Alt", key: "phone_alt", width: 15 },
    { label: "Bloqueado", key: "is_locked", width: 12 },
  ];

  addSheet(wb, {
    name: "Todos os Dados",
    title: "AQI Control File 2026 - Todos os Dados",
    headers: allHeaders,
    rows,
    summary: [
      { label: "Total", value: rows.length, color: C.brand },
      { label: "Verified", value: verified, color: C.greenTx },
      { label: "Pending", value: pending, color: C.amberTx },
      { label: "Erro", value: errors, color: C.redTx },
    ],
    ts,
  });

  // Sheet 2: Duplicates
  const gtuMap = {};
  rows.forEach((r) => { const g = (r.delivery_note_number || "").trim(); if (g) { if (!gtuMap[g]) gtuMap[g] = []; gtuMap[g].push(r); } });
  const dupRows = [];
  let dupCount = 0;
  for (const [gtu, entries] of Object.entries(gtuMap)) {
    if (entries.length <= 1) continue;
    dupCount++;
    entries.forEach((e, i) => dupRows.push([
      i === 0 ? gtu : "  ↳ duplicado", i === 0 ? entries.length : "",
      e.delivery_id, e.beneficiary_name, e.district,
      e.packages, e.delivered_qty, e.verification_status,
    ]));
  }
  addSheet(wb, {
    name: "GTUs Duplicados",
    title: "AQI Control File 2026 - GTUs Duplicados",
    headers: [
      { label: "GTU", dupMarker: true, width: 22 },
      { label: "Ocorrencias", type: "integer", width: 14 },
      { label: "Delivery ID", width: 14 },
      { label: "Beneficiario", width: 30 },
      { label: "Distrito", width: 16 },
      { label: "Pacotes", type: "number" },
      { label: "Qtd. Entregue", type: "number" },
      { label: "Estado", statusCol: true, width: 22 },
    ],
    rows: dupRows,
    summary: [
      { label: "GTUs duplicados", value: dupCount, color: C.redTx },
      { label: "Linhas afectadas", value: dupRows.length, color: C.amberTx },
    ],
    ts,
  });

  // Sheet 3: Weight
  const wRows = [];
  rows.forEach((r) => {
    const exp = r.packages * UNIT;
    if (r.packages > 0 && Math.abs(r.delivered_qty - exp) > 0.01)
      wRows.push([r.delivery_note_number, r.delivery_id, r.beneficiary_name, r.district, r.packages, r.delivered_qty, exp, +(r.delivered_qty - exp).toFixed(2)]);
  });
  wRows.sort((a, b) => Math.abs(b[7]) - Math.abs(a[7]));
  addSheet(wb, {
    name: "Discrepancias Peso",
    title: "AQI Control File 2026 - Discrepancias de Peso (Pacotes x 12,5 kg)",
    headers: [
      { label: "GTU", width: 22 },
      { label: "Delivery ID", width: 14 },
      { label: "Beneficiario", width: 30 },
      { label: "Distrito", width: 16 },
      { label: "Pacotes", type: "number" },
      { label: "Qtd. Entregue", type: "number" },
      { label: "Esperado (x12,5)", type: "number" },
      { label: "Diferenca", type: "number", diffCol: true },
    ],
    rows: wRows,
    summary: [
      { label: "Discrepancias", value: wRows.length, color: C.redTx },
      { label: "Total registos", value: rows.length, color: C.brand },
    ],
    ts,
  });

  // Sheet 4: Pattern
  const pRows = [];
  rows.forEach((r) => {
    const g = (r.delivery_note_number || "").trim();
    if (!g) { pRows.push(["(vazio)", r.delivery_id, r.beneficiary_name, r.district, "GTU em branco"]); return; }
    if (!GTU_PATTERN.test(g)) {
      let reason = !g.startsWith("GTU98/") ? "Prefixo incorrecto" : "Comprimento incorrecto (" + g.length + " chars)";
      pRows.push([g, r.delivery_id, r.beneficiary_name, r.district, reason]);
    }
  });
  addSheet(wb, {
    name: "GTUs Fora Padrao",
    title: "AQI Control File 2026 - GTUs Fora do Padrao",
    headers: [
      { label: "GTU Actual", width: 24 },
      { label: "Delivery ID", width: 14 },
      { label: "Beneficiario", width: 30 },
      { label: "Distrito", width: 16 },
      { label: "Motivo", width: 40 },
    ],
    rows: pRows,
    summary: [
      { label: "GTUs invalidos", value: pRows.length, color: C.redTx },
      { label: "Total registos", value: rows.length, color: C.brand },
    ],
    ts,
  });

  const buf = await wb.xlsx.writeBuffer();
  return { buf, filename: `Relatorio_Completo_AQI_${ts.file}.xlsx` };
}

// ── Export: Planeado vs Entregue ──────────────────────────────
async function exportPlaneadoVsEntregue(comparison) {
  const ts = getTimestamp();
  const wb = new ExcelJS.Workbook();
  wb.creator = "AQI Dashboard";

  // Sheet 1: By District
  addSheet(wb, {
    name: "Por Distrito",
    title: "AQI Control File 2026 - Planeado vs Entregue por Distrito",
    headers: [
      { label: "Distrito", width: 20 },
      { label: "Provincia", width: 16 },
      { label: "Planeado (kg)", type: "number", width: 16 },
      { label: "Entregue (kg)", type: "number", width: 16 },
      { label: "Diferenca (kg)", type: "number", diffCol: true, width: 16 },
      { label: "% Execucao", type: "number", width: 14 },
      { label: "Status", statusCol: true, width: 18 },
    ],
    rows: comparison.by_district.map((r) => [
      r.district, r.province, r.planned_kg, r.delivered_kg, r.diff, r.pct, r.status,
    ]),
    summary: [
      { label: "Total Planeado (kg)", value: Math.round(comparison.totals.planned_kg).toLocaleString(), color: C.brand },
      { label: "Total Entregue (kg)", value: Math.round(comparison.totals.delivered_kg).toLocaleString(), color: C.accent },
      { label: "Taxa Execucao", value: comparison.totals.pct + "%", color: comparison.totals.pct >= 95 ? C.greenTx : comparison.totals.pct > 0 ? C.amberTx : C.redTx },
    ],
    ts,
  });

  // Sheet 2: By Product
  addSheet(wb, {
    name: "Por Produto",
    title: "AQI Control File 2026 - Planeado vs Entregue por Produto",
    headers: [
      { label: "Produto", width: 22 },
      { label: "Produto (Delivery)", width: 22 },
      { label: "Planeado (kg)", type: "number", width: 16 },
      { label: "Entregue (kg)", type: "number", width: 16 },
      { label: "Diferenca (kg)", type: "number", diffCol: true, width: 16 },
      { label: "% Execucao", type: "number", width: 14 },
      { label: "Status", statusCol: true, width: 18 },
    ],
    rows: comparison.by_product.map((r) => [
      r.product, r.product_delivery, r.planned_kg, r.delivered_kg, r.diff, r.pct, r.status,
    ]),
    summary: [
      { label: "Produtos", value: comparison.by_product.length, color: C.brand },
    ],
    ts,
  });

  // Sheet 3: Full Detail
  addSheet(wb, {
    name: "Detalhe Completo",
    title: "AQI Control File 2026 - Planeado vs Entregue (Detalhe por Distrito e Produto)",
    headers: [
      { label: "Distrito", width: 20 },
      { label: "Provincia", width: 16 },
      { label: "Produto", width: 20 },
      { label: "Planeado (kg)", type: "number", width: 16 },
      { label: "Entregue (kg)", type: "number", width: 16 },
      { label: "Diferenca (kg)", type: "number", diffCol: true, width: 16 },
      { label: "% Execucao", type: "number", width: 14 },
      { label: "Status", statusCol: true, width: 18 },
    ],
    rows: comparison.details.map((r) => [
      r.district, r.province, r.product, r.planned_kg, r.delivered_kg, r.diff, r.pct, r.status,
    ]),
    summary: [
      { label: "Total linhas", value: comparison.details.length, color: C.brand },
      { label: "Taxa Global", value: comparison.totals.pct + "%", color: comparison.totals.pct >= 95 ? C.greenTx : C.amberTx },
    ],
    ts,
  });

  const buf = await wb.xlsx.writeBuffer();
  return { buf, filename: `Planeado_vs_Entregue_${ts.file}.xlsx` };
}

module.exports = {
  exportTabela,
  exportDuplicados,
  exportPeso,
  exportPadrao,
  exportRelatorioCompleto,
  exportPlaneadoVsEntregue,
};
