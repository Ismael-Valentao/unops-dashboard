/**
 * Parser do PDF "Guia Transporte" da ADICIONAL Logistics + AQI Casa do
 * Agricultor (concatenados num só PDF).
 *
 * Estrutura observada (por beneficiário):
 *  - 3 páginas ADICIONAL (Original / Duplicado / Triplicado)
 *  - 3 páginas AQI Guia Remessa (Original / Duplicado / Triplicado)
 *  - + 1 página de capa "ENTREGA AGREGADORA" no início
 *
 * Sequência de linhas tipica numa página ADICIONAL (após o cabeçalho):
 *   ENTREGA / ENTREGA AGREGADORA       <- tipo
 *   PROJECTO AQI-PROCUMENT EMERGEN
 *   SEEDCO                              <- origem
 *   CHIMOIO
 *   MXIXARROZKG                         <- SKU
 *   Antonio Chirrinzane                 <- destinatário
 *   Gaza                                <- província
 *   Limpopo                             <- distrito
 *   GTU98/202308349                     <- GTU (no campo Trabalho)
 *   100.00                              <- peso decimal
 *   100 DESCARTADO                      <- volumes + estado
 *   MACHAVA I (Sede)
 *   ARCINDO/878306002                   <- contacto motorista
 *   AQI-Casa do Agricultor
 *   ALG325MC/AC143MC                    <- matrícula
 *   ORIGINAL/DUPLICADO/TRIPLICADO
 *   Arroz                               <- nome do produto
 *
 * Página AQI (essencial: ADICIONAL→AQI mapping por GTU):
 *   Guia Remessa/Saida Nº GTU 98/2023 / 8349
 *   20/04/2026 2601101                  <- data + NUIT (Nº Cliente)
 */
const { PDFParse } = require("pdf-parse");

function pageType(text) {
  if (/Guia\s+Remessa\/Saida\s+N[º°]?\s+GTU/i.test(text)) return "aqi";
  if (/Guia\s*Transporte/i.test(text) && /C[oó]digo\s+Adicional/i.test(text)) return "adicional";
  return "unknown";
}

function isAggregator(text) {
  return /ENTREGA\s+AGREGADORA/i.test(text);
}

function normSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normPlate(raw) {
  if (!raw) return null;
  return String(raw).replace(/\s+/g, " ").trim().toUpperCase();
}

const PROVINCIAS = new Set([
  "Gaza", "Maputo", "Manica", "Sofala", "Tete", "Zambezia",
  "Niassa", "Cabo Delgado", "Inhambane", "Nampula",
]);

// ── Página ADICIONAL ────────────────────────────────────────
function parseAdicional(text, pageNum) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = { page: pageNum, type: "adicional", is_aggregator: isAggregator(text) };

  // 1. ADSN/ADSE code
  const cm = text.match(/(ADS[NE]\d{10,})/);
  if (cm) out.codigo = cm[1];

  // 2. Estado (em linha tipo "100 DESCARTADO" ou "30,000 TRANSITO")
  const stm = text.match(/\b(TRANSITO|FINALIZADO|DESCARTADO|CRIADO)\b/);
  out.estado = stm ? stm[1] : null;

  // 3. Matrícula — formato XX...MC/AB...MC ou só XX...MC
  const mp = text.match(/\b([A-Z]{2,3}\s?\d{2,4}\s?[A-Z]{2}(?:\/[A-Z]{2}\d{2,4}[A-Z]{2})?)\b/);
  if (mp) out.matricula = normPlate(mp[1]);

  // 4. Sequência crítica: encontrar índice da linha do SKU.
  //    Os SKUs do projeto começam por: MXIX (sementes core), AGRI (químicos),
  //    MSEED/MSMD/MASS/MJKL/MSER/MSSL/MADSE/MSSDF/MSSDR (kits),
  //    SUSSACO (sacos), MMRMINTER (marmite), SEEDARROZ.
  //    Padrão restritivo: começa por estes prefixos + tudo MAIÚSCULAS + ≥6 chars.
  const SKU_PREFIX = /^(MXIX|AGRI|MSEED|MSMD|MASS|MJKL|MSER|MSSL|MADSE|MSSDF|MSSDR|MSSAM|MSDA|MMRMINTER|SUSSACO|SEEDARROZ)/;
  let skuIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!/^[A-Z]{4,}[A-Z0-9]{1,}$/.test(ln)) continue;
    if (!SKU_PREFIX.test(ln)) continue;
    skuIdx = i; break;
  }
  if (skuIdx >= 0) {
    out.sku = lines[skuIdx];
    // 5. Linha seguinte = destinatário
    if (lines[skuIdx + 1]) out.destinatario = lines[skuIdx + 1];
    // 6. Provincia (próxima conhecida)
    for (let j = skuIdx + 2; j < Math.min(skuIdx + 6, lines.length); j++) {
      if (PROVINCIAS.has(lines[j])) {
        out.provincia = lines[j];
        if (lines[j + 1] && !/^GTU|^\d|^MACHAVA/.test(lines[j + 1])) {
          out.distrito = lines[j + 1];
        }
        break;
      }
    }
    // 7. GTU — procurar nas próximas ~10 linhas
    for (let j = skuIdx + 2; j < Math.min(skuIdx + 12, lines.length); j++) {
      const gm = lines[j].match(/^(GTU\d+\/\d+)$/);
      if (gm) { out.gtu = gm[1]; break; }
    }
    // 8. Qty: a linha que vem logo após o GTU é o peso (ex "100.00" ou "6,750.00").
    //    Aceitamos também separador de milhar com vírgula.
    for (let j = skuIdx + 2; j < Math.min(skuIdx + 14, lines.length); j++) {
      const qm = lines[j].match(/^([\d,]+(?:\.\d+)?)\s*$/);
      if (qm) {
        const n = Number(qm[1].replace(/,/g, ""));
        if (n > 0) { out.qty = n; break; }
      }
    }
  }
  // Fallback adicional: linha "MXIXARROZKG ARROZ KG 6750" (no fim da página, sem decimais)
  if (!out.qty && out.sku) {
    const re = new RegExp(out.sku + "\\s+[A-Z][A-Z ]*\\s+([\\d,]+)\\b");
    const m = text.match(re);
    if (m) out.qty = Number(m[1].replace(/,/g, ""));
  }

  // 9. SKU label (tipo "ARROZ KG") - fallback útil para display
  const sklM = text.match(new RegExp("(?:^|\\n)" + (out.sku || "[A-Z]{6,}") + "\\s+([A-Z][A-Z ]+?)(?=\\s*\\d|\\n)", "m"));
  if (sklM) out.sku_label = normSpaces(sklM[1]);

  return out;
}

