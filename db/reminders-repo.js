/**
 * Reminders / Lembretes — CRUD e queries auxiliares.
 *
 * Schema vive em db/mysql.js (migração idempotente). Aqui só lógica.
 *
 * Estados:
 *   active    — pendente (default)
 *   done      — tratado pelo utilizador
 *   dismissed — descartado sem fazer
 *
 * Vencimento:
 *   remind_at = NULL  → só info, nunca vence
 *   remind_at <= NOW() & status='active' → vencido (aparece em banner)
 */

const { query, queryOne } = require("./mysql");

const Reminders = {
  /**
   * @param {object} input
   * @param {string} input.title
   * @param {string} [input.body]
   * @param {string} [input.remind_at] ISO string or "YYYY-MM-DD HH:MM:SS"
   * @param {'low'|'normal'|'high'} [input.priority]
   * @param {string} [input.related_kind] ex: 'service' | 'truck' | 'beneficiary'
   * @param {string} [input.related_id]
   * @param {number} [userId] criador
   */
  async create(input, userId = null) {
    const title = String(input.title || "").trim();
    if (!title) throw new Error("Título obrigatório");
    const body = input.body ? String(input.body).trim() : null;
    const remindAt = input.remind_at ? new Date(input.remind_at) : null;
    if (remindAt && Number.isNaN(remindAt.getTime())) {
      throw new Error("remind_at inválido (use formato ISO ou YYYY-MM-DD HH:MM)");
    }
    const priority = ["low", "normal", "high"].includes(input.priority) ? input.priority : "normal";
    const relatedKind = input.related_kind ? String(input.related_kind).slice(0, 32) : null;
    const relatedId = input.related_id ? String(input.related_id).slice(0, 64) : null;
    const result = await query(
      `INSERT INTO reminders
         (title, body, remind_at, priority, status, related_kind, related_id, created_by, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NOW())`,
      [title, body, remindAt, priority, relatedKind, relatedId, userId]
    );
    return await this.byId(result.insertId);
  },

  async update(id, patch, userId = null) {
    const sets = [];
    const params = [];
    if (patch.title != null) {
      const t = String(patch.title).trim();
      if (!t) throw new Error("Título não pode ser vazio");
      sets.push("title = ?"); params.push(t);
    }
    if (patch.body !== undefined) {
      sets.push("body = ?"); params.push(patch.body ? String(patch.body).trim() : null);
    }
    if (patch.remind_at !== undefined) {
      const v = patch.remind_at ? new Date(patch.remind_at) : null;
      if (v && Number.isNaN(v.getTime())) throw new Error("remind_at inválido");
      sets.push("remind_at = ?"); params.push(v);
    }
    if (patch.priority && ["low", "normal", "high"].includes(patch.priority)) {
      sets.push("priority = ?"); params.push(patch.priority);
    }
    if (!sets.length) return await this.byId(id);
    params.push(id);
    await query(`UPDATE reminders SET ${sets.join(", ")} WHERE id = ?`, params);
    return await this.byId(id);
  },

  async byId(id) {
    return await queryOne(
      `SELECT r.*,
              u_creator.email AS created_by_email,
              u_doer.email    AS done_by_email
       FROM reminders r
       LEFT JOIN users u_creator ON u_creator.id = r.created_by
       LEFT JOIN users u_doer    ON u_doer.id    = r.done_by
       WHERE r.id = ?`,
      [id]
    );
  },

  /**
   * Listagem com filtros opcionais.
   * @param {object} opts
   * @param {string|string[]} [opts.status]
   * @param {string} [opts.related_kind]
   * @param {string} [opts.related_id]
   * @param {boolean} [opts.due_only] — só vencidos (active + remind_at <= NOW())
   * @param {boolean} [opts.upcoming] — só com data futura (active + remind_at > NOW())
   * @param {number} [opts.limit]
   */
  async list(opts = {}) {
    const where = [];
    const params = [];
    if (opts.status) {
      const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status IN (${arr.map(() => "?").join(",")})`);
      params.push(...arr);
    }
    if (opts.related_kind) { where.push("related_kind = ?"); params.push(opts.related_kind); }
    if (opts.related_id)   { where.push("related_id = ?");   params.push(String(opts.related_id)); }
    if (opts.due_only) {
      where.push("status = 'active' AND remind_at IS NOT NULL AND remind_at <= NOW()");
    }
    if (opts.upcoming) {
      where.push("status = 'active' AND remind_at IS NOT NULL AND remind_at > NOW()");
    }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200));
    return await query(
      `SELECT r.*,
              u_creator.email AS created_by_email,
              u_doer.email    AS done_by_email,
              CASE
                WHEN r.status = 'active' AND r.remind_at IS NOT NULL AND r.remind_at <= NOW()
                THEN 1 ELSE 0
              END AS is_due
       FROM reminders r
       LEFT JOIN users u_creator ON u_creator.id = r.created_by
       LEFT JOIN users u_doer    ON u_doer.id    = r.done_by
       ${w}
       ORDER BY
         (r.status = 'active') DESC,
         (r.remind_at IS NOT NULL AND r.remind_at <= NOW()) DESC,   -- vencidos primeiro
         (r.priority = 'high') DESC,
         COALESCE(r.remind_at, r.created_at) ASC
       LIMIT ${limit}`,
      params
    );
  },

  /** Contagens rápidas para badges no UI. */
  async counts() {
    const r = await query(
      `SELECT
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)                                                              AS active,
         SUM(CASE WHEN status = 'active' AND remind_at IS NOT NULL AND remind_at <= NOW() THEN 1 ELSE 0 END)             AS due,
         SUM(CASE WHEN status = 'active' AND remind_at IS NOT NULL AND remind_at >  NOW() THEN 1 ELSE 0 END)             AS upcoming,
         SUM(CASE WHEN status = 'active' AND remind_at IS NULL THEN 1 ELSE 0 END)                                        AS no_date,
         SUM(CASE WHEN status = 'done'      THEN 1 ELSE 0 END)                                                           AS done,
         SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END)                                                           AS dismissed
       FROM reminders`
    );
    const row = r[0] || {};
    return {
      active:    Number(row.active)    || 0,
      due:       Number(row.due)       || 0,
      upcoming:  Number(row.upcoming)  || 0,
      no_date:   Number(row.no_date)   || 0,
      done:      Number(row.done)      || 0,
      dismissed: Number(row.dismissed) || 0,
    };
  },

  async markDone(id, userId = null) {
    await query(
      `UPDATE reminders SET status = 'done', done_at = NOW(), done_by = ? WHERE id = ?`,
      [userId, id]
    );
    return await this.byId(id);
  },

  async markDismissed(id, userId = null) {
    await query(
      `UPDATE reminders SET status = 'dismissed', done_at = NOW(), done_by = ? WHERE id = ?`,
      [userId, id]
    );
    return await this.byId(id);
  },

  /** Reactiva (status volta a 'active' e limpa done_*). */
  async reactivate(id) {
    await query(
      `UPDATE reminders SET status = 'active', done_at = NULL, done_by = NULL WHERE id = ?`,
      [id]
    );
    return await this.byId(id);
  },

  async delete(id) {
    await query(`DELETE FROM reminders WHERE id = ?`, [id]);
    return { ok: true };
  },
};

module.exports = { Reminders };
