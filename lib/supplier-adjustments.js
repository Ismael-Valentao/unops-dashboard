/**
 * Ajustes manuais de quantidade entre fornecedores.
 *
 * Diferente das supplier-reassignments (regras row-level), aqui movemos uma
 * quantidade ESPECÍFICA (ou o EXCESSO sobre a meta) de um fornecedor para
 * outro. Útil quando:
 *   • A operação sabe que parte do volume de um armazém intermédio pertence
 *     a um fornecedor específico (type "fixed")
 *   • Um fornecedor entregou MAIS que a meta e a operação atribui esse
 *     excesso a outro fornecedor que ainda não atingiu a sua (type "excess")
 *   • Mercadoria está retida no armazém ou contabilizada noutro fluxo,
 *     mas conta como recebida do fornecedor (type "add" — só adiciona)
 *
 * Aplicado após buildSuppliers + post-merge + ghost suppliers, mas ANTES do
 * cálculo dos totals globais.
 *
 * UNIDADE: kg para granéis, un para sacos herméticos (auto-detectado pelo
 * nome do produto).
 */

const ADJUSTMENTS = [
  // ── FIXED — qty estática ────────────────────────────────────────
  {
    type: "fixed",
    from_name_pattern: /^ADICIONAL\s+CHIMOIO$/i,
    to_meta_key: "MOZSEEDS",
    product: "Feijão",
    qty: 5440,
    note: "Realocação manual: parte do Feijão ADICIONAL CHIMOIO pertence à MOZSEED",
  },
  // ── COMPLETE_TO_TARGET — fecha um supplier num valor fixo, tirando
  // do source. qty calculado dinamicamente como max(0, target − tgt.forn).
  // Combinado com a regra "excess" abaixo, mantém BAYER = 488272 SEMPRE:
  //   - Se BAYER < 488272 → complete_to_target adiciona delta da SEEDCO
  //   - Se BAYER > 488272 → excess move o sobrante para a SEEDCO
  //
  // IMPORTANTE: deve correr ANTES do excess para que o excess possa
  // capturar qualquer sobreposição que ainda existir após o complete.
  {
    type: "complete_to_target",
    from_meta_key: "SEEDCO",
    to_meta_key: "BAYER",
    product: "Milho",
    target_qty: 488272,
    note: "BAYER fecha em 488272 kg (= meta); défice retirado da SEEDCO",
  },
  // ── EXCESS — qty = max(0, forn − meta) calculado em tempo real ──
  {
    type: "excess",
    from_meta_key: "BAYER",
    to_meta_key: "SEEDCO",
    product: "Milho",
    note: "Excesso de Milho da BAYER vai à SEEDCO",
  },
  {
    type: "excess",
    from_meta_key: "PHOENIX",
    to_meta_key: "SEEDCO",
    product: "Milho",
    note: "Excesso de Milho da PHOENIX vai à SEEDCO",
  },
  // ── ADD — só adiciona qty ao target (sem source) ────────────────
  // Qty pode ser NEGATIVO para subtracções (correcções de contagem).
  {
    type: "add",
    to_meta_key: "RENAISSANCE",
    product: "Feijão",
    qty: 0,   // histórico: 12510 → 2640 → 0 (armazém vazio em 28/05/2026)
    note: "Feijão retido no nosso armazém — conta como já levantado",
  },
  {
    type: "add",
    to_meta_key: "RENAISSANCE",
    product: "Feijão",
    qty: -270,   // 03/06/2026: 270 kg fantasma resultado de erro de contagem
    note: "Correcção de contagem — 270 kg que tinham sido inflados por engano",
  },
];

function _isSaco(productName) {
  return /sacos?\s*hermet|hermét/i.test(String(productName || ""));
}

/**
 * Move `qty` do supplier src (no produto adj.product) para o supplier tgt.
 * Recalcula meta_pendente, meta_pct e supplier-level totals.
 * Helper interno usado pelos dois tipos.
 */
