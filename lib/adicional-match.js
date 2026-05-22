/**
 * Reconciliação Sheet (delivery_audit) ↔ ADICIONAL DMS API.
 *
 * Match key: GTU/GTS + nome (normalizado) + qty (com tolerância).
 *
 * Buckets de output:
 *   - matched          → GTU em ambos, nome bate, qty dentro da tolerância
 *   - qty_mismatch     → GTU + nome batem mas qty diverge >2%
 *   - name_mismatch    → GTU bate mas nome diferente (suspeito)
 *   - api_only         → GTU criado no sistema ADICIONAL mas batedor ainda
 *                        não submeteu na app (entrega ainda não foi feita,
 *                        ou batedor esqueceu de submeter)
 *   - sheet_only       → batedor submeteu um GTU que NÃO existe na API
 *                        (suspeito — entrega inventada ou GTU errado)
 *
 * Os 5 buckets juntos cobrem todo o universo. Permitem auditar:
 *   - Quantos camiões já entregaram mas faltam confirmação do batedor?
 *   - Há submissões fantasma sem ADSN correspondente?
 *   - Diferenças sistemáticas de qty entre planeado e entregue?
 */

const SACO_KG_PER_UNIT = 0.145;

/**
 * Normaliza GTU/GTS para match exacto.
 * Todas estas formas colapsam para o mesmo canónico "GTU98/202310231":
 *   "GTU98/202310231"     (canónico — sem mudança)
 *   "GTU/98/202310231"    (slash extra entre letras e número do prefixo)
 *   "GTU98/2023/10231"    (slash extra entre ano e sequência)
 *   "GTU/98/2023/10231"   (ambos os slashes extras)
 *   "GTU98/2023/6543"     → "GTU98/202306543" (padding 5 dígitos)
 *   "GTU98/202345"        → "GTU98/202300045" (sequência curta, padding)
 *   "  gtu98/202306159 "  → "GTU98/202306159" (trim + upper)
 *   "GTUS98/..."          → "GTS98/..."      (typo recorrente)
 *
 * Regra: após o ano (YYYY) a sequência é zero-padded a 5 dígitos.
 */
