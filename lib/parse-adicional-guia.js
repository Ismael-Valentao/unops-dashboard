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

// Detecta a cópia (ORIGINAL / DUPLICADO / TRIPLICADO) do documento.
// É escrita no cabeçalho da página em ambos os lados (ADICIONAL e AQI).
function detectCopy(text) {
  const m = text.match(/\b(ORIGINAL|DUPLICADO|TRIPLICADO)\b/);
  return m ? m[1] : null;
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
  const out = {
    page: pageNum,
    type: "adicional",
    is_aggregator: isAggregator(text),
    copy: detectCopy(text),
  };

  // 1. Código (ADSN para entregas reais, ADSE para a capa agregadora).
  //    Distinção explícita — o ADSE NUNCA pode ser tratado como ADSN.
  const cm = text.match(/(ADS[NE]\d{10,})/);
  if (cm) {
    out.codigo = cm[1];
    out.codigo_kind = cm[1].startsWith("ADSE") ? "ADSE" : "ADSN";
  }

  // 2. Estado (em linha tipo "100 DESCARTADO" ou "30,000 TRANSITO")
  const stm = text.match(/\b(TRANSITO|FINALIZADO|DESCARTADO|CRIADO)\b/);
  out.estado = stm ? stm[1] : null;

  // 3. Matrícula — duas estratégias (em ordem):
  //    a) Linha imediatamente após "AQI-Casa do Agricultor" (mais fiável,
  //       captura formatos especiais como "MLZ 11-01//" ou "CAM-59")
  //    b) Regex de matrícula tradicional XX 000 XX/AB000XX (fallback)
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^AQI-?Casa do Agricultor$/i.test(lines[i])) {
      const candidate = lines[i + 1];
      // Aceita qualquer linha curta que NÃO seja palavra-chave conhecida
      if (candidate && candidate.length < 30 &&
          !/^(ORIGINAL|DUPLICADO|TRIPLICADO|Milho|Arroz|Feij|Document|ADICIONAL)/i.test(candidate)) {
        out.matricula = normPlate(candidate);
        break;
      }
    }
  }
  if (!out.matricula) {
    const mp = text.match(/\b([A-Z]{2,3}\s?\d{2,4}\s?[A-Z]{2}(?:\/[A-Z]{2}\d{2,4}[A-Z]{2})?)\b/);
    if (mp) out.matricula = normPlate(mp[1]);
  }

  // 3b. Telefone do destinatário (não do motorista). Aparece junto à
  // palavra "Contacto" na zona do beneficiário (não confundir com o
  // "Contato:" do transportador). Heurística: número 9 dígitos imediatamente
  // antes de uma linha "Contacto" (sem 2 pontos no fim).
  for (let i = 1; i < lines.length; i++) {
    if (/^Contacto$/i.test(lines[i]) || /^Contacto:?$/i.test(lines[i])) {
      const prev = lines[i - 1];
      if (prev && /^\d{9}$/.test(prev.replace(/\s/g, ""))) {
        out.telefone_destinatario = prev.replace(/\s/g, "");
        break;
      }
    }
  }

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
    // 8. Peso (decimal) e Volumes (inteiro):
    //    - Peso: linha após GTU, formato "7,512.50" (com decimais)
    //    - Volumes: linha seguinte, formato "7,512 TRANSITO" (qty + estado)
    //    Capturamos ambos para terem campos distintos no Excel.
    for (let j = skuIdx + 2; j < Math.min(skuIdx + 14, lines.length); j++) {
      const qm = lines[j].match(/^([\d,]+(?:\.\d+)?)\s*$/);
      if (qm) {
        const n = Number(qm[1].replace(/,/g, ""));
        if (n > 0) {
          out.qty = n;
          out.peso = n;          // alias semântico
          // Tenta capturar volumes na linha seguinte ("7,512 TRANSITO")
          const next = lines[j + 1];
          if (next) {
            const vm = next.match(/^([\d,]+)\s+(?:TRANSITO|FINALIZADO|DESCARTADO|CRIADO)/);
            if (vm) out.volumes = Number(vm[1].replace(/,/g, ""));
          }
          break;
        }
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
  const out = { page: pageNum, type: "aqi", copy: detectCopy(text) };

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

  // Páginas separadas em 3 baldes:
  //   - aggregatorPages  (capa: ENTREGA AGREGADORA, código ADSE) → 1 a 3 cópias
  //   - adicionalPages   (entrega individual: ENTREGA, código ADSN) → 1 a 3 cópias por benef.
  //   - aqiPages         (Casa do Agricultor Guia Remessa: GTU)    → 1 a 3 cópias por benef.
  // Cada balde guarda TODAS as cópias para depois deduplicarmos pelo código próprio.
  const aggregatorPages = [];
  const adicionalPages = [];
  const aqiPages = [];

  for (let i = 0; i < pages.length; i++) {
    const text = pages[i].text || "";
    const num = pages[i].num || (i + 1);
    const type = pageType(text);
    if (type === "adicional") {
      const p = parseAdicional(text, num);
      if (p.is_aggregator || p.codigo_kind === "ADSE") {
        aggregatorPages.push(p);                              // capa agregadora (ADSE)
      } else if (p.codigo_kind === "ADSN") {
        adicionalPages.push(p);                               // entrega individual (ADSN)
      }
      // (sem código → página corrompida/sem dados, ignorada silenciosamente)
    } else if (type === "aqi") {
      aqiPages.push(parseAQI(text, num));
    }
  }

  // ─ Deduplicar Original/Duplicado/Triplicado pelo código ─
  // Lado ADICIONAL: 1 ADSN único pode aparecer em até 3 páginas. Ficamos com a primeira
  // ocorrência mas guardamos a lista de cópias detectadas para o relatório.
  const adsnMap = new Map();           // codigo → record (entrega individual)
  const copiesByAdsn = new Map();      // codigo → Set<copy> (ORIGINAL/DUPLICADO/TRIPLICADO)
  for (const p of adicionalPages) {
    if (!p.codigo) continue;
    if (!adsnMap.has(p.codigo)) adsnMap.set(p.codigo, p);
    if (!copiesByAdsn.has(p.codigo)) copiesByAdsn.set(p.codigo, new Set());
    if (p.copy) copiesByAdsn.get(p.codigo).add(p.copy);
  }

  // Capa: 1 ADSE único pode aparecer em até 3 páginas. Manter só a primeira.
  let aggregator = null;
  const copiesByAdse = new Map();
  for (const p of aggregatorPages) {
    if (!aggregator && p.codigo) aggregator = p;
    const key = p.codigo || "ADSE_unknown";
    if (!copiesByAdse.has(key)) copiesByAdse.set(key, new Set());
    if (p.copy) copiesByAdse.get(key).add(p.copy);
  }

  // Lado AQI: 1 GTU único pode aparecer em até 3 páginas (Original/Duplicado/Triplicado).
  // Guardamos só o GTU→NUIT mas contamos as cópias para o relatório.
  const gtuToNuit = new Map();
  const copiesByGtu = new Map();
  for (const p of aqiPages) {
    if (!p.gtu) continue;
    if (p.nuit && !gtuToNuit.has(p.gtu)) gtuToNuit.set(p.gtu, p.nuit);
    if (!copiesByGtu.has(p.gtu)) copiesByGtu.set(p.gtu, new Set());
    if (p.copy) copiesByGtu.get(p.gtu).add(p.copy);
  }

  // ─ Construir deliveries (apenas entregas individuais ADSN; nunca a capa) ─
  const deliveries = [];
  for (const ad of adsnMap.values()) {
    // Defensive: só ADSN entra em deliveries; ADSE é capa e fica fora.
    if (ad.codigo_kind !== "ADSN") continue;
    deliveries.push({
      adsn: ad.codigo,
      gtu: ad.gtu || null,
      nuit: (ad.gtu && gtuToNuit.get(ad.gtu)) || null,
      matricula: ad.matricula,
      destinatario: ad.destinatario || null,
      telefone_destinatario: ad.telefone_destinatario || null,
      provincia: ad.provincia || null,
      distrito: ad.distrito || null,
      sku: ad.sku || null,
      sku_label: ad.sku_label || null,
      qty: ad.qty || null,
      peso: ad.peso || ad.qty || null,        // peso (decimal)
      volumes: ad.volumes || null,             // volumes (inteiro) — pode faltar nalguns formatos
      estado: ad.estado,
      page_adicional: ad.page,
      copies_adicional: [...(copiesByAdsn.get(ad.codigo) || new Set())].sort(),
      copies_aqi: ad.gtu ? [...(copiesByGtu.get(ad.gtu) || new Set())].sort() : [],
    });
  }

  // Avisos para o operador: se as cópias detectadas não somam 3 em ambos os
  // lados, o PDF pode estar incompleto (e.g. faltam páginas, ou tem só Original).
  const warnings = [];
  for (const d of deliveries) {
    if (d.copies_adicional.length !== 3) {
      warnings.push({
        type: "incomplete_copies_adicional",
        adsn: d.adsn,
        found: d.copies_adicional,
        expected: ["ORIGINAL", "DUPLICADO", "TRIPLICADO"],
      });
    }
    if (d.gtu && d.copies_aqi.length !== 3) {
      warnings.push({
        type: "incomplete_copies_aqi",
        gtu: d.gtu,
        found: d.copies_aqi,
        expected: ["ORIGINAL", "DUPLICADO", "TRIPLICADO"],
      });
    }
  }

  return {
    aggregator: aggregator ? {
      adse: aggregator.codigo,                 // sempre começa por ADSE
      matricula: aggregator.matricula,
      destinatario: aggregator.destinatario,   // nome global do camião
      provincia: aggregator.provincia,
      distrito: aggregator.distrito,
      sku: aggregator.sku,
      qty: aggregator.qty,
      estado: aggregator.estado,
      copies: [...(copiesByAdse.values().next().value || new Set())].sort(),
    } : null,
    deliveries,
    warnings,
    stats: {
      total_pages: pages.length,
      aggregator_pages: aggregatorPages.length,    // ex: 3 (Original+Duplicado+Triplicado da capa)
      adicional_pages: adicionalPages.length,      // ex: 33 (11 entregas × 3 cópias)
      aqi_pages: aqiPages.length,                  // ex: 33 (11 entregas × 3 cópias)
      unique_adse: aggregator ? 1 : 0,             // 1 capa por PDF
      unique_adsn: adsnMap.size,                   // entregas únicas
      unique_gtu: gtuToNuit.size,
      with_gtu: deliveries.filter((d) => d.gtu).length,
      with_nuit: deliveries.filter((d) => d.nuit).length,
      with_qty: deliveries.filter((d) => d.qty).length,
      with_destinatario: deliveries.filter((d) => d.destinatario).length,
      incomplete_copies: warnings.length,
    },
  };
}

module.exports = { parseGuia };
