/**
 * Reclassificações de fornecedor por regra (a nível de row da API).
 *
 * Necessário porque a API ADICIONAL às vezes regista o "fornecedor" como o
 * armazém intermédio onde a mercadoria estava (ADICIONAL CHIMOIO, ADICIONAL
 * TETE, HUB Xai-Xai, etc.) em vez do fornecedor real que entregou o produto.
 *
 * As regras correm em ordem; a primeira que faz match aplica-se. Cada regra
 * SUBSTITUI ShipFromName (e ShipAcountNumber por uma sentinela) na row,
 * propagando para toda a agregação downstream.
 *
 * As entries têm `_reassigned_by` adicionado para diagnóstico/auditoria.
 *
 * REGRAS (definidas pela operação UNOPS/AQI):
 *   1. Todos os sacos herméticos (SKU=SUSSACO) provêm de "Organizações MH-Tenders"
 *      — mesmo que apareçam como "ADICIONAL BEIRA", "ADICIONAL MACHAVA",
 *        "HUB Xai-Xai" no API.
 *   2. Milho que saiu de "ADICIONAL CHIMOIO" → BAYER
 *   3. Milho que saiu de "Adicional Tete" → BAYER
 *   4. Feijão que saiu de "ADICIONAL TETE" → Renaissance
 *   5. Qualquer row com origem "HUB Xai-Xai" / "Xai-Xai" (armazém intermédio)
 *      → SEEDCO (pertence à SEEDCO segundo a operação)
 *   6. Arroz com origem "C5" → SEEDCO (idem)
 *   7. Feijão com origem "PHOENIX" → SEEDCO (PHOENIX não fornece Feijão;
 *      rows mal classificados ficam creditados ao SEEDCO)
 *
 * Adicionar/mudar regras: editar a array RULES abaixo. Mudanças propagam
 * imediatamente para /admin/fornecido e /admin/origens.
 */

function _is(skuList) {
  const set = new Set(skuList.map((s) => s.toUpperCase()));
  return (sku) => set.has(String(sku || "").toUpperCase());
}
function _origStartsWithAdicional(name) {
  return /^ADICIONAL/i.test(String(name || "").trim());
}
function _addrIncludes(needle) {
  const n = needle.toUpperCase();
  return (addr) => String(addr || "").toUpperCase().includes(n);
}

const isMilho  = _is(["MXIXMILHOKG", "MSEEDOPVZM523"]);
const isFeijao = _is(["MXIXFEIJAOKG", "MSEEDFJNHB5KG"]);
const isArroz  = _is(["MXIXARROZKG", "SEEDARROZM50KG"]);
const isSaco   = _is(["SUSSACO"]);
const inChimoio = _addrIncludes("CHIMOIO");
const inTete    = _addrIncludes("TETE");