function normGtu(s) {
  let g = String(s || "").trim().toUpperCase().replace(/\s+/g, "");
  // 0. Typo recorrente "GTUS98/..." → "GTS98/..."
  g = g.replace(/^GTUS/i, "GTS");
  // 1. Slash extra entre LETRAS e DÍGITOS do prefixo:
  //    "GTU/98/..." → "GTU98/..." | "GTS/98/..." → "GTS98/..."
  g = g.replace(/^([A-Z]+)\/(\d+)\//, (_m, letters, digits) => letters + digits + "/");
  // 2. Slash extra entre ANO e SEQUÊNCIA:
  //    "GTU98/2023/6543" → "GTU98/202306543" (com padding 5)
  g = g.replace(
    /^([A-Z]+\d*)\/(\d{4})\/(\d+)$/,
    (_m, prefix, year, seq) => prefix + "/" + year + seq.padStart(5, "0")
  );
  // 3. Sequência curta sem slash extra:
  //    "GTU98/202345" → "GTU98/202300045"
  //    Cuidado: não mexer em IDs com já 5+ dígitos após o ano.
  g = g.replace(
    /^([A-Z]+\d*)\/(\d{4})(\d{1,4})$/,
    (_m, prefix, year, seq) => prefix + "/" + year + seq.padStart(5, "0")
  );
  return g;
}

/**
 * Normaliza nome: uppercase + remove acentos + colapsa espaços.
 * Ex: "Nuro Cardoso Mucavele" → "NURO CARDOSO MUCAVELE"
 *     "L�cia Mahesse" (encoding broken) → "LCIA MAHESSE" (best effort)
 */
function normName(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Quantidade com tolerância ±2% (ou ±1 unidade para valores baixos).
 * a, b em kg (mesma unidade). Devolve true se "iguais".
 */
function qtyMatch(a, b) {
  const A = Math.abs(Number(a) || 0);
  const B = Math.abs(Number(b) || 0);
  if (A === 0 && B === 0) return true;
  const diff = Math.abs(A - B);
  const max = Math.max(A, B);
  if (max < 5) return diff <= 1;  // valores pequenos: ±1 absoluto
  return diff / max <= 0.02;       // outros: ±2% relativo
}

/**
 * Para sacos: API devolve Weight em kg (= un × 0.145). Sheet pode ter
 * delivered_qty em un OU em kg-equivalente, dependendo do parser.
 * Devolve qty em KG (canônico) para comparação.
 */
function rowKg(row, source) {
  if (source === "api") {
    return Number(row.Weight) || 0;  // API sempre em kg
  }
  // Sheet: delivered_qty + unit. Se unit='un' e o produto é saco, converte.
  const q = Number(row.delivered_qty) || 0;
  const unit = String(row.unit || "").toLowerCase();
  const isSaco = /saco|hermetic/i.test(String(row.product || ""));
  if (isSaco && unit === "un") return q * SACO_KG_PER_UNIT;
  return q;  // outros casos: já em kg ou L≈kg
}

/**
 * Constrói match key a partir de uma row. Devolve objecto:
 *   { gtu, name_norm, qty_kg, ref (row original) }
 */
function buildKey(row, source) {
  if (source === "api") {
    return {
      gtu:       normGtu(row.ClientBarCode),
      name_norm: normName(row.ReceiverName),
      qty_kg:    rowKg(row, "api"),
      ref:       row,
    };
  }
  // sheet
  return {
    gtu:       normGtu(row.gtu || row.delivery_note_number),
    name_norm: normName(row.beneficiary_name),
    qty_kg:    rowKg(row, "sheet"),
    ref:       row,
  };
}

/**
 * Reconcilia 2 conjuntos. apiRows = array da ADICIONAL, sheetRows = array
 * do delivery_audit (já filtrado por deleted_at IS NULL).
 *
 * Devolve { matched, qty_mismatch, name_mismatch, api_only, sheet_only,
 *           summary }
 */
function reconcile(apiRows, sheetRows) {
  const apiByGtu = new Map();
  const sheetByGtu = new Map();

  // Index API por GTU (ignora rows sem GTU — não conseguimos matchear)
  for (const r of apiRows || []) {
    const k = buildKey(r, "api");
    if (!k.gtu) continue;
    // Em caso de duplicados na API com mesmo GTU (raro), guarda o último visto
    apiByGtu.set(k.gtu, k);
  }
  // Index Sheet por GTU
  for (const r of sheetRows || []) {
    const k = buildKey(r, "sheet");
    if (!k.gtu) continue;
    sheetByGtu.set(k.gtu, k);
  }

  const matched = [];
  const qty_mismatch = [];
  const name_mismatch = [];
  const api_only = [];
  const sheet_only = [];

  for (const [gtu, apiK] of apiByGtu) {
    const sheetK = sheetByGtu.get(gtu);
    if (!sheetK) {
      api_only.push({ gtu, api: apiK.ref });
      continue;
    }
    // Verificar nome
    const namesOk = apiK.name_norm === sheetK.name_norm
      || apiK.name_norm.includes(sheetK.name_norm)
      || sheetK.name_norm.includes(apiK.name_norm);
    // Verificar qty (com tolerância)
    const qtyOk = qtyMatch(apiK.qty_kg, sheetK.qty_kg);

    const entry = {
      gtu,
      api: apiK.ref,
      sheet: sheetK.ref,
      api_qty_kg: apiK.qty_kg,
      sheet_qty_kg: sheetK.qty_kg,
      diff_kg: Number((apiK.qty_kg - sheetK.qty_kg).toFixed(2)),
      api_name: apiK.ref.ReceiverName,
      sheet_name: sheetK.ref.beneficiary_name,
    };

    if (namesOk && qtyOk) matched.push(entry);
    else if (!qtyOk) qty_mismatch.push(entry);
    else name_mismatch.push(entry);
  }

  // Sheet only — GTUs que estão na sheet mas não na API (suspeito)
  for (const [gtu, sheetK] of sheetByGtu) {
    if (!apiByGtu.has(gtu)) {
      sheet_only.push({ gtu, sheet: sheetK.ref });
    }
  }

  const summary = {
    api_total: apiByGtu.size,
    sheet_total: sheetByGtu.size,
    matched: matched.length,
    qty_mismatch: qty_mismatch.length,
    name_mismatch: name_mismatch.length,
    api_only: api_only.length,
    sheet_only: sheet_only.length,
    match_rate_pct: apiByGtu.size > 0
      ? Math.round((matched.length / apiByGtu.size) * 1000) / 10
      : 0,
  };

  return { matched, qty_mismatch, name_mismatch, api_only, sheet_only, summary };
}

module.exports = { reconcile, buildKey, normGtu, normName, qtyMatch, rowKg };
