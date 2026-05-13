/**
 * Audit-capture — guarda em DB as linhas detectadas no Google Sheet.
 *
 * Salvaguarda contra perda de delivery_date no AppSheet:
 * sempre que vemos uma linha nova (dedup_key não existe na tabela),
 * fazemos INSERT com detected_at = NOW(). Linhas já vistas só
 * actualizam last_seen_at e (se mudou) verification_status.
 *
 * Chamado a partir de app.js depois de cada fetch do CSV/sheet.
 *
 * Não interfere com a lógica original do dashboard — é um SIDE-EFFECT
 * silencioso. Falhas não bloqueiam o pipeline (try/catch nivel pipeline).
 */

const crypto = require("crypto");
const { query, queryOne, getPool } = require("../db/mysql");

/**
 * Gera o dedup_key:
 *   - "gtu|qty"          se houver GTU
 *   - "syn|md5(...)"     fallback determinístico para linhas sem GTU
 *
 * Limitamos a 80 chars (coluna VARCHAR(80)).
 */
function makeDedupKey(row) {
  const gtu = String(row.delivery_note_number || "").trim();
  const qty = Number(row.delivered_qty) || 0;
  if (gtu) {
    // Inclui qty para distinguir 2 linhas com mesmo GTU mas qty diferente
    const k = `${gtu}|${qty}`;
    return k.slice(0, 80);
  }
  // Sem GTU — usa hash de campos imutáveis. ADSN (delivery_id) é
  // tipicamente único; juntamos benef + prod + qty + district + submetedor
  // para resistir a casos onde o mesmo ADSN aparece sem GTU várias vezes.
  const seed = [
    row.delivery_id || "",
    row.beneficiary_id || row.beneficiary_name || "",
    row.product || "",
    qty,
    row.district || "",
    row.submitted_by || "",
  ].join("|").toLowerCase();
  const hash = crypto.createHash("md5").update(seed).digest("hex");
  return `syn|${hash}`;
}

/**
 * Processa um array de rows (já parseadas de CSV) e:
 *   1. Para rows novas (dedup_key inexistente) → INSERT com detected_at = NOW()
 *   2. Para rows existentes → UPDATE last_seen_at e verification_status
 *      (status só se mudou, com status_changed_at).
 *
 * Retorna stats sobre o que foi feito.
 */