const RULES = [
  {
    name: "Sacos herméticos → SANA (organizações MH-Tenders)",
    match: (r) => isSaco(r.SKU),
    apply: { ShipFromName: "SANA (organizações MH-Tenders)", ShipAcountNumber: "REASSIGN_SANA" },
  },
  {
    name: "Milho ex-ADICIONAL CHIMOIO → BAYER",
    match: (r) => isMilho(r.SKU) && _origStartsWithAdicional(r.ShipFromName) && inChimoio(r.ShipFromAddress),
    apply: { ShipFromName: "BAYER", ShipAcountNumber: "REASSIGN_BAYER" },
  },
  {
    name: "Milho ex-Adicional Tete → BAYER",
    match: (r) => isMilho(r.SKU) && _origStartsWithAdicional(r.ShipFromName) && inTete(r.ShipFromAddress),
    apply: { ShipFromName: "BAYER", ShipAcountNumber: "REASSIGN_BAYER" },
  },
  {
    name: "Feijão ex-ADICIONAL TETE → Renaissance",
    match: (r) => isFeijao(r.SKU) && _origStartsWithAdicional(r.ShipFromName) && inTete(r.ShipFromAddress),
    apply: { ShipFromName: "Renaissance", ShipAcountNumber: "REASSIGN_RENAISSANCE" },
  },
  {
    // Feijão que saiu do armazém ADICIONAL CHIMOIO mas tem destino
    // Massangena (Gaza) é da MOZSEEDS — operação confirmou.
    // Match no destino via ReceiverPostalPlace (distrito).
    name: "Feijão ex-ADICIONAL CHIMOIO destinado a Massangena → MOZSEEDS",
    match: (r) => isFeijao(r.SKU)
              && _origStartsWithAdicional(r.ShipFromName)
              && inChimoio(r.ShipFromAddress)
              && /massang/i.test(String(r.ReceiverPostalPlace || "")),
    apply: { ShipFromName: "MOZSEEDS", ShipAcountNumber: "REASSIGN_MOZSEEDS" },
  },
  {
    // ShipFromName típicas: "HUB XAI-XAI", "Hub Xai-Xai", "HUB Xai-Xai", "XAI-XAI", "Xai-Xai"
    name: "Origem HUB/XAI-XAI → SEEDCO",
    match: (r) => {
      const n = String(r.ShipFromName || "").trim().toUpperCase();
      return /^HUB\s+XAI[-\s]?XAI$/i.test(n) || n === "XAI-XAI";
    },
    apply: { ShipFromName: "SEEDCO", ShipAcountNumber: "REASSIGN_SEEDCO" },
  },
  {
    name: "Arroz em C5 → SEEDCO",
    match: (r) => {
      const n = String(r.ShipFromName || "").trim().toUpperCase();
      return n === "C5" && isArroz(r.SKU);
    },
    apply: { ShipFromName: "SEEDCO", ShipAcountNumber: "REASSIGN_SEEDCO" },
  },
  {
    name: "Feijão registado como PHOENIX → SEEDCO",
    match: (r) => {
      const n = String(r.ShipFromName || "").trim().toUpperCase();
      return /^PHOENIX/i.test(n) && isFeijao(r.SKU);
    },
    apply: { ShipFromName: "SEEDCO", ShipAcountNumber: "REASSIGN_SEEDCO" },
  },
  {
    // Variantes em circulação que se referem ao mesmo fornecedor:
    //   "MOZSEED"                          × ~88
    //   "MOZSEEDS"                         × ~9
    //   "MOZAMBIQUE SEEDS, LDA- TENDERS"   × ~10
    // O fuzzy match em supplier-metas.js consegue fundir MOZSEED/MOZSEEDS
    // (são substring/equivalente), mas "MOZAMBIQUE SEEDS" não bate com
    // a meta key "MOZSEEDS" — ficava órfão (495t Feijão sem meta).
    // Esta regra canoniza todas as variantes para "MOZSEEDS".
    name: "MOZSEEDS / MOZAMBIQUE SEEDS variantes → MOZSEEDS",
    match: (r) => /^moz(ambique)?[\s,\-]*seeds?\b/i.test(String(r.ShipFromName || "").trim()),
    apply: { ShipFromName: "MOZSEEDS", ShipAcountNumber: "REASSIGN_MOZSEEDS" },
  },
];

/**
 * Aplica as regras de reclassificação a um array de rows da API.
 * Devolve um NOVO array (não muta o input — rows reclassificadas são
 * shallow copies com os campos sobrescritos).
 *
 * Cada row reclassificada ganha _reassigned_by = nome da regra,
 * útil para debugging e para mostrar na UI ("origem ajustada por...").
 */
function reassignRows(rows) {
  if (!rows) return [];
  let count = 0;
  const out = rows.map((r) => {
    for (const rule of RULES) {
      try {
        if (rule.match(r)) {
          count++;
          return { ...r, ...rule.apply, _reassigned_by: rule.name };
        }
      } catch (_) { /* regra com erro de match — ignora linha */ }
    }
    return r;
  });
  return out;
}

/**
 * Devolve estatística de quantas rows cada regra reclassificou (para
 * diagnóstico via /api/admin/adicional/reassignments-stats no futuro).
 */
function reassignStats(rows) {
  const stats = {};
  for (const rule of RULES) stats[rule.name] = 0;
  for (const r of (rows || [])) {
    for (const rule of RULES) {
      try {
        if (rule.match(r)) { stats[rule.name]++; break; }
      } catch (_) {}
    }
  }
  return stats;
}

module.exports = { RULES, reassignRows, reassignStats };