// ── Página AQI (extrai apenas GTU + NUIT, suficiente para o merge) ─
function parseAQI(text, pageNum) {
  const out = { page: pageNum, type: "aqi" };

  const gtuM = text.match(/N[º°]?\s*GTU\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/i);
  if (gtuM) {
    out.gtu = `GTU${gtuM[1]}/${gtuM[2]}${gtuM[3].padStart(5, "0")}`;
    out.gtu_human = `GTU ${gtuM[1]}/${gtuM[2]}/${gtuM[3]}`;
  }

  // NUIT (Nº Cliente, 7 dígitos começando por 26 — pattern observado)
  const nm = text.match(/\b(26\d{5})\b/);
  if (nm) out.nuit = nm[1];

  // Destinatário: na linha após "Exmo.(s) Sr.(s)"  ou heurística
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (/Exmo[.\s]*\([sS]\)\s*Sr/i.test(lines[i])) {
      // Pode ser este nome ou na linha seguinte
      const candidate = lines[i].replace(/.*Exmo[.\s]*\([sS]\)\s*Sr\.?\s*\([sS]\)\s*/i, "").trim();
      if (candidate && /[a-z]/.test(candidate) && candidate.length > 2 && candidate.length < 80) {
        out.destinatario = candidate;
        break;
      }
      if (lines[i + 1] && /[a-zà-ÿ]/.test(lines[i + 1]) && lines[i + 1].length < 80) {
        out.destinatario = lines[i + 1];
        break;
      }
    }
  }

  return out;
}

// ── Fluxo principal ─────────────────────────────────────────
async function parseGuia(buffer) {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  const pages = result.pages || [];

  const adicionalRecords = [];
  const aqiRecords = [];
  let aggregator = null;

  for (let i = 0; i < pages.length; i++) {
    const text = pages[i].text || "";
    const num = pages[i].num || (i + 1);
    const type = pageType(text);
    if (type === "adicional") {
      const p = parseAdicional(text, num);
      if (p.is_aggregator && !aggregator) aggregator = p;
      else if (!p.is_aggregator) adicionalRecords.push(p);
    } else if (type === "aqi") {
      aqiRecords.push(parseAQI(text, num));
    }
  }

  // Dedup ADICIONAL by ADSN
  const adsnMap = new Map();
  adicionalRecords.forEach((p) => {
    if (p.codigo && !adsnMap.has(p.codigo)) adsnMap.set(p.codigo, p);
  });
  // Dedup AQI by GTU
  const gtuToNuit = new Map();
  aqiRecords.forEach((p) => {
    if (p.gtu && p.nuit && !gtuToNuit.has(p.gtu)) gtuToNuit.set(p.gtu, p.nuit);
  });

  // Merge: cada ADICIONAL (que já tem GTU) procura o NUIT na map de AQI
  const deliveries = [];
  for (const ad of adsnMap.values()) {
    deliveries.push({
      adsn: ad.codigo,
      gtu: ad.gtu || null,
      nuit: (ad.gtu && gtuToNuit.get(ad.gtu)) || null,
      matricula: ad.matricula,
      destinatario: ad.destinatario || null,
      provincia: ad.provincia || null,
      distrito: ad.distrito || null,
      sku: ad.sku || null,
      sku_label: ad.sku_label || null,
      qty: ad.qty || null,
      estado: ad.estado,
      page_adicional: ad.page,
    });
  }

  return {
    aggregator: aggregator ? {
      adse: aggregator.codigo,
      matricula: aggregator.matricula,
      destinatario: aggregator.destinatario,
      provincia: aggregator.provincia,
      distrito: aggregator.distrito,
      sku: aggregator.sku,
      qty: aggregator.qty,
      estado: aggregator.estado,
    } : null,
    deliveries,
    stats: {
      total_pages: pages.length,
      adicional_pages: adicionalRecords.length,
      aqi_pages: aqiRecords.length,
      unique_adsn: adsnMap.size,
      unique_gtu: gtuToNuit.size,
      with_gtu: deliveries.filter((d) => d.gtu).length,
      with_nuit: deliveries.filter((d) => d.nuit).length,
      with_qty: deliveries.filter((d) => d.qty).length,
      with_destinatario: deliveries.filter((d) => d.destinatario).length,
    },
  };
}

module.exports = { parseGuia };