async function captureRows(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return { inserted: 0, updated_status: 0, seen: 0, deleted: 0, undeleted: 0, total: 0, errors: [] };
  }

  const stats = { inserted: 0, updated_status: 0, seen: 0, deleted: 0, undeleted: 0, total: rows.length, errors: [] };

  // ── Timestamp único desta captura ──────────────────────────
  // Todas as rows vistas neste fetch ficam com last_seen_at = captureStart.
  // No fim, rows com last_seen_at < captureStart (não vistas) → marcadas
  // como deleted. Isto reflecte edições/eliminações no Google Sheet.
  const [tsRow] = await getPool().query("SELECT NOW() AS ts");
  const captureStart = tsRow[0].ts;

  // Em batch: 100 a 100 para não estourar com prepared statements
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    for (const r of batch) {
      try {
        const dedupKey = makeDedupKey(r);
        const gtu = String(r.delivery_note_number || "").trim() || null;
        const adsn = String(r.delivery_id || "").trim() || null;
        const benefName = String(r.beneficiary_name || "").trim() || null;
        const benefId   = String(r.beneficiary_id || "").trim() || null;
        const product   = String(r.product || "").trim() || null;
        const qty       = Number(r.delivered_qty) || null;
        const packages  = Number(r.packages) || null;
        const unit      = String(r.product_unit || "").trim() || null;
        const district  = String(r.district || "").trim() || null;
        const province  = String(r.province || "").trim() || null;
        const submitter = String(r.submitted_by || "").trim() || null;
        const dDateIso  = String(r.delivery_date_iso || "").trim() || null;
        const status    = String(r.verification_status || "").trim() || null;
        // Phone para enriquecer o registo (opcional)
        const phone     = String(r.phone || "").trim() || null;

        // Tenta UPDATE primeiro (case já existe)
        const [existing] = await getPool().query(
          "SELECT id, verification_status, deleted_at FROM delivery_audit WHERE dedup_key = ?",
          [dedupKey]
        );
        if (existing && existing.length) {
          const existingRow = existing[0];
          // Se estava marcada como deleted e agora reaparece, "ressuscita" (un-delete)
          const wasDeleted = existingRow.deleted_at != null;
          if (wasDeleted) stats.undeleted++;

          if (status && existingRow.verification_status !== status) {
            // Status mudou → actualiza com timestamp de mudança
            await query(
              `UPDATE delivery_audit
               SET verification_status = ?, status_changed_at = ?, last_seen_at = ?, deleted_at = NULL
               WHERE id = ?`,
              [status, captureStart, captureStart, existingRow.id]
            );
            // Regista no histórico (forensics: quando passou de X → Y)
            await query(
              `INSERT INTO delivery_audit_history (audit_id, from_status, to_status)
               VALUES (?, ?, ?)`,
              [existingRow.id, existingRow.verification_status || null, status]
            );
            stats.updated_status++;
          } else {
            // Sem mudança → só toca last_seen_at + limpa deleted_at se aplicável
            await query(
              "UPDATE delivery_audit SET last_seen_at = ?, deleted_at = NULL WHERE id = ?",
              [captureStart, existingRow.id]
            );
            stats.seen++;
          }
        } else {
          // Linha NOVA — INSERT
          // raw_data: guarda só campos relevantes (não a row inteira para
          // poupar espaço — ainda é JSON bonito para debug).
          const rawData = JSON.stringify({
            delivery_id: adsn, gtu, beneficiary_id: benefId, beneficiary_name: benefName,
            product, delivered_qty: qty, packages, unit,
            province, district, phone,
            submitted_by: submitter, delivery_date: r.delivery_date,
            submission_date: r.submission_date, verification_status: status,
          });
          await query(
            `INSERT INTO delivery_audit
             (dedup_key, gtu, adsn, beneficiary_name, extensionist_id, nuit,
              product, delivered_qty, packages, unit, district, province,
              submitted_by, delivery_date_iso, verification_status,
              detected_at, last_seen_at, raw_data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              dedupKey, gtu, adsn, benefName, benefId, null,
              product, qty, packages, unit, district, province,
              submitter, dDateIso, status,
              captureStart, captureStart, rawData,
            ]
          );
          stats.inserted++;
        }
      } catch (e) {
        // Não bloqueia — só regista o erro para o caller decidir
        stats.errors.push({
          gtu: r.delivery_note_number || r.delivery_id, error: e.message,
        });
      }
    }
  }

  // ── Detecção de rows apagadas ──────────────────────────────
  // Tudo o que ficou com last_seen_at < captureStart NÃO esteve no CSV
  // deste fetch — provavelmente foi apagado pelo batedor/operador. Marca
  // como deleted (mantém o dado para auditoria, mas exclui dos agregados).
  //
  // Salvaguarda: só considera "deleted" se a row foi vista há menos de
  // 14 dias — protege contra um fetch parcial/com erro que perderia rows
  // antigas; rows muito velhas que já desapareceram há tempos não voltam
  // a ser tocadas.
  if (stats.errors.length < rows.length * 0.5) {  // só marca se a maioria dos rows foi processada OK
    try {
      const [delResult] = await getPool().query(
        `UPDATE delivery_audit
         SET deleted_at = ?
         WHERE deleted_at IS NULL
           AND last_seen_at < ?
           AND last_seen_at >= DATE_SUB(?, INTERVAL 14 DAY)`,
        [captureStart, captureStart, captureStart]
      );
      stats.deleted = delResult.affectedRows || 0;
    } catch (e) {
      stats.errors.push({ gtu: "(deleted-sweep)", error: e.message });
    }
  }

  return stats;
}

module.exports = { captureRows, makeDedupKey };
