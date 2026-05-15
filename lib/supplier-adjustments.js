/**
 * Ajustes manuais de quantidade entre fornecedores (parciais).
 *
 * Diferente das supplier-reassignments (regras row-level), aqui movemos
 * uma quantidade ESPECÍFICA de um fornecedor para outro. Útil quando a
 * operação sabe que apenas parte do volume de um armazém intermédio
 * pertence a um fornecedor específico — o restante mantém-se.
 *
 * Exemplo: "Do Feijão que resta com origem ADICIONAL CHIMOIO, aloque 5440
 * à MOZSEED." Significa que dos N kg de Feijão registados como vindos de
 * ADICIONAL CHIMOIO, 5440 kg afinal vieram da MOZSEED — credita a esta
 * última, mantendo o resto onde está.
 *
 * Aplicado após buildSuppliers + post-merge + ghost suppliers, mas ANTES
 * do cálculo dos totals globais (para que by_product reflicta o ajuste).
 *
 * UNIDADE: kg para granéis, un para sacos herméticos. Detecta-se
 * automaticamente pelo nome do produto.
 */

const ADJUSTMENTS = [
  {
    from_name_pattern: /^ADICIONAL\s+CHIMOIO$/i,
    to_meta_key: "MOZSEEDS",
    product: "Feijão",
    qty: 5440,
    note: "Realocação manual: parte do Feijão ADICIONAL CHIMOIO pertence à MOZSEED",
  },
];

/**
 * Aplica os ajustes à lista de suppliers (mutação in-place).
 * Devolve { applied: [...], skipped: [...] } com diagnóstico do que correu.
 */
function applyAdjustments(suppliers) {
  const applied = [], skipped = [];
  for (const adj of ADJUSTMENTS) {
    const src = suppliers.find((s) => adj.from_name_pattern.test(s.canonical_name));
    const tgt = suppliers.find((s) => s.meta_match_key === adj.to_meta_key);
    if (!tgt) {
      skipped.push({ adj, reason: `target meta_key '${adj.to_meta_key}' não encontrado` });
      continue;
    }
    const isSaco = /sacos?\s*hermet|hermét/i.test(adj.product);
    // 1. Decrementa o source (se existir e tiver o produto)
    if (src) {
      const srcProd = src.by_product.find((p) => p.product === adj.product);
      if (srcProd) {
        const available = srcProd.forn_qty;
        const move = Math.min(adj.qty, available);
        srcProd.forn_qty -= move;
        if (isSaco) src.forn_qty_un -= move;
        else        src.forn_kg     -= move;
      }
    }
    // 2. Incrementa o target — cria entry by_product se ainda não existe
    let tgtProd = tgt.by_product.find((p) => p.product === adj.product);
    if (!tgtProd) {
      tgtProd = {
        product: adj.product,
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
    tgtProd.forn_qty += adj.qty;
    if (isSaco) tgt.forn_qty_un += adj.qty;
    else        tgt.forn_kg     += adj.qty;
    // 3. Re-calcula meta_pendente e pct do produto target (se tem meta)
    if (tgtProd.has_meta && tgtProd.meta_qty > 0) {
      tgtProd.meta_pendente = Math.max(0, tgtProd.meta_qty - tgtProd.forn_qty);
      tgtProd.meta_pct = Math.min(999, Math.round((tgtProd.forn_qty / tgtProd.meta_qty) * 100));
    }
    // 4. Re-calcula totals do supplier target
    let fornKg = 0, fornUn = 0;
    for (const p of tgt.by_product) {
      if (!p.has_meta) continue;
      if (p.is_saco) fornUn += p.forn_qty;
      else            fornKg += p.forn_qty;
    }
    tgt.meta_pendente_total_kg = Math.max(0, tgt.meta_total_kg - fornKg);
    tgt.meta_pendente_total_un = Math.max(0, (tgt.meta_total_un || 0) - fornUn);
    if (tgt.meta_total_kg > 0)        tgt.meta_pct = Math.min(999, Math.round((fornKg / tgt.meta_total_kg) * 100));
    else if (tgt.meta_total_un > 0)   tgt.meta_pct = Math.min(999, Math.round((fornUn / tgt.meta_total_un) * 100));

    applied.push({
      adj, src_name: src?.canonical_name || "(sem source)",
      tgt_name: tgt.canonical_name,
    });
  }
  return { applied, skipped };
}

module.exports = { ADJUSTMENTS, applyAdjustments };