function _transfer(src, tgt, productName, qty) {
  const isSaco = _isSaco(productName);
  // 1. Decrementa source (se existir o produto)
  if (src) {
    const srcProd = src.by_product.find((p) => p.product === productName);
    if (srcProd) {
      const move = Math.min(qty, srcProd.forn_qty);
      srcProd.forn_qty -= move;
      if (isSaco) src.forn_qty_un -= move;
      else        src.forn_kg     -= move;
      // Recalcula pct do source (excess pode levá-lo a 100%)
      if (srcProd.has_meta && srcProd.meta_qty > 0) {
        srcProd.meta_pendente = Math.max(0, srcProd.meta_qty - srcProd.forn_qty);
        srcProd.meta_pct = Math.min(999, Math.round((srcProd.forn_qty / srcProd.meta_qty) * 100));
      }
    }
  }
  // 2. Incrementa target — cria entry se preciso
  let tgtProd = tgt.by_product.find((p) => p.product === productName);
  if (!tgtProd) {
    tgtProd = {
      product: productName,
      is_saco: isSaco,
      display_unit: isSaco ? "un" : "kg",
      skus: [],
      forn_qty: 0, forn_count: 0,
      criado_qty: 0, criado_count: 0,
      meta_qty: null, meta_pendente: null, meta_pct: null,
      has_meta: false,
    };
    tgt.by_product.push(tgtProd);
  }
  tgtProd.forn_qty += qty;
  if (isSaco) tgt.forn_qty_un += qty;
  else        tgt.forn_kg     += qty;
  if (tgtProd.has_meta && tgtProd.meta_qty > 0) {
    tgtProd.meta_pendente = Math.max(0, tgtProd.meta_qty - tgtProd.forn_qty);
    tgtProd.meta_pct = Math.min(999, Math.round((tgtProd.forn_qty / tgtProd.meta_qty) * 100));
  }
}

/** Re-calcula totals supplier-level (forn vs meta) — chama-se a seguir aos transfers. */
function _recalcSupplierTotals(s) {
  let fornKg = 0, fornUn = 0;
  for (const p of s.by_product) {
    if (!p.has_meta) continue;
    if (p.is_saco) fornUn += p.forn_qty;
    else            fornKg += p.forn_qty;
  }
  s.meta_pendente_total_kg = Math.max(0, s.meta_total_kg - fornKg);
  s.meta_pendente_total_un = Math.max(0, (s.meta_total_un || 0) - fornUn);
  if (s.meta_total_kg > 0)        s.meta_pct = Math.min(999, Math.round((fornKg / s.meta_total_kg) * 100));
  else if (s.meta_total_un > 0)   s.meta_pct = Math.min(999, Math.round((fornUn / s.meta_total_un) * 100));
}

function applyAdjustments(suppliers) {
  const applied = [], skipped = [];
  const touched = new Set();
  for (const adj of ADJUSTMENTS) {
    let src = null, tgt = null, qty = 0;
    if (adj.type === "fixed") {
      src = suppliers.find((s) => adj.from_name_pattern.test(s.canonical_name));
      tgt = suppliers.find((s) => s.meta_match_key === adj.to_meta_key);
      qty = adj.qty;
    } else if (adj.type === "excess") {
      src = suppliers.find((s) => s.meta_match_key === adj.from_meta_key);
      tgt = suppliers.find((s) => s.meta_match_key === adj.to_meta_key);
      if (!src) { skipped.push({ adj, reason: "src not found" }); continue; }
      const srcProd = src.by_product.find((p) => p.product === adj.product);
      if (!srcProd || !srcProd.has_meta || srcProd.meta_qty == null) {
        skipped.push({ adj, reason: "src product/meta missing" });
        continue;
      }
      qty = Math.max(0, srcProd.forn_qty - srcProd.meta_qty);
      if (qty === 0) { skipped.push({ adj, reason: "sem excesso" }); continue; }
    } else if (adj.type === "add") {
      // Apenas adiciona qty ao target — sem source, sem subtracção
      src = null;
      tgt = suppliers.find((s) => s.meta_match_key === adj.to_meta_key);
      qty = adj.qty;
    } else if (adj.type === "complete_to_target") {
      // Fecha tgt num valor fixo (target_qty), tirando do source.
      // qty dinâmico: max(0, target_qty − tgt.forn_qty actual).
      // Útil para "BAYER deve fechar em 488272, tira o que falta da SEEDCO":
      // se mais entrar para BAYER amanhã, o delta recalcula sozinho.
      src = suppliers.find((s) => s.meta_match_key === adj.from_meta_key);
      tgt = suppliers.find((s) => s.meta_match_key === adj.to_meta_key);
      if (!tgt) { skipped.push({ adj, reason: "tgt not found" }); continue; }
      const tgtProd = tgt.by_product.find((p) => p.product === adj.product);
      const currentQty = tgtProd ? tgtProd.forn_qty : 0;
      qty = Math.max(0, Number(adj.target_qty) - currentQty);
      if (qty === 0) {
        skipped.push({ adj, reason: "tgt já no/acima target_qty" });
        continue;
      }
    } else {
      skipped.push({ adj, reason: "unknown type" });
      continue;
    }
    if (!tgt) { skipped.push({ adj, reason: "tgt not found" }); continue; }
    _transfer(src, tgt, adj.product, qty);
    if (src) touched.add(src);
    touched.add(tgt);
    applied.push({ adj, src_name: src?.canonical_name || "(sem source)", tgt_name: tgt.canonical_name, qty });
  }
  // Re-calcula totals dos suppliers tocados (uma vez por supplier, no fim)
  for (const s of touched) _recalcSupplierTotals(s);
  return { applied, skipped };
}

module.exports = { ADJUSTMENTS, applyAdjustments };
