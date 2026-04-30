/**
 * Repository da camada de Distribuição (saldo / serviços / itens).
 *
 * Regras invariantes:
 *  - Saldo despachável de (extensionist_id, sku) = planned_qty − committed_qty.
 *  - committed_qty inclui drafts + in_transit + delivered (NÃO cancelled).
 *  - delivered_qty é incrementado quando o serviço passa a 'delivered'.
 *  - O createService bloqueia saldo de TODOS os items numa única transação;
 *    se algum item ultrapassar saldo, faz rollback e devolve erro detalhado.
 */
const { getPool, query, queryOne } = require("./mysql");

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const Beneficiaries = {
  async list(opts = {}) {
    const where = [];
    const params = [];
    if (opts.province) { where.push("province = ?"); params.push(opts.province); }
    if (opts.district) { where.push("district = ?"); params.push(opts.district); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    return query(`SELECT * FROM beneficiaries ${w} ORDER BY name LIMIT 5000`, params);
  },
  async byId(extId) {
    return queryOne("SELECT * FROM beneficiaries WHERE extensionist_id = ?", [extId]);
  },
  async geography() {
    const rows = await query(
      `SELECT province, district, COUNT(*) AS n
       FROM beneficiaries
       WHERE province IS NOT NULL AND district IS NOT NULL
       GROUP BY province, district
       ORDER BY province, district`
    );
    const map = {};
    rows.forEach((r) => {
      if (!map[r.province]) map[r.province] = {};
      map[r.province][r.district] = r.n;
    });
    return map;
  },
};

const Balances = {
  // Saldo + info do beneficiário, opcionalmente filtrado por província/distrito/sku/só_com_saldo.
  async list(opts = {}) {
    const where = [];
    const params = [];
    if (opts.province)  { where.push("province = ?");  params.push(opts.province); }
    if (opts.district)  { where.push("district = ?");  params.push(opts.district); }
    if (opts.sku)       { where.push("sku = ?");       params.push(opts.sku); }
    if (opts.extensionist_id) { where.push("extensionist_id = ?"); params.push(opts.extensionist_id); }
    if (opts.onlyAvailable) where.push("(planned_qty - committed_qty) > 0");
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = opts.limit ? `LIMIT ${Number(opts.limit)}` : "LIMIT 5000";
    return query(
      `SELECT extensionist_id, sku, product_name, unit, province, district,
              beneficiary_name, planned_qty, committed_qty, delivered_qty,
              (planned_qty - committed_qty) AS available_qty
       FROM delivery_balances
       ${w}
       ORDER BY district, beneficiary_name, sku
       ${limit}`,
      params
    );
  },

  // Resumo agregado para uma seleção: total kg/L/un por unidade.
  async summary(opts = {}) {
    const where = [];
    const params = [];
    if (opts.province) { where.push("province = ?"); params.push(opts.province); }
    if (opts.district) { where.push("district = ?"); params.push(opts.district); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const rows = await query(
      `SELECT unit,
              SUM(planned_qty)              AS planned,
              SUM(committed_qty)            AS committed,
              SUM(delivered_qty)            AS delivered,
              SUM(planned_qty - committed_qty) AS available,
              COUNT(*)                      AS rows
       FROM delivery_balances ${w} GROUP BY unit`,
      params
    );
    const out = { kg: {}, L: {}, un: {} };
    rows.forEach((r) => {
      out[r.unit] = {
        planned: Number(r.planned) || 0,
        committed: Number(r.committed) || 0,
        delivered: Number(r.delivered) || 0,
        available: Number(r.available) || 0,
        rows: Number(r.rows) || 0,
      };
    });
    // Number of distinct beneficiaries (count once across SKUs)
    const benRows = await query(
      `SELECT COUNT(DISTINCT extensionist_id) AS n FROM delivery_balances ${w}`,
      params
    );
    out.beneficiaries = Number(benRows[0]?.n) || 0;
    return out;
  },
};

// ── Serviços ────────────────────────────────────────────────
const Services = {
  /**
   * Cria um serviço atomicamente.
   * Se algum item exceder saldo disponível, faz rollback e devolve
   * { error: 'Saldo insuficiente', insufficient: [{...}] }.
   *
   * @param {object} svc — { province, district, truck_capacity_kg, truck_plate, ... }
   * @param {Array<{extensionist_id, sku, qty}>} items — linhas a despachar
   * @param {number?} userId
   */
  async create(svc, items, userId) {
    if (!items || !items.length) throw new Error("Nenhum item seleccionado");
    if (!svc.province || !svc.district) throw new Error("Província e distrito obrigatórios");
    const capacity = Number(svc.truck_capacity_kg) || 0;
    if (capacity <= 0) throw new Error("Capacidade do camião inválida");

    // Sanity: item qty > 0 e ext_id/sku presentes
    for (const it of items) {
      if (!it.extensionist_id || !it.sku || !(Number(it.qty) > 0)) {
        throw new Error("Item inválido: " + JSON.stringify(it));
      }
    }

    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();

      // Bloqueia saldo (committed_qty += qty) item a item, com guard atómico
      const insufficient = [];
      for (const it of items) {
        const [res] = await conn.query(
          `UPDATE delivery_balances
           SET committed_qty = committed_qty + ?
           WHERE extensionist_id = ?
             AND sku = ?
             AND (planned_qty - committed_qty) >= ?`,
          [it.qty, it.extensionist_id, it.sku, it.qty]
        );
        if (res.affectedRows === 0) {
          // Verifica porquê para devolver mensagem clara
          const [bal] = await conn.query(
            `SELECT extensionist_id, sku, beneficiary_name, product_name,
                    planned_qty, committed_qty,
                    (planned_qty - committed_qty) AS available_qty
             FROM delivery_balances WHERE extensionist_id = ? AND sku = ?`,
            [it.extensionist_id, it.sku]
          );
          insufficient.push({
            requested: Number(it.qty),
            ...(bal[0] || { extensionist_id: it.extensionist_id, sku: it.sku, available_qty: 0 }),
          });
        }
      }
      if (insufficient.length) {
        await conn.rollback();
        return { error: "Saldo insuficiente", insufficient };
      }

      // Validar capacidade do camião
      const totalKg = items.reduce((s, it) => s + Number(it.qty), 0);
      if (totalKg > capacity) {
        await conn.rollback();
        return {
          error: "Excede capacidade",
          requested_kg: totalKg,
          capacity_kg: capacity,
        };
      }

      // Gera service_number sequencial: SRV-YYYY-NNNN
      const yr = new Date().getFullYear();
      const [maxRow] = await conn.query(
        `SELECT COUNT(*) AS n FROM delivery_services
         WHERE service_number LIKE ? AND source = 'manual'`,
        [`SRV-${yr}-%`]
      );
      const seq = (Number(maxRow[0]?.n) || 0) + 1;
      const serviceNumber = `SRV-${yr}-${String(seq).padStart(4, "0")}`;

      const ts = now();
      const [svcRes] = await conn.query(
        `INSERT INTO delivery_services
         (service_number, province, district, truck_capacity_kg,
          truck_plate, truck_plate_2, driver_name, driver_phone,
          origem_supplier, status, total_kg, source, created_at, created_by, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          serviceNumber, svc.province, svc.district, capacity,
          (svc.truck_plate || "").toUpperCase().trim() || null,
          (svc.truck_plate_2 || "").toUpperCase().trim() || null,
          svc.driver_name || null,
          svc.driver_phone || null,
          svc.origem_supplier || null,
          "draft", totalKg, "manual", ts, userId || null, svc.notes || null,
        ]
      );
      const serviceId = svcRes.insertId;

      // Insere items (com snapshot do nome do beneficiário/produto)
      const balKeys = items.map((it) => [it.extensionist_id, it.sku]);
      const ph = balKeys.map(() => "(?,?)").join(",");
      const [balRows] = await conn.query(
        `SELECT extensionist_id, sku, beneficiary_name, product_name, unit, province, district
         FROM delivery_balances WHERE (extensionist_id, sku) IN (${ph})`,
        balKeys.flat()
      );
      const balMap = new Map(balRows.map((b) => [`${b.extensionist_id}|${b.sku}`, b]));

      for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100);
        const itPh = chunk.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
        const params = [];
        chunk.forEach((it) => {
          const b = balMap.get(`${it.extensionist_id}|${it.sku}`);
          params.push(
            serviceId, it.extensionist_id, it.sku, it.qty,
            b?.unit || "kg",
            b?.beneficiary_name || "—",
            b?.product_name || it.sku,
            b?.province || svc.province,
            b?.district || svc.district
          );
        });
        await conn.query(
          `INSERT INTO delivery_service_items
           (service_id, extensionist_id, sku, qty, unit,
            beneficiary_name, product_name, province, district)
           VALUES ${itPh}`,
          params
        );
      }

      await conn.commit();
      return { ok: true, service_id: serviceId, service_number: serviceNumber, total_kg: totalKg };
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  },

  // Avança estado: draft → in_transit (carregou) → delivered (chegou). Cancelar é noutra função.
  async setInTransit(serviceId, opts = {}) {
    const ts = now();
    const fields = ["status = 'in_transit'", "dispatched_at = ?"];
    const params = [ts];
    if (opts.truck_plate)  { fields.push("truck_plate = ?");  params.push(opts.truck_plate); }
    if (opts.driver_name)  { fields.push("driver_name = ?");  params.push(opts.driver_name); }
    if (opts.driver_phone) { fields.push("driver_phone = ?"); params.push(opts.driver_phone); }
    params.push(serviceId);
    const conn = await getPool().getConnection();
    try {
      const [res] = await conn.query(
        `UPDATE delivery_services SET ${fields.join(", ")}
         WHERE id = ? AND status = 'draft'`,
        params
      );
      if (res.affectedRows === 0) {
        return { error: "Serviço não está em rascunho ou já foi enviado" };
      }
      return { ok: true };
    } finally {
      conn.release();
    }
  },

  async setDelivered(serviceId) {
    const ts = now();
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      // Get items to know what to bump in delivered_qty
      const [items] = await conn.query(
        `SELECT extensionist_id, sku, qty FROM delivery_service_items WHERE service_id = ?`,
        [serviceId]
      );
      const [check] = await conn.query(
        `UPDATE delivery_services
         SET status = 'delivered', delivered_at = ?
         WHERE id = ? AND status IN ('draft','in_transit')`,
        [ts, serviceId]
      );
      if (check.affectedRows === 0) {
        await conn.rollback();
        return { error: "Serviço já entregue ou cancelado" };
      }
      // Increment delivered_qty per item
      for (const it of items) {
        await conn.query(
          `UPDATE delivery_balances
           SET delivered_qty = delivered_qty + ?
           WHERE extensionist_id = ? AND sku = ?`,
          [it.qty, it.extensionist_id, it.sku]
        );
      }
      await conn.commit();
      return { ok: true };
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  },

  // Cancela: liberta saldo (committed_qty -= qty). Se já estava 'delivered' não permite.
  async cancel(serviceId, reason) {
    const ts = now();
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [svc] = await conn.query(
        `SELECT id, status FROM delivery_services WHERE id = ?`,
        [serviceId]
      );
      if (!svc[0]) { await conn.rollback(); return { error: "Serviço não existe" }; }
      if (svc[0].status === "delivered") {
        await conn.rollback();
        return { error: "Não é possível cancelar serviço já entregue" };
      }
      if (svc[0].status === "cancelled") {
        await conn.rollback();
        return { error: "Serviço já está cancelado" };
      }
      const [items] = await conn.query(
        `SELECT extensionist_id, sku, qty FROM delivery_service_items WHERE service_id = ?`,
        [serviceId]
      );
      // Liberta saldo
      for (const it of items) {
        await conn.query(
          `UPDATE delivery_balances
           SET committed_qty = GREATEST(0, committed_qty - ?)
           WHERE extensionist_id = ? AND sku = ?`,
          [it.qty, it.extensionist_id, it.sku]
        );
      }
      await conn.query(
        `UPDATE delivery_services
         SET status = 'cancelled', cancelled_at = ?, notes = CONCAT(IFNULL(notes,''), ?)
         WHERE id = ?`,
        [ts, `\n[CANCEL ${ts}] ${reason || ""}`, serviceId]
      );
      await conn.commit();
      return { ok: true };
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  },

  async list(opts = {}) {
    const where = [];
    const params = [];
    if (opts.status)   { where.push("status = ?");   params.push(opts.status); }
    if (opts.province) { where.push("province = ?"); params.push(opts.province); }
    if (opts.district) { where.push("district = ?"); params.push(opts.district); }
    if (opts.plate)    {
      where.push("(truck_plate LIKE ? OR truck_plate_2 LIKE ?)");
      params.push("%" + opts.plate.toUpperCase() + "%", "%" + opts.plate.toUpperCase() + "%");
    }
    if (opts.supplier) { where.push("origem_supplier LIKE ?"); params.push("%" + opts.supplier + "%"); }
    if (opts.source)   { where.push("source = ?");   params.push(opts.source); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = opts.limit ? `LIMIT ${Number(opts.limit)}` : "LIMIT 500";
    return query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM delivery_service_items WHERE service_id = s.id) AS n_items,
              (SELECT COUNT(DISTINCT extensionist_id) FROM delivery_service_items WHERE service_id = s.id) AS n_beneficiaries
       FROM delivery_services s
       ${w}
       ORDER BY created_at DESC
       ${limit}`,
      params
    );
  },

  async byId(id) {
    const svc = await queryOne("SELECT * FROM delivery_services WHERE id = ?", [id]);
    if (!svc) return null;
    const items = await query(
      `SELECT * FROM delivery_service_items WHERE service_id = ? ORDER BY beneficiary_name, sku`,
      [id]
    );
    return { ...svc, items };
  },

  async byPlate(plate) {
    return query(
      `SELECT s.id, s.service_number, s.status, s.province, s.district,
              s.truck_plate, s.driver_name, s.origem_supplier, s.total_kg,
              s.created_at, s.dispatched_at, s.delivered_at,
              (SELECT COUNT(DISTINCT extensionist_id) FROM delivery_service_items WHERE service_id = s.id) AS n_beneficiaries
       FROM delivery_services s
       WHERE truck_plate LIKE ? OR truck_plate_2 LIKE ?
       ORDER BY created_at DESC`,
      ["%" + plate.toUpperCase() + "%", "%" + plate.toUpperCase() + "%"]
    );
  },

  async inTransit() {
    return query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM delivery_service_items WHERE service_id = s.id) AS n_items,
              (SELECT COUNT(DISTINCT extensionist_id) FROM delivery_service_items WHERE service_id = s.id) AS n_beneficiaries
       FROM delivery_services s
       WHERE status = 'in_transit'
       ORDER BY dispatched_at DESC`
    );
  },

  // Anexa códigos ADSN/GTU a items de um serviço com base nas entregas
  // extraídas de um PDF da ADICIONAL.
  // Estratégia de matching:
  //   1. NUIT → beneficiaries.nuit → extensionist_id (mais fiável)
  //   2. Fallback: nome aproximado (case-insensitive trim, sem acentos)
  //   3. Discriminar por (extensionist_id + sku) entre os items do serviço
  // Apenas anexa se o item ainda não tem external_adsn (idempotente).
  async attachGuiaDeliveries(serviceId, deliveries, opts = {}) {
    const conn = await getPool().getConnection();
    try {
      const [svcRows] = await conn.query("SELECT * FROM delivery_services WHERE id = ?", [serviceId]);
      if (!svcRows[0]) throw new Error("Serviço não encontrado");
      const svc = svcRows[0];

      // 1. Build NUIT → extensionist_id map (a partir dos beneficiaries do
      //    serviço — mais rápido que carregar todos)
      const [items] = await conn.query(
        `SELECT i.*, b.nuit
         FROM delivery_service_items i
         LEFT JOIN beneficiaries b ON b.extensionist_id = i.extensionist_id
         WHERE i.service_id = ?`,
        [serviceId]
      );
      const itemsByNuitSku = new Map();      // `${nuit}|${sku}` → [items]
      const itemsByNameSku = new Map();      // `${normalize(name)}|${sku}` → [items]
      function norm(s) { return String(s || "").toLowerCase().trim().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
      items.forEach((it) => {
        if (it.nuit) {
          const k = `${it.nuit}|${it.sku}`;
          if (!itemsByNuitSku.has(k)) itemsByNuitSku.set(k, []);
          itemsByNuitSku.get(k).push(it);
        }
        const nk = `${norm(it.beneficiary_name)}|${it.sku}`;
        if (!itemsByNameSku.has(nk)) itemsByNameSku.set(nk, []);
        itemsByNameSku.get(nk).push(it);
      });

      // 2. Loop deliveries e tentar match
      const results = { matched: [], unmatched: [], skipped_status: [], plate_mismatch: false };

      // Aviso (não bloqueante) se a matrícula do PDF não bater com a do serviço
      const pdfPlate = (deliveries[0]?.matricula || "").toUpperCase().replace(/\s+/g, "");
      const svcPlate = (svc.truck_plate || "").toUpperCase().replace(/\s+/g, "");
      if (pdfPlate && svcPlate && !pdfPlate.includes(svcPlate.split("/")[0]) && !svcPlate.includes(pdfPlate.split("/")[0])) {
        results.plate_mismatch = true;
      }

      await conn.beginTransaction();
      try {
        for (const d of deliveries) {
          // Saltar DESCARTADO/CANCELADO (não fazem parte da carga real)
          if (d.estado && /DESCART|CANCEL/i.test(d.estado)) {
            results.skipped_status.push({ adsn: d.adsn, gtu: d.gtu, estado: d.estado, name: d.destinatario });
            continue;
          }
          // Match: NUIT primeiro
          let candidates = (d.nuit && d.sku && itemsByNuitSku.get(`${d.nuit}|${d.sku}`)) || [];
          // Fallback: nome
          if (!candidates.length && d.destinatario) {
            candidates = itemsByNameSku.get(`${norm(d.destinatario)}|${d.sku}`) || [];
          }
          // Discriminar por qty se múltiplos
          if (candidates.length > 1 && d.qty != null) {
            const exact = candidates.filter((c) => Math.abs(Number(c.qty) - d.qty) < 0.5);
            if (exact.length === 1) candidates = exact;
          }
          // Saltar items que já têm external_adsn (idempotente — re-upload é safe)
          candidates = candidates.filter((c) => !c.external_adsn);
          if (candidates.length === 1) {
            const it = candidates[0];
            await conn.query(
              "UPDATE delivery_service_items SET external_adsn = ?, external_gtu = ? WHERE id = ?",
              [d.adsn, d.gtu, it.id]
            );
            results.matched.push({
              item_id: it.id,
              adsn: d.adsn, gtu: d.gtu,
              beneficiary: it.beneficiary_name, sku: it.sku, qty: it.qty,
            });
            // Tirar do mapa para não fazer match outra vez
            const nk = `${norm(it.beneficiary_name)}|${it.sku}`;
            if (itemsByNameSku.has(nk)) itemsByNameSku.set(nk, itemsByNameSku.get(nk).filter((x) => x.id !== it.id));
            const nuk = `${it.nuit}|${it.sku}`;
            if (itemsByNuitSku.has(nuk)) itemsByNuitSku.set(nuk, itemsByNuitSku.get(nuk).filter((x) => x.id !== it.id));
          } else {
            results.unmatched.push({
              adsn: d.adsn, gtu: d.gtu, nuit: d.nuit,
              destinatario: d.destinatario, sku: d.sku, qty: d.qty,
              candidates: candidates.length,
              reason: candidates.length === 0 ? "no match" : "ambiguous",
            });
          }
        }

        // Atualizar service-level: external_gtu + adsn no campo notes (se ainda não existir)
        const aggregated = results.matched.length;
        if (aggregated > 0 && opts.aggregator) {
          const note = `[GUIA ADICIONAL] aggregator ADSE=${opts.aggregator.adse}, ${aggregated} items matched, total ${opts.aggregator.qty}kg, plate ${opts.aggregator.matricula}`;
          await conn.query(
            "UPDATE delivery_services SET notes = CONCAT(IFNULL(notes,''), '\\n', ?) WHERE id = ?",
            [note, serviceId]
          );
        }
        await conn.commit();
      } catch (e) {
        try { await conn.rollback(); } catch (_) {}
        throw e;
      }
      return results;
    } finally {
      conn.release();
    }
  },

  async dashboardCounts() {
    const rows = await query(
      `SELECT status, COUNT(*) AS n, SUM(total_kg) AS kg
       FROM delivery_services GROUP BY status`
    );
    const out = { draft: { n: 0, kg: 0 }, in_transit: { n: 0, kg: 0 }, delivered: { n: 0, kg: 0 }, cancelled: { n: 0, kg: 0 } };
    rows.forEach((r) => { out[r.status] = { n: Number(r.n) || 0, kg: Number(r.kg) || 0 }; });
    return out;
  },
};

module.exports = { Beneficiaries, Balances, Services };
