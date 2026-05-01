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

// Conversão de qty (na unidade nativa do produto) para kg físico no camião.
//   • kg  → kg directo (sementes)
//   • L   → kg ≈ 1L (químicos; ~densidade da água, aproximação aceitável p/ logística)
//   • un  → kg = qty × 0.3 (saco hermético = 0.3 kg cada)
const SACO_KG_PER_UNIT = 0.3;
function qtyToKg(qty, unit) {
  const n = Number(qty) || 0;
  if (unit === "un") return n * SACO_KG_PER_UNIT;
  return n; // kg ou L tratam-se como kg p/ peso do camião
}

const Beneficiaries = {
  async list(opts = {}) {
    const where = [];
    const params = [];
    if (opts.province) { where.push("b.province = ?"); params.push(opts.province); }
    if (opts.district) { where.push("b.district = ?"); params.push(opts.district); }
    if (opts.search) {
      where.push("(b.name LIKE ? OR b.nuit LIKE ? OR b.extensionist_id LIKE ?)");
      const s = "%" + opts.search + "%";
      params.push(s, s, s);
    }
    if (opts.kind === "extra") where.push("b.extensionist_id LIKE 'EXT-%'");
    if (opts.kind === "plan")  where.push("b.extensionist_id NOT LIKE 'EXT-%'");
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    // Cada benef mostra: totais agregados de saldo (planeado, entregue, falta)
    // + nº de produtos no plano. Permite ordenar por estes campos.
    return query(
      `SELECT b.extensionist_id, b.nuit, b.name, b.province, b.district, b.posto,
              b.contact, b.supervisor_name, b.supervisor_phone,
              CASE WHEN b.extensionist_id LIKE 'EXT-%' THEN 1 ELSE 0 END AS is_extra,
              COALESCE(s.n_products, 0)        AS n_products,
              COALESCE(s.planned_total, 0)     AS planned_total,
              COALESCE(s.committed_total, 0)   AS committed_total,
              COALESCE(s.available_total, 0)   AS available_total,
              COALESCE(svc.n_services, 0)      AS n_services
       FROM beneficiaries b
       LEFT JOIN (
         SELECT extensionist_id,
                COUNT(*) AS n_products,
                SUM(planned_qty) AS planned_total,
                SUM(committed_qty) AS committed_total,
                SUM(GREATEST(0, planned_qty - committed_qty)) AS available_total
         FROM delivery_balances
         GROUP BY extensionist_id
       ) s ON s.extensionist_id = b.extensionist_id
       LEFT JOIN (
         SELECT extensionist_id, COUNT(DISTINCT service_id) AS n_services
         FROM delivery_service_items
         GROUP BY extensionist_id
       ) svc ON svc.extensionist_id = b.extensionist_id
       ${w}
       ORDER BY b.name
       LIMIT 5000`,
      params
    );
  },
  async byId(extId) {
    return queryOne(
      `SELECT *, CASE WHEN extensionist_id LIKE 'EXT-%' THEN 1 ELSE 0 END AS is_extra
       FROM beneficiaries WHERE extensionist_id = ?`,
      [extId]
    );
  },

  // Perfil completo: dados + saldos por SKU + histórico de service items
  async profile(extId) {
    const benef = await queryOne(
      `SELECT *, CASE WHEN extensionist_id LIKE 'EXT-%' THEN 1 ELSE 0 END AS is_extra
       FROM beneficiaries WHERE extensionist_id = ?`,
      [extId]
    );
    if (!benef) return null;
    const balances = await query(
      `SELECT sku, product_name, unit, planned_original, realocado_recebido,
              planned_qty, committed_qty, delivered_qty,
              GREATEST(0, planned_qty - committed_qty) AS available_qty
       FROM delivery_balances
       WHERE extensionist_id = ?
       ORDER BY product_name`,
      [extId]
    );
    const history = await query(
      `SELECT i.id, i.sku, i.product_name, i.unit, i.qty,
              i.external_adsn, i.external_gtu,
              s.id AS service_id, s.service_number, s.status, s.truck_plate,
              s.driver_name, s.origem_supplier, s.created_at, s.dispatched_at,
              s.delivered_at, s.cancelled_at, s.province, s.district
       FROM delivery_service_items i
       JOIN delivery_services s ON s.id = i.service_id
       WHERE i.extensionist_id = ?
       ORDER BY s.created_at DESC, s.id DESC`,
      [extId]
    );
    // Aggregations
    const totalsByStatus = { draft: 0, in_transit: 0, delivered: 0, cancelled: 0 };
    history.forEach((h) => {
      if (totalsByStatus[h.status] != null) totalsByStatus[h.status] += Number(h.qty) || 0;
    });
    return { beneficiary: benef, balances, history, totals_by_status: totalsByStatus };
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
    if (opts.province)  { where.push("b.province = ?");  params.push(opts.province); }
    if (opts.district)  { where.push("b.district = ?");  params.push(opts.district); }
    if (opts.sku)       { where.push("b.sku = ?");       params.push(opts.sku); }
    if (opts.extensionist_id) { where.push("b.extensionist_id = ?"); params.push(opts.extensionist_id); }
    if (opts.onlyAvailable) where.push("(b.planned_qty - b.committed_qty) > 0");
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = opts.limit ? `LIMIT ${Number(opts.limit)}` : "LIMIT 5000";
    // Junta posto admin (de beneficiaries) e last_delivery_at (max
    // delivered_at sobre items deste benef×sku). last_delivery_at NULL =
    // nunca recebeu nada deste produto → topo na ordenação ASC (urgente).
    return query(
      `SELECT b.extensionist_id, b.sku, b.product_name, b.unit, b.province, b.district,
              b.beneficiary_name,
              b.planned_original, b.realocado_recebido,
              b.planned_qty, b.committed_qty, b.delivered_qty,
              GREATEST(0, b.planned_qty - b.committed_qty) AS available_qty,
              ben.posto AS posto,
              ld.last_delivery_at
       FROM delivery_balances b
       LEFT JOIN beneficiaries ben ON ben.extensionist_id = b.extensionist_id
       LEFT JOIN (
         SELECT i.extensionist_id, i.sku, MAX(s.delivered_at) AS last_delivery_at
         FROM delivery_service_items i
         JOIN delivery_services s ON s.id = i.service_id
         WHERE s.status = 'delivered'
         GROUP BY i.extensionist_id, i.sku
       ) ld ON ld.extensionist_id = b.extensionist_id AND ld.sku = b.sku
       ${w}
       ORDER BY b.district, b.beneficiary_name, b.sku
       ${limit}`,
      params
    );
  },

  // Resumo agregado para uma seleção: total kg/L/un por unidade. Aceita
  // filtros province/district/sku — se filtrado por SKU, devolve só dados
  // da unidade desse SKU.
  async summary(opts = {}) {
    const where = ["planned_qty > 0"];
    const params = [];
    if (opts.province) { where.push("province = ?"); params.push(opts.province); }
    if (opts.district) { where.push("district = ?"); params.push(opts.district); }
    if (opts.sku)      { where.push("sku = ?");      params.push(opts.sku); }
    const w = "WHERE " + where.join(" AND ");
    const aggRows = await query(
      `SELECT unit,
              SUM(planned_original)         AS planned_original,
              SUM(realocado_recebido)       AS realocado_recebido,
              SUM(planned_qty)              AS planned,
              SUM(committed_qty)            AS committed,
              SUM(delivered_qty)            AS delivered,
              SUM(GREATEST(0, planned_qty - committed_qty)) AS available,
              COUNT(*)                      AS n_rows
       FROM delivery_balances ${w} GROUP BY unit`,
      params
    );
    const out = { kg: {}, L: {}, un: {} };
    aggRows.forEach((r) => {
      out[r.unit] = {
        planned_original: Number(r.planned_original) || 0,
        realocado_recebido: Number(r.realocado_recebido) || 0,
        planned: Number(r.planned) || 0,
        committed: Number(r.committed) || 0,
        delivered: Number(r.delivered) || 0,
        available: Number(r.available) || 0,
        rows: Number(r.n_rows) || 0,
      };
    });
    // Distinct beneficiaries (only those with saldo > 0 to match the table view)
    const benRows = await query(
      `SELECT COUNT(DISTINCT extensionist_id) AS n
       FROM delivery_balances ${w} AND (planned_qty - committed_qty) > 0`,
      params
    );
    out.beneficiaries = Number(benRows[0]?.n) || 0;
    out.beneficiaries_total = (await query(
      `SELECT COUNT(DISTINCT extensionist_id) AS n FROM delivery_balances ${w}`,
      params
    ))[0]?.n || 0;
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

      // Validar capacidade do camião — peso REAL em kg (sacos × 0.3, etc.)
      const balKeys2 = items.map((it) => [it.extensionist_id, it.sku]);
      const ph2 = balKeys2.map(() => "(?,?)").join(",");
      const [unitRows] = await conn.query(
        `SELECT extensionist_id, sku, unit FROM delivery_balances WHERE (extensionist_id, sku) IN (${ph2})`,
        balKeys2.flat()
      );
      const unitMap = new Map(unitRows.map((u) => [`${u.extensionist_id}|${u.sku}`, u.unit]));
      const totalKg = items.reduce((s, it) => {
        const u = unitMap.get(`${it.extensionist_id}|${it.sku}`) || "kg";
        return s + qtyToKg(it.qty, u);
      }, 0);
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
      // Decide approval requirement post-commit (separate UPDATE)
      await this.maybeRequireApproval(serviceId);
      // Re-fetch approval_status to inform caller
      const svc = await queryOne("SELECT approval_status FROM delivery_services WHERE id = ?", [serviceId]);
      return {
        ok: true,
        service_id: serviceId,
        service_number: serviceNumber,
        total_kg: totalKg,
        approval_status: svc?.approval_status || "not_required",
      };
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      conn.release();
    }
  },

  // Edita campos editáveis de um serviço em DRAFT.
  // Permite corrigir matrícula, motorista, telefone, origem, capacidade,
  // notas. Não toca em itens (para isso é cancelar + recriar).
  async update(serviceId, patch) {
    const allowed = [
      "truck_plate", "truck_plate_2", "driver_name", "driver_phone",
      "origem_supplier", "truck_capacity_kg", "notes",
    ];
    const sets = [];
    const params = [];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        sets.push(`${k} = ?`);
        let v = patch[k];
        if (k === "truck_plate" || k === "truck_plate_2") {
          v = v ? String(v).toUpperCase().trim() : null;
        } else if (k === "truck_capacity_kg") {
          v = Number(v) || 0;
        } else if (typeof v === "string") {
          v = v.trim() || null;
        }
        params.push(v);
      }
    }
    if (!sets.length) return { error: "Nada para actualizar" };

    const conn = await getPool().getConnection();
    try {
      const [r] = await conn.query(
        `UPDATE delivery_services SET ${sets.join(", ")}
         WHERE id = ? AND status = 'draft'`,
        [...params, serviceId]
      );
      if (r.affectedRows === 0) {
        return { error: "Serviço não está em rascunho — não pode ser editado" };
      }
      return { ok: true };
    } finally {
      conn.release();
    }
  },

  // Pre-flight checks antes de pôr em trânsito. Devolve { ok:true, warnings }
  // ou { error:"…", details:{…} } se algo crítico falhar.
  // Validações:
  //   - Serviço está em draft
  //   - truck_plate definida e em formato razoável (ex: AAB 450 MP)
  //   - driver_name definido
  //   - driver_phone se definido, ≥ 9 dígitos
  //   - capacidade > 0
  //   - total_kg ≤ truck_capacity_kg (já checado no create, mas re-confirma)
  async preflightCheck(serviceId) {
    const svc = await queryOne("SELECT * FROM delivery_services WHERE id = ?", [serviceId]);
    if (!svc) return { error: "Serviço não existe" };
    if (svc.status !== "draft") return { error: "Serviço já saiu do rascunho", details: { status: svc.status } };
    const errors = [];
    const warnings = [];
    const plate = (svc.truck_plate || "").trim();
    if (!plate) errors.push("Matrícula em falta");
    else if (!/^[A-Z]{2,4}[\s-]?\d{2,4}[\s-]?[A-Z]{2}$/i.test(plate)) {
      warnings.push(`Matrícula "${plate}" tem formato fora do padrão (esperado: XXX 000 XX)`);
    }
    if (!svc.driver_name || !svc.driver_name.trim()) errors.push("Motorista em falta");
    if (svc.driver_phone) {
      const digits = svc.driver_phone.replace(/\D/g, "");
      if (digits.length < 9) warnings.push(`Telefone do motorista parece incompleto (${digits.length} dígitos)`);
    } else {
      warnings.push("Telefone do motorista não definido");
    }
    if (!svc.truck_capacity_kg || svc.truck_capacity_kg <= 0) {
      warnings.push("Capacidade do camião não definida");
    } else if (Number(svc.total_kg) > Number(svc.truck_capacity_kg)) {
      errors.push(`Carga (${svc.total_kg} kg) excede capacidade (${svc.truck_capacity_kg} kg)`);
    }
    return { ok: errors.length === 0, errors, warnings };
  },

  // Threshold acima do qual um serviço REQUER aprovação admin antes de
  // poder ir para trânsito. Default: 20 toneladas. Configurável via env.
  APPROVAL_THRESHOLD_KG: Number(process.env.SERVICE_APPROVAL_KG) || 20000,

  // Marca um serviço como precisando de aprovação se a sua carga
  // ultrapassar o threshold. Chamado dentro do create.
  async maybeRequireApproval(serviceId) {
    const conn = await getPool().getConnection();
    try {
      const threshold = this.APPROVAL_THRESHOLD_KG;
      await conn.query(
        `UPDATE delivery_services
         SET approval_status = CASE
           WHEN total_kg >= ? THEN 'pending'
           ELSE 'not_required'
         END
         WHERE id = ?`,
        [threshold, serviceId]
      );
    } finally { conn.release(); }
  },

  async approve(serviceId, userId, notes) {
    const ts = now();
    const conn = await getPool().getConnection();
    try {
      const [r] = await conn.query(
        `UPDATE delivery_services
         SET approval_status = 'approved', approved_at = ?, approved_by = ?, approval_notes = ?
         WHERE id = ? AND approval_status = 'pending'`,
        [ts, userId || null, notes || null, serviceId]
      );
      if (r.affectedRows === 0) return { error: "Serviço não está pendente de aprovação" };
      return { ok: true };
    } finally { conn.release(); }
  },

  async reject(serviceId, userId, reason) {
    const ts = now();
    const conn = await getPool().getConnection();
    try {
      const [r] = await conn.query(
        `UPDATE delivery_services
         SET approval_status = 'rejected', approved_at = ?, approved_by = ?, approval_notes = ?
         WHERE id = ? AND approval_status = 'pending'`,
        [ts, userId || null, reason || null, serviceId]
      );
      if (r.affectedRows === 0) return { error: "Serviço não está pendente de aprovação" };
      return { ok: true };
    } finally { conn.release(); }
  },

  async listPendingApproval() {
    return query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM delivery_service_items WHERE service_id = s.id) AS n_items,
              (SELECT COUNT(DISTINCT extensionist_id) FROM delivery_service_items WHERE service_id = s.id) AS n_beneficiaries
       FROM delivery_services s
       WHERE s.approval_status = 'pending' AND s.status = 'draft'
       ORDER BY s.created_at DESC`
    );
  },

  // Avança estado: draft → in_transit (carregou) → delivered (chegou). Cancelar é noutra função.
  // Aceita opt force=true para bypass de warnings (mas erros sempre bloqueiam).
  async setInTransit(serviceId, opts = {}) {
    // Permite editar campos finais antes do pre-flight (motorista, etc)
    if (opts.truck_plate || opts.driver_name || opts.driver_phone) {
      await this.update(serviceId, opts);
    }
    // Bloqueia se aprovação pendente
    const svcCheck = await queryOne(
      "SELECT approval_status FROM delivery_services WHERE id = ?",
      [serviceId]
    );
    if (svcCheck && svcCheck.approval_status === "pending") {
      return { error: "Serviço requer aprovação de admin antes de ir para trânsito" };
    }
    if (svcCheck && svcCheck.approval_status === "rejected") {
      return { error: "Serviço foi rejeitado — não pode ir para trânsito" };
    }
    const check = await this.preflightCheck(serviceId);
    if (check.error) return { error: check.error };
    if (check.errors && check.errors.length) {
      return { error: "Pre-flight check falhou", check };
    }
    if (!opts.force && check.warnings && check.warnings.length) {
      // Se houver warnings e o caller não disse force, devolve para confirmar
      return { needs_confirm: true, check };
    }
    const ts = now();
    const conn = await getPool().getConnection();
    try {
      const [res] = await conn.query(
        `UPDATE delivery_services
         SET status = 'in_transit', dispatched_at = ?
         WHERE id = ? AND status = 'draft'`,
        [ts, serviceId]
      );
      if (res.affectedRows === 0) {
        return { error: "Serviço já não está em rascunho" };
      }
      return { ok: true, warnings: check.warnings || [] };
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

  // Categorias válidas de cancelamento. Mantemos como const para a UI
  // saber o que mostrar e o backend para validar.
  CANCEL_CATEGORIES: {
    truck_breakdown:     "Avaria do camião",
    weather:             "Condições meteorológicas",
    benef_unreachable:   "Beneficiário não alcançável",
    wrong_data:          "Dados incorrectos no plano",
    insufficient_stock:  "Stock insuficiente",
    other:               "Outro",
  },

  // Cancela: liberta saldo (committed_qty -= qty). Se já estava 'delivered' não permite.
  // Aceita { reason, category }. Categoria é validada contra CANCEL_CATEGORIES.
  async cancel(serviceId, opts = {}) {
    const reason = opts.reason || null;
    const category = opts.category && this.CANCEL_CATEGORIES[opts.category]
      ? opts.category : null;
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
         SET status = 'cancelled', cancelled_at = ?,
             cancellation_category = ?, cancellation_reason = ?
         WHERE id = ?`,
        [ts, category, reason, serviceId]
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

  // ── Bulk operations ────────────────────────────────────────
  // Aplica setDelivered a vários serviços. Para-se ao primeiro erro
  // mas retorna o que conseguiu fazer.
  async bulkSetDelivered(serviceIds) {
    const results = { ok: [], failed: [] };
    for (const id of serviceIds) {
      try {
        const r = await this.setDelivered(id);
        if (r.ok) results.ok.push(id);
        else results.failed.push({ id, error: r.error });
      } catch (e) {
        results.failed.push({ id, error: e.message });
      }
    }
    return results;
  },

  async bulkCancel(serviceIds, opts = {}) {
    const results = { ok: [], failed: [] };
    for (const id of serviceIds) {
      try {
        const r = await this.cancel(id, opts);
        if (r.ok) results.ok.push(id);
        else results.failed.push({ id, error: r.error });
      } catch (e) {
        results.failed.push({ id, error: e.message });
      }
    }
    return results;
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
    if (opts.min_kg != null && opts.min_kg !== "") {
      where.push("total_kg >= ?"); params.push(Number(opts.min_kg));
    }
    if (opts.max_kg != null && opts.max_kg !== "") {
      where.push("total_kg <= ?"); params.push(Number(opts.max_kg));
    }
    if (opts.driver) {
      where.push("driver_name LIKE ?"); params.push("%" + opts.driver + "%");
    }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";

    // Paginação: page (1-based) + pageSize. Se ambos omitidos, fallback ao
    // comportamento antigo (LIMIT só, sem total). Quando paginado, devolve
    // { rows, total, page, pageSize, totalPages }.
    if (opts.page || opts.pageSize) {
      const pageSize = Math.max(1, Math.min(500, Number(opts.pageSize) || 50));
      const page = Math.max(1, Number(opts.page) || 1);
      const offset = (page - 1) * pageSize;
      const [{ total }] = await query(
        `SELECT COUNT(*) AS total FROM delivery_services s ${w}`,
        params
      );
      const rows = await query(
        `SELECT s.*,
                (SELECT COUNT(*) FROM delivery_service_items WHERE service_id = s.id) AS n_items,
                (SELECT COUNT(DISTINCT extensionist_id) FROM delivery_service_items WHERE service_id = s.id) AS n_beneficiaries
         FROM delivery_services s
         ${w}
         ORDER BY created_at DESC
         LIMIT ${pageSize} OFFSET ${offset}`,
        params
      );
      const totalNum = Number(total) || 0;
      return { rows, total: totalNum, page, pageSize, totalPages: Math.ceil(totalNum / pageSize) };
    }

    // Modo legado: simples array
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
          // DEFENSIVE GUARD: ADSE é a capa do camião, NÃO uma entrega.
          // O parser já filtra mas garantimos aqui também (defense in depth).
          if (d.adsn && /^ADSE/i.test(d.adsn)) {
            console.warn("[attach-guia] ignorando ADSE (capa, não entrega):", d.adsn);
            continue;
          }
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

  // Resumo da frota — aceita os mesmos filtros que list().
  // Devolve: nº camiões, nº beneficiários cobertos, total kg, capacidade
  // total, capacidade média, distritos cobertos, fornecedores envolvidos.
  async fleetSummary(opts = {}) {
    const where = [];
    const params = [];
    if (opts.status)   { where.push("s.status = ?");   params.push(opts.status); }
    if (opts.province) { where.push("s.province = ?"); params.push(opts.province); }
    if (opts.district) { where.push("s.district = ?"); params.push(opts.district); }
    if (opts.plate)    {
      where.push("(s.truck_plate LIKE ? OR s.truck_plate_2 LIKE ?)");
      params.push("%" + opts.plate.toUpperCase() + "%", "%" + opts.plate.toUpperCase() + "%");
    }
    if (opts.supplier) { where.push("s.origem_supplier LIKE ?"); params.push("%" + opts.supplier + "%"); }
    if (opts.min_kg != null && opts.min_kg !== "") { where.push("s.total_kg >= ?"); params.push(Number(opts.min_kg)); }
    if (opts.max_kg != null && opts.max_kg !== "") { where.push("s.total_kg <= ?"); params.push(Number(opts.max_kg)); }
    if (opts.driver)   { where.push("s.driver_name LIKE ?"); params.push("%" + opts.driver + "%"); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const rows = await query(
      `SELECT
         COUNT(*) AS n_trucks,
         COALESCE(SUM(s.total_kg), 0) AS total_kg,
         COALESCE(SUM(s.truck_capacity_kg), 0) AS total_capacity_kg,
         COALESCE(AVG(NULLIF(s.truck_capacity_kg, 0)), 0) AS avg_capacity_kg,
         COUNT(DISTINCT s.district) AS n_districts,
         COUNT(DISTINCT s.origem_supplier) AS n_suppliers,
         COUNT(DISTINCT s.truck_plate) AS n_plates,
         (SELECT COUNT(DISTINCT i.extensionist_id)
            FROM delivery_service_items i
            JOIN delivery_services s2 ON s2.id = i.service_id
            ${w.replace(/s\./g, "s2.")}
         ) AS n_beneficiaries
       FROM delivery_services s
       ${w}`,
      [...params, ...params]
    );
    const r = rows[0] || {};
    return {
      n_trucks: Number(r.n_trucks) || 0,
      total_kg: Number(r.total_kg) || 0,
      total_capacity_kg: Number(r.total_capacity_kg) || 0,
      avg_capacity_kg: Number(r.avg_capacity_kg) || 0,
      utilization_pct: r.total_capacity_kg > 0
        ? +((r.total_kg / r.total_capacity_kg) * 100).toFixed(1) : 0,
      n_districts: Number(r.n_districts) || 0,
      n_suppliers: Number(r.n_suppliers) || 0,
      n_plates: Number(r.n_plates) || 0,
      n_beneficiaries: Number(r.n_beneficiaries) || 0,
    };
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

  // Dashboard agregado — reúne tudo o que o operador quer ver no /admin:
  // Por produto: planeado, entregue, falta, % cumprimento.
  // Por estado de serviço: contagens + total kg.
  // Top distritos com mais saldo. Camiões em trânsito.
  // Alertas: drafts > 7d, in_transit > 48h, benefs nunca atendidos.
  // Actividade recente: últimos 10 serviços por created_at.
  async dashboard() {
    // 1. Saldos por produto canónico
    const byProduct = await query(
      `SELECT sku, product_name, unit,
              SUM(planned_qty) AS planned,
              SUM(committed_qty) AS committed,
              SUM(GREATEST(0, planned_qty - committed_qty)) AS available,
              COUNT(*) AS n_benefs
       FROM delivery_balances
       WHERE planned_qty > 0
       GROUP BY sku, product_name, unit
       ORDER BY planned DESC`
    );

    // 2. Status counts (já tem fleetSummary p/ trânsito; aqui pegamos counts tudo)
    const counts = await this.dashboardCounts();

    // 3. Top 8 distritos por falta total (kg-equiv: un × 0.3)
    const topDistricts = await query(
      `SELECT province, district,
              SUM(GREATEST(0, planned_qty - committed_qty) *
                CASE WHEN unit = 'un' THEN 0.3 ELSE 1 END) AS falta_kg_eq,
              COUNT(DISTINCT extensionist_id) AS n_benefs
       FROM delivery_balances
       WHERE planned_qty > 0 AND district IS NOT NULL
       GROUP BY province, district
       HAVING falta_kg_eq > 0
       ORDER BY falta_kg_eq DESC
       LIMIT 8`
    );

    // 4. Camiões em trânsito agora (top 6 por dispatched_at desc)
    const inTransit = await query(
      `SELECT s.id, s.service_number, s.truck_plate, s.driver_name,
              s.province, s.district, s.origem_supplier, s.total_kg,
              s.truck_capacity_kg, s.dispatched_at,
              (SELECT COUNT(DISTINCT i.extensionist_id) FROM delivery_service_items i WHERE i.service_id = s.id) AS n_beneficiaries
       FROM delivery_services s
       WHERE s.status = 'in_transit'
       ORDER BY s.dispatched_at DESC LIMIT 6`
    );

    // 5. Alertas
    const alerts = [];
    // Drafts criados há > 7 dias (esquecidos)
    const oldDrafts = await query(
      `SELECT id, service_number, district, total_kg, created_at,
              TIMESTAMPDIFF(DAY, created_at, NOW()) AS days_old
       FROM delivery_services
       WHERE status = 'draft' AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
       ORDER BY created_at LIMIT 5`
    );
    if (oldDrafts.length) {
      alerts.push({
        kind: "warn",
        title: `${oldDrafts.length} draft${oldDrafts.length === 1 ? "" : "s"} parado${oldDrafts.length === 1 ? "" : "s"} > 7 dias`,
        items: oldDrafts.map((d) => ({
          link: "/admin/servicos/" + d.id,
          label: `${d.service_number} (${d.district}) — ${d.days_old} dias em rascunho`,
        })),
      });
    }
    // Trânsitos parados há > 48h
    const stuckTransit = await query(
      `SELECT id, service_number, truck_plate, district, total_kg, dispatched_at,
              TIMESTAMPDIFF(HOUR, dispatched_at, NOW()) AS hours_stuck
       FROM delivery_services
       WHERE status = 'in_transit' AND dispatched_at < DATE_SUB(NOW(), INTERVAL 48 HOUR)
       ORDER BY dispatched_at LIMIT 5`
    );
    if (stuckTransit.length) {
      alerts.push({
        kind: "err",
        title: `${stuckTransit.length} cami${stuckTransit.length === 1 ? "ão parado" : "ões parados"} > 48h`,
        items: stuckTransit.map((t) => ({
          link: "/admin/servicos/" + t.id,
          label: `${t.truck_plate || t.service_number} → ${t.district} • há ${t.hours_stuck}h em trânsito`,
        })),
      });
    }
    // Beneficiários nunca atendidos com saldo elevado (top 5 por saldo)
    const neverServed = await query(
      `SELECT b.extensionist_id, b.beneficiary_name, b.district, b.product_name,
              GREATEST(0, b.planned_qty - b.committed_qty) AS available_qty, b.unit
       FROM delivery_balances b
       LEFT JOIN delivery_service_items i ON i.extensionist_id = b.extensionist_id
       WHERE b.planned_qty > 0 AND (b.planned_qty - b.committed_qty) > 0
         AND i.id IS NULL
       ORDER BY available_qty DESC LIMIT 5`
    );
    if (neverServed.length) {
      alerts.push({
        kind: "info",
        title: `${neverServed.length} beneficiários com saldo grande nunca atendidos`,
        items: neverServed.map((b) => ({
          link: "/admin/beneficiarios/" + encodeURIComponent(b.extensionist_id),
          label: `${b.beneficiary_name} (${b.district}) — falta ${Number(b.available_qty).toLocaleString("pt-PT")} ${b.unit} de ${b.product_name}`,
        })),
      });
    }

    // 6. Actividade recente — 10 últimos serviços criados ou entregues
    const recent = await query(
      `SELECT id, service_number, status, district, truck_plate, total_kg,
              created_at, dispatched_at, delivered_at
       FROM delivery_services
       ORDER BY GREATEST(
         COALESCE(delivered_at, '1970-01-01'),
         COALESCE(dispatched_at, '1970-01-01'),
         COALESCE(created_at, '1970-01-01')
       ) DESC
       LIMIT 10`
    );

    return {
      by_product: byProduct,
      counts,
      top_districts: topDistricts,
      in_transit: inTransit,
      alerts,
      recent_activity: recent,
    };
  },
};

// ── Reconciliação Sheet ↔ DB por GTU ────────────────────────
// Cruza os GTUs presentes na Google Sheet (dashboard público) com os
// nossos delivery_service_items.external_gtu. Reporta quem está em
// ambos / só na sheet / só na DB. Útil para identificar entregas que
// já foram registadas pelo terreno mas o nosso DB ainda não actualizou
// (e vice-versa).
const Reconciliation = {
  // sheetRows: [ { delivery_note_number, delivered_qty, beneficiary_name, … } ]
  async vsSheet(sheetRows) {
    // Normaliza GTUs do sheet (replace backslash, trim, uppercase)
    const sheetByGtu = new Map();
    (sheetRows || []).forEach((r) => {
      const raw = String(r.delivery_note_number || "").trim().replace(/\\/g, "/").toUpperCase();
      if (!raw) return;
      if (!sheetByGtu.has(raw)) sheetByGtu.set(raw, []);
      sheetByGtu.get(raw).push(r);
    });

    const dbRows = await query(
      `SELECT i.id AS item_id, i.external_gtu, i.external_adsn,
              i.beneficiary_name, i.product_name, i.qty, i.unit,
              s.id AS service_id, s.service_number, s.status, s.truck_plate,
              s.dispatched_at, s.delivered_at
       FROM delivery_service_items i
       JOIN delivery_services s ON s.id = i.service_id
       WHERE i.external_gtu IS NOT NULL`
    );
    const dbByGtu = new Map();
    dbRows.forEach((r) => {
      const k = String(r.external_gtu).trim().toUpperCase();
      if (!dbByGtu.has(k)) dbByGtu.set(k, []);
      dbByGtu.get(k).push(r);
    });

    // Match: GTUs em ambos
    const matched = [];
    const onlyInDb = [];
    for (const [gtu, items] of dbByGtu.entries()) {
      if (sheetByGtu.has(gtu)) matched.push({ gtu, db: items, sheet: sheetByGtu.get(gtu) });
      else onlyInDb.push({ gtu, items });
    }
    const onlyInSheet = [];
    for (const [gtu, rows] of sheetByGtu.entries()) {
      if (!dbByGtu.has(gtu)) onlyInSheet.push({ gtu, rows });
    }

    return {
      matched_count: matched.length,
      only_in_db_count: onlyInDb.length,
      only_in_sheet_count: onlyInSheet.length,
      matched_sample: matched.slice(0, 20),
      only_in_db_sample: onlyInDb.slice(0, 50),
      only_in_sheet_sample: onlyInSheet.slice(0, 50),
      sheet_total: sheetByGtu.size,
      db_total: dbByGtu.size,
    };
  },
};

// ── Manutenção ──────────────────────────────────────────────
const Maintenance = {
  // Recompute delivery_services.total_kg a partir dos items (com qtyToKg).
  // Útil depois de imports históricos onde a soma de qty bruta misturava
  // unidades (sacos contavam como kg, etc.).
  async recomputeAllTotalKg() {
    const conn = await getPool().getConnection();
    let updated = 0;
    try {
      // Recalcular em SQL (CASE WHEN unit) é mais rápido que iterar.
      const [r] = await conn.query(
        `UPDATE delivery_services s
         SET total_kg = COALESCE((
           SELECT SUM(CASE WHEN i.unit = 'un' THEN i.qty * ${SACO_KG_PER_UNIT} ELSE i.qty END)
           FROM delivery_service_items i
           WHERE i.service_id = s.id
         ), 0)`
      );
      updated = r.affectedRows || r.changedRows || 0;
    } finally {
      conn.release();
    }
    return { updated };
  },
};

// ── Relatórios ──────────────────────────────────────────────
// Ordem geográfica norte→sul de Moçambique para apresentação consistente.
const PROVINCE_ORDER = [
  "Cabo Delgado", "Niassa", "Nampula", "Zambézia", "Tete",
  "Manica", "Sofala", "Inhambane", "Gaza",
  "Maputo Província", "Maputo Cidade",
];

const Reports = {
  PROVINCE_ORDER,

  // Relatório consolidado por província.
  // opts: { from, to, status='delivered'|'committed', sku, district }
  //  - status='delivered': só status='delivered'
  //  - status='committed': inclui in_transit (já carregado, vai chegar)
  //  - from/to filtra por delivered_at (delivered) ou created_at (committed)
  async byProvince(opts = {}) {
    const status = opts.status === "committed" ? "committed" : "delivered";
    const statuses = status === "committed" ? ["in_transit", "delivered"] : ["delivered"];
    const dateCol = status === "committed" ? "s.created_at" : "s.delivered_at";

    // mysql2.execute() (prepared) NÃO expande arrays — gera placeholders manualmente
    const statusPh = statuses.map(() => "?").join(",");
    const where = [`s.status IN (${statusPh})`];
    const params = [...statuses];
    if (opts.from)     { where.push(`${dateCol} >= ?`); params.push(opts.from); }
    if (opts.to)       { where.push(`${dateCol} <= ?`); params.push(opts.to + " 23:59:59"); }
    if (opts.sku)      { where.push("i.sku = ?"); params.push(opts.sku); }
    if (opts.province) { where.push("COALESCE(s.province, i.province) = ?"); params.push(opts.province); }
    if (opts.district) { where.push("COALESCE(s.district, i.district) = ?"); params.push(opts.district); }

    // Linhas de entrega: província + SKU + unidade
    const delivered = await query(
      `SELECT COALESCE(s.province, i.province) AS province,
              i.sku,
              i.product_name,
              i.unit,
              SUM(i.qty) AS qty,
              COUNT(DISTINCT i.extensionist_id) AS n_beneficiaries,
              COUNT(DISTINCT s.id) AS n_services
       FROM delivery_services s
       JOIN delivery_service_items i ON i.service_id = s.id
       WHERE ${where.join(" AND ")}
       GROUP BY province, i.sku, i.product_name, i.unit
       ORDER BY province, i.sku`,
      params
    );

    // Planeado total por província+SKU (para % progresso). Independente
    // do filtro de período — planeado é o universo total.
    const plannedWhere = ["province IS NOT NULL"];
    const plannedParams = [];
    if (opts.sku)      { plannedWhere.push("sku = ?"); plannedParams.push(opts.sku); }
    if (opts.province) { plannedWhere.push("province = ?"); plannedParams.push(opts.province); }
    if (opts.district) { plannedWhere.push("district = ?"); plannedParams.push(opts.district); }

    const planned = await query(
      `SELECT province, sku, unit,
              SUM(planned_qty) AS qty_planned,
              SUM(delivered_qty) AS qty_delivered_balances,
              COUNT(*) AS n_beneficiaries_planned
       FROM delivery_balances
       WHERE ${plannedWhere.join(" AND ")}
       GROUP BY province, sku, unit
       ORDER BY province, sku`,
      plannedParams
    );

    // SKUs distintos presentes (para construir colunas no front-end)
    const skuMap = new Map();
    for (const r of delivered) {
      if (!skuMap.has(r.sku)) skuMap.set(r.sku, { sku: r.sku, product_name: r.product_name, unit: r.unit });
    }
    for (const r of planned) {
      if (!skuMap.has(r.sku)) skuMap.set(r.sku, { sku: r.sku, product_name: r.sku, unit: r.unit });
    }
    const skus = [...skuMap.values()].sort((a, b) => a.sku.localeCompare(b.sku));

    // Províncias presentes ordenadas geograficamente (e fallback alfabético)
    const provSet = new Set();
    for (const r of delivered) if (r.province) provSet.add(r.province);
    for (const r of planned)   if (r.province) provSet.add(r.province);
    const provinces = [...provSet].sort((a, b) => {
      const ia = PROVINCE_ORDER.indexOf(a); const ib = PROVINCE_ORDER.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });

    // Totais gerais
    let totalKg = 0, totalUn = 0;
    const benefSet = new Set();
    const svcSet = new Set();
    for (const r of delivered) {
      const q = Number(r.qty || 0);
      if (r.unit === "un") totalUn += q; else totalKg += q;
    }
    // n_beneficiaries/n_services únicos não são deduzíveis por GROUP BY normal;
    // fazemos uma query rápida só para totais distintos.
    const [totRow] = await query(
      `SELECT COUNT(DISTINCT i.extensionist_id) AS n_beneficiaries,
              COUNT(DISTINCT s.id) AS n_services
       FROM delivery_services s
       JOIN delivery_service_items i ON i.service_id = s.id
       WHERE ${where.join(" AND ")}`,
      params
    );

    return {
      filters: { ...opts, status },
      provinces,
      skus,
      delivered,
      planned,
      totals: {
        total_kg: totalKg,
        total_un: totalUn,
        n_provinces: provinces.length,
        n_beneficiaries: Number(totRow?.n_beneficiaries || 0),
        n_services: Number(totRow?.n_services || 0),
      },
    };
  },

  // Drill-down: distritos dentro de uma província
  async byDistrict(province, opts = {}) {
    if (!province) throw new Error("province obrigatória");
    const status = opts.status === "committed" ? "committed" : "delivered";
    const statuses = status === "committed" ? ["in_transit", "delivered"] : ["delivered"];
    const dateCol = status === "committed" ? "s.created_at" : "s.delivered_at";

    const statusPh = statuses.map(() => "?").join(",");
    const where = [`s.status IN (${statusPh})`, "COALESCE(s.province, i.province) = ?"];
    const params = [...statuses, province];
    if (opts.from) { where.push(`${dateCol} >= ?`); params.push(opts.from); }
    if (opts.to)   { where.push(`${dateCol} <= ?`); params.push(opts.to + " 23:59:59"); }
    if (opts.sku)  { where.push("i.sku = ?"); params.push(opts.sku); }

    return query(
      `SELECT COALESCE(s.district, i.district) AS district,
              i.sku, i.product_name, i.unit,
              SUM(i.qty) AS qty,
              COUNT(DISTINCT i.extensionist_id) AS n_beneficiaries,
              COUNT(DISTINCT s.id) AS n_services
       FROM delivery_services s
       JOIN delivery_service_items i ON i.service_id = s.id
       WHERE ${where.join(" AND ")}
       GROUP BY district, i.sku, i.product_name, i.unit
       ORDER BY district, i.sku`,
      params
    );
  },
};

module.exports = { Beneficiaries, Balances, Services, Reconciliation, Maintenance, Reports, qtyToKg };
