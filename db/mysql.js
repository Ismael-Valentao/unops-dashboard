/**
 * MySQL connection pool + helpers.
 *
 * Escolhe o profile via env var DB_PROFILE:
 *   - "local" (default) → usa DB_HOST/PORT/USER/PASSWORD/NAME do .env
 *   - "prod"  → carrega credenciais de .env.prod (Hostinger)
 *
 * Mude DB_PROFILE em .env e reinicie o serviço para alternar.
 * Helper: node scripts/db-switch.js local|prod|status
 */
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

let pool = null;
let activeProfile = null;
let activeConfig = null;

function _loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

function getDbConfig() {
  const profile = String(process.env.DB_PROFILE || "local").toLowerCase();
  if (profile === "prod" || profile === "remote") {
    // Carrega .env.prod (gitignored). Falha gracefully se não existir.
    const envProd = _loadEnvFile(path.join(__dirname, "..", ".env.prod"));
    if (!envProd || !envProd.DB_HOST) {
      console.warn("[DB] DB_PROFILE=prod mas .env.prod inválido — caindo para local");
    } else {
      return {
        _profile: "prod",
        host: envProd.DB_HOST,
        port: Number(envProd.DB_PORT) || 3306,
        user: envProd.DB_USER,
        password: envProd.DB_PASSWORD,
        database: envProd.DB_NAME,
      };
    }
  }
  return {
    _profile: "local",
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "aqi_operations",
  };
}

function getActiveDbInfo() {
  // Devolve metadata do pool actual — usado pelo banner UI + endpoint
  // /api/admin/system/db-status. NÃO devolve a password.
  const cfg = activeConfig || getDbConfig();
  return {
    profile: cfg._profile,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    database: cfg.database,
    is_prod: cfg._profile === "prod",
  };
}

function getPool() {
  if (pool) return pool;
  const cfg = getDbConfig();
  activeConfig = cfg;
  activeProfile = cfg._profile;
  if (cfg._profile === "prod") {
    console.log(`[DB] ⚠️  Profile=PROD · ${cfg.host}/${cfg.database}`);
  } else {
    console.log(`[DB] Profile=local · ${cfg.host}/${cfg.database}`);
  }
  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: true,
    charset: "utf8mb4",
    dateStrings: true,
  });
  return pool;
}

async function query(sql, params) {
  const [rows] = await getPool().execute(sql, params || []);
  return rows;
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function execute(sql, params) {
  const [result] = await getPool().execute(sql, params || []);
  return result;
}

async function columnExists(table, column) {
  const dbName = process.env.DB_NAME || "aqi_operations";
  const row = await queryOne(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [dbName, table, column]
  );
  return !!row;
}

async function migrate() {
  // truck_cargo: add product_id and unloaded_to_warehouse_id
  if (!(await columnExists("truck_cargo", "product_id"))) {
    await getPool().query("ALTER TABLE truck_cargo ADD COLUMN product_id INT NULL AFTER truck_id");
    try { await getPool().query("ALTER TABLE truck_cargo ADD CONSTRAINT fk_tc_product FOREIGN KEY (product_id) REFERENCES products(id)"); } catch (e) {}
    console.log("[DB] migrated truck_cargo.product_id");
  }
  if (!(await columnExists("truck_cargo", "unloaded_to_warehouse_id"))) {
    await getPool().query("ALTER TABLE truck_cargo ADD COLUMN unloaded_to_warehouse_id INT NULL AFTER unit");
    try { await getPool().query("ALTER TABLE truck_cargo ADD CONSTRAINT fk_tc_warehouse FOREIGN KEY (unloaded_to_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated truck_cargo.unloaded_to_warehouse_id");
  }

  // stock_movements: add product_id, warehouse_id, departure_id + extend type enum
  if (!(await columnExists("stock_movements", "product_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN product_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_product FOREIGN KEY (product_id) REFERENCES products(id)"); } catch (e) {}
    console.log("[DB] migrated stock_movements.product_id");
  }
  if (!(await columnExists("stock_movements", "warehouse_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN warehouse_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.warehouse_id");
  }
  if (!(await columnExists("stock_movements", "departure_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN departure_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_departure FOREIGN KEY (departure_id) REFERENCES truck_departures(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.departure_id");
  }
  // Extend ENUM (always safe to re-run)
  await getPool().query(
    `ALTER TABLE stock_movements MODIFY COLUMN type ENUM(
      'truck_in','truck_unload','transfer_out','transfer_in','adjustment',
      'warehouse_in','warehouse_out','departure'
    ) NOT NULL`
  );

  // requisitions: add product_id
  if (!(await columnExists("requisitions", "product_id"))) {
    await getPool().query("ALTER TABLE requisitions ADD COLUMN product_id INT NULL");
    try { await getPool().query("ALTER TABLE requisitions ADD CONSTRAINT fk_req_product FOREIGN KEY (product_id) REFERENCES products(id)"); } catch (e) {}
    console.log("[DB] migrated requisitions.product_id");
  }

  // suppliers: NUIT + client_number (for PO matching)
  if (!(await columnExists("suppliers", "nuit"))) {
    await getPool().query("ALTER TABLE suppliers ADD COLUMN nuit VARCHAR(32) NULL AFTER contact_email");
    console.log("[DB] migrated suppliers.nuit");
  }
  if (!(await columnExists("suppliers", "client_number"))) {
    await getPool().query("ALTER TABLE suppliers ADD COLUMN client_number VARCHAR(32) NULL");
    console.log("[DB] migrated suppliers.client_number");
  }

  // stock_movements: add entry_id, exit_id, supplier_id + extend ENUM with new types
  if (!(await columnExists("stock_movements", "entry_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN entry_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_entry FOREIGN KEY (entry_id) REFERENCES stock_entries(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.entry_id");
  }
  if (!(await columnExists("stock_movements", "exit_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN exit_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_exit FOREIGN KEY (exit_id) REFERENCES stock_exits(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.exit_id");
  }
  if (!(await columnExists("stock_movements", "supplier_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN supplier_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.supplier_id");
  }
  // Add truck_plate for movement queries by plate (denormalized for fast search)
  if (!(await columnExists("stock_movements", "truck_plate"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN truck_plate VARCHAR(32) NULL");
    await getPool().query("CREATE INDEX idx_sm_plate ON stock_movements (truck_plate)");
    console.log("[DB] migrated stock_movements.truck_plate");
  }
  // Extend ENUM with authorization_in / adsn_out (safe to re-run)
  await getPool().query(
    `ALTER TABLE stock_movements MODIFY COLUMN type ENUM(
      'truck_in','truck_unload','transfer_out','transfer_in','adjustment',
      'warehouse_in','warehouse_out','departure',
      'authorization_in','adsn_out'
    ) NOT NULL`
  );

  // delivery_services: aprovação (Fase 12)
  // requires_approval = decidido por um threshold de operação (kg, etc.)
  // approval_status = pending | approved | rejected
  // Útil quando operator cria service mas precisa de admin para libertar p/ trânsito
  if (!(await columnExists("delivery_services", "approval_status"))) {
    await getPool().query(
      "ALTER TABLE delivery_services ADD COLUMN approval_status ENUM('pending','approved','rejected','not_required') NOT NULL DEFAULT 'not_required' AFTER status"
    );
    console.log("[DB] migrated delivery_services.approval_status");
  }
  if (!(await columnExists("delivery_services", "approved_at"))) {
    await getPool().query(
      "ALTER TABLE delivery_services ADD COLUMN approved_at DATETIME NULL AFTER approval_status"
    );
    console.log("[DB] migrated delivery_services.approved_at");
  }
  if (!(await columnExists("delivery_services", "approved_by"))) {
    await getPool().query(
      "ALTER TABLE delivery_services ADD COLUMN approved_by INT NULL AFTER approved_at"
    );
    try { await getPool().query("ALTER TABLE delivery_services ADD CONSTRAINT fk_ds_approved_by FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated delivery_services.approved_by");
  }
  if (!(await columnExists("delivery_services", "approval_notes"))) {
    await getPool().query(
      "ALTER TABLE delivery_services ADD COLUMN approval_notes TEXT NULL"
    );
    console.log("[DB] migrated delivery_services.approval_notes");
  }

  // delivery_services: categoria + razão de cancelamento (Fase 5)
  if (!(await columnExists("delivery_services", "cancellation_category"))) {
    await getPool().query(
      "ALTER TABLE delivery_services ADD COLUMN cancellation_category VARCHAR(32) NULL AFTER cancelled_at"
    );
    console.log("[DB] migrated delivery_services.cancellation_category");
  }
  if (!(await columnExists("delivery_services", "cancellation_reason"))) {
    await getPool().query(
      "ALTER TABLE delivery_services ADD COLUMN cancellation_reason TEXT NULL AFTER cancellation_category"
    );
    console.log("[DB] migrated delivery_services.cancellation_reason");
  }

  // delivery_balances: planned_original + realocado_recebido (visíveis na UI)
  if (!(await columnExists("delivery_balances", "planned_original"))) {
    await getPool().query(
      "ALTER TABLE delivery_balances ADD COLUMN planned_original DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER beneficiary_name"
    );
    console.log("[DB] migrated delivery_balances.planned_original");
  }
  if (!(await columnExists("delivery_balances", "realocado_recebido"))) {
    await getPool().query(
      "ALTER TABLE delivery_balances ADD COLUMN realocado_recebido DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER planned_original"
    );
    console.log("[DB] migrated delivery_balances.realocado_recebido");
  }

  // Tipo específico do produto (ex: "Vulgar"/"Nhemba"/"Nhemba e Vulgar"
  // para Feijão). NULL para SKUs onde não se aplica. Lido do Excel coluna
  // "Tipo de Feijão" no importPlanning.
  if (!(await columnExists("delivery_balances", "bean_type"))) {
    await getPool().query(
      "ALTER TABLE delivery_balances ADD COLUMN bean_type VARCHAR(32) NULL AFTER product_name"
    );
    console.log("[DB] migrated delivery_balances.bean_type");
  }

  // Localidade do benef (mais granular que "posto"). Vem do Excel coluna
  // "Localidade". Útil para o roteiro do motorista (saber onde parar).
  if (!(await columnExists("beneficiaries", "localidade"))) {
    await getPool().query(
      "ALTER TABLE beneficiaries ADD COLUMN localidade VARCHAR(128) NULL AFTER posto"
    );
    console.log("[DB] migrated beneficiaries.localidade");
  }

  // alias_for: quando 2 IDs representam o MESMO extensionista (duplicação
  // histórica). NULL = ID canónico (recebe plano oficial). Não-NULL = aponta
  // para o canónico que tem o plano. Histórico de entregas pode estar em
  // qualquer um — SUM agrega via COALESCE(alias_for, extensionist_id).
  // Adicionado para suportar reconciliação MAAP onde MAAP usa IDs novos
  // mas o sistema tem entregas sob IDs antigos.
  if (!(await columnExists("beneficiaries", "alias_for"))) {
    await getPool().query(
      "ALTER TABLE beneficiaries ADD COLUMN alias_for VARCHAR(16) NULL AFTER localidade"
    );
    try { await getPool().query("ALTER TABLE beneficiaries ADD INDEX idx_alias_for (alias_for)"); } catch(_) {}
    console.log("[DB] migrated beneficiaries.alias_for");
  }

  // ── Audit de entregas (captura imutável do Google Sheet) ───
  //
  // Salvaguarda contra perda de delivery_date no AppSheet:
  // sempre que vemos uma row nova no sheet, gravamos aqui com
  // detected_at = NOW(), preservando QUEM submeteu e QUANDO foi
  // detectada. A própria linha pode desaparecer do sheet ou perder
  // a delivery_date — a nossa cópia mantém-se.
  //
  // dedup_key:
  //   - Se há GTU → "gtu|qty" (composto, distingue múltiplas entregas
  //     com mesmo GTU mas qty diferente — caso raro mas existe)
  //   - Se não há GTU → "syn|md5(adsn|benef|prod|qty|district|submitted_by)"
  //     para deduplicar mesmo sem GTU
  //
  // verification_status: o que vem do sheet (Verified, Pending,
  // Rejected, Not Reachable, Partially Verified, etc.). Tracked
  // através de status_changed_at para histórico de mudanças.
  //
  // last_seen_at: actualizado a cada fetch — útil para detectar
  // linhas que foram apagadas no sheet (last_seen_at antigo).
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS delivery_audit (
      id INT AUTO_INCREMENT PRIMARY KEY,
      dedup_key VARCHAR(80) NOT NULL UNIQUE,
      gtu VARCHAR(64) NULL,
      adsn VARCHAR(64) NULL,
      beneficiary_name VARCHAR(255) NULL,
      extensionist_id VARCHAR(32) NULL,
      nuit VARCHAR(32) NULL,
      product VARCHAR(128) NULL,
      delivered_qty DECIMAL(14,3) NULL,
      packages DECIMAL(14,3) NULL,
      unit VARCHAR(16) NULL,
      district VARCHAR(64) NULL,
      province VARCHAR(64) NULL,
      submitted_by VARCHAR(255) NULL,
      delivery_date_iso VARCHAR(20) NULL,
      verification_status VARCHAR(64) NULL,
      detected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      detected_date DATE NOT NULL DEFAULT (CURRENT_DATE),
      status_changed_at DATETIME NULL,
      last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_data JSON NULL,
      INDEX idx_audit_detected_date (detected_date),
      INDEX idx_audit_submitter (submitted_by),
      INDEX idx_audit_status (verification_status),
      INDEX idx_audit_gtu (gtu),
      INDEX idx_audit_district (district)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // Migração idempotente: adiciona coluna deleted_at se ainda não existe.
  // Marca rows que desapareceram da Google Sheet (user editou/eliminou
  // submissões erradas). audit-capture.js seta isto quando uma row não
  // aparece num fetch — e des-seta se a row reaparecer.
  try {
    const [cols] = await getPool().query(
      "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'delivery_audit' AND column_name = 'deleted_at'"
    );
    if (cols && cols[0] && Number(cols[0].n) === 0) {
      await getPool().query("ALTER TABLE delivery_audit ADD COLUMN deleted_at DATETIME NULL AFTER last_seen_at");
      await getPool().query("ALTER TABLE delivery_audit ADD INDEX idx_audit_deleted (deleted_at)");
    }
  } catch (e) { /* idempotente — se falhar não bloqueia */ }

  // ── Audit-snapshots diários (backup do mapa de entregas) ────
  // Clone diário de delivery_audit às 00:00 — salvaguarda contra:
  //   - Mudança/corrupção da Google Sheet remota (caso já visto: aba
  //     com mesmo nome substituída por pivot semanal de invoicing, e
  //     o sweep de deleted_at marcou ~1100 rows como apagadas)
  //   - Edições/eliminações destrutivas pela equipa UNOPS
  //   - Restauração forense em qualquer dia anterior
  // Schema replica delivery_audit + snapshot_date. Idempotente: a UNIQUE
  // (snapshot_date, dedup_key) garante que correr o snapshot 2× no mesmo
  // dia não duplica linhas. Retenção configurável (default 365 dias).
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS delivery_audit_snapshots (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      snapshot_date DATE NOT NULL,
      dedup_key VARCHAR(80) NOT NULL,
      audit_id INT NOT NULL,
      gtu VARCHAR(64) NULL,
      adsn VARCHAR(64) NULL,
      beneficiary_name VARCHAR(255) NULL,
      extensionist_id VARCHAR(32) NULL,
      nuit VARCHAR(32) NULL,
      product VARCHAR(128) NULL,
      delivered_qty DECIMAL(14,3) NULL,
      packages DECIMAL(14,3) NULL,
      unit VARCHAR(16) NULL,
      district VARCHAR(64) NULL,
      province VARCHAR(64) NULL,
      submitted_by VARCHAR(255) NULL,
      delivery_date_iso VARCHAR(20) NULL,
      verification_status VARCHAR(64) NULL,
      detected_at DATETIME NULL,
      raw_data JSON NULL,
      captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_snapshot_dedup (snapshot_date, dedup_key),
      INDEX idx_snap_date (snapshot_date),
      INDEX idx_snap_audit (audit_id),
      INDEX idx_snap_gtu (gtu),
      INDEX idx_snap_submitter (submitted_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // ── Audit-history (histórico de mudanças de status) ────────
  // Sempre que delivery_audit.verification_status muda, gravamos
  // 1 row aqui para forensics: "este GTU passou de Pending → Verified
  // a 12/05/2026 14:30". Útil para investigar ciclo de vida de cada
  // submissão e medir tempo médio até verificação.
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS delivery_audit_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      audit_id INT NOT NULL,
      from_status VARCHAR(64) NULL,
      to_status   VARCHAR(64) NULL,
      changed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audhist_audit (audit_id),
      INDEX idx_audhist_changed (changed_at),
      FOREIGN KEY (audit_id) REFERENCES delivery_audit(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // ── Batedores (mapeamento email → nome real + contacto) ─────
  // Tabela leve só para enriquecer os submissions (que vêm com email)
  // com identidade real para mostrar no /batedores e usar em SMS/exports.
  // Importado de Excel via script ou /admin futuro.
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS batedores (
      email VARCHAR(255) NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      contact VARCHAR(64) NULL,
      contact_alt VARCHAR(64) NULL,
      imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_batedores_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // ── SMS templates + log ─────────────────────────────────────
  // sms_templates: 3 templates default + custom (editáveis em /admin/sms).
  //   kind:
  //     plan      → "Plano criado" — info ao extensionista de que foi planeado
  //     arriving  → "Camião a chegar" — notifica destinatário do despacho
  //     delivered → "Pós-entrega"    — agradece e pede bom uso
  //     custom    → templates extra criados pelo utilizador
  //   body com placeholders {nome}, {qty}, {produto}, {matricula}, {distrito},
  //   {motorista}, {motorista_tel}, {servico}, {data}.
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS sms_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kind ENUM('plan','arriving','delivered','custom','supervisor') NOT NULL DEFAULT 'custom',
      name VARCHAR(128) NOT NULL,
      body TEXT NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_smstpl_kind (kind),
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  // Migração para adicionar 'supervisor' ao ENUM em DBs já criadas
  await getPool().query(
    `ALTER TABLE sms_templates MODIFY COLUMN kind
       ENUM('plan','arriving','delivered','custom','supervisor') NOT NULL DEFAULT 'custom'`
  );
  // sms_log: 1 linha por SMS tentado (sucesso ou falha).
  //   provider_id: id retornado pela API
  //   related_kind/related_id: ex 'service'/42, 'beneficiary'/'0102-0001'
  //   template_id: opcional (NULL para envios ad-hoc fora dos templates)
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS sms_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      template_id INT NULL,
      template_kind ENUM('plan','arriving','delivered','custom','adhoc','supervisor') NOT NULL DEFAULT 'adhoc',
      beneficiary_id VARCHAR(16) NULL,
      beneficiary_name VARCHAR(255) NULL,
      phone_raw VARCHAR(64) NULL,
      phone_normalized VARCHAR(32) NULL,
      message TEXT NOT NULL,
      status ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
      provider_id VARCHAR(128) NULL,
      provider_response TEXT NULL,
      error_message TEXT NULL,
      related_kind VARCHAR(32) NULL,
      related_id   VARCHAR(64) NULL,
      sent_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at    DATETIME NULL,
      dry_run TINYINT(1) NOT NULL DEFAULT 0,
      INDEX idx_smslog_status (status),
      INDEX idx_smslog_kind (template_kind),
      INDEX idx_smslog_related (related_kind, related_id),
      INDEX idx_smslog_benef (beneficiary_id),
      INDEX idx_smslog_created (created_at),
      FOREIGN KEY (template_id) REFERENCES sms_templates(id) ON DELETE SET NULL,
      FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  // Migração ENUM idempotente para DBs já criadas (sms_log)
  await getPool().query(
    `ALTER TABLE sms_log MODIFY COLUMN template_kind
       ENUM('plan','arriving','delivered','custom','adhoc','supervisor') NOT NULL DEFAULT 'adhoc'`
  );

  // Seeds dos templates (idempotentes — só insere se kind não existir).
  // Bodies optimizados para 1 segmento (≤160 chars) com placeholders típicos
  // — assim 1 SMS = 1 crédito.
  const seeds = [
    { kind: "plan",       name: "Plano criado",
      body: "AQI: {nome}, foi-lhe atribuido um plano de distribuicao da Casa do Agricultor com {plano}. Aguarde aviso quando o camiao chegar a sua zona. Em caso de duvida, contacte o seu supervisor." },
    { kind: "arriving",   name: "Camiao a chegar",
      body: "AQI: {nome}, hoje recebe {items}. Camiao {matricula}, motorista {motorista} ({motorista_tel}). Confirme presenca em {distrito}." },
    { kind: "delivered",  name: "Pos-entrega",
      body: "AQI: {nome}, confirmamos a sua entrega de {items}. Mantenha as sementes em local seco e fresco. Boa campanha agricola - sucesso!" },
    { kind: "supervisor", name: "Aviso ao supervisor",
      body: "AQI/Supervisor {nome}: camiao {matricula} a caminho de {distrito} com entrega para {n_extensionistas} extensionistas (~{total_kg} kg). Motorista: {motorista} ({motorista_tel}). {servico}." },
  ];
  for (const t of seeds) {
    const exists = await getPool().query(
      "SELECT id FROM sms_templates WHERE kind = ? LIMIT 1", [t.kind]
    );
    if (!exists[0].length) {
      await getPool().query(
        "INSERT INTO sms_templates (kind, name, body, enabled) VALUES (?, ?, ?, 1)",
        [t.kind, t.name, t.body]
      );
      console.log(`[DB] seeded sms_templates kind=${t.kind}`);
    }
  }

  // Migração suave dos 3 templates antigos → versões optimizadas
  // (só actualiza se o body actual for IGUAL à versão antiga — preserva
  // edições feitas pelo utilizador no admin/sms).
  const TEMPLATE_UPGRADES = [
    {
      kind: "plan",
      old_body: "Caro(a) {nome}, foi-lhe atribuido um plano de distribuicao AQI: {plano}. Aguarde notificacao de entrega. Casa do Agricultor.",
    },
    {
      kind: "arriving",
      old_body: "Caro(a) {nome}, o camiao {matricula} esta a caminho com a sua entrega: {items}. Por favor confirme presenca em {distrito}. Motorista: {motorista} {motorista_tel}. AQI.",
    },
    {
      kind: "delivered",
      old_body: "Caro(a) {nome}, recebemos confirmacao da sua entrega de {items}. Faca bom uso das sementes — sucesso na campanha! Casa do Agricultor.",
    },
  ];
  const seedByKind = Object.fromEntries(seeds.map((s) => [s.kind, s]));
  for (const u of TEMPLATE_UPGRADES) {
    const newBody = seedByKind[u.kind].body;
    const [r] = await getPool().query(
      "UPDATE sms_templates SET body = ? WHERE kind = ? AND body = ?",
      [newBody, u.kind, u.old_body]
    );
    if (r.affectedRows > 0) {
      console.log(`[DB] upgraded sms_templates kind=${u.kind} (texto antigo → optimizado)`);
    }
  }

  // ── Lembretes / Informações ─────────────────────────────────
  // Notas livres com data opcional para recordar. Podem (mas não têm
  // de) estar ligadas a um recurso (serviço/camião/beneficiário) — neste
  // caso o lembrete fica "ancorado" e aparece no detalhe desse recurso.
  //
  // Estados:
  //   active    — pendente (default)
  //   done      — utilizador marcou como tratado
  //   dismissed — descartado sem fazer
  //
  // Vencimento:
  //   remind_at = NULL  → só info, nunca vence
  //   remind_at <= NOW() & status='active' → "vencido", aparece em banner
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS reminders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      body TEXT NULL,
      remind_at DATETIME NULL,
      priority ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
      status ENUM('active','done','dismissed') NOT NULL DEFAULT 'active',
      related_kind VARCHAR(32) NULL,
      related_id   VARCHAR(64) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      done_at    DATETIME NULL,
      done_by    INT NULL,
      INDEX idx_rem_status (status),
      INDEX idx_rem_remindat (remind_at),
      INDEX idx_rem_related (related_kind, related_id),
      INDEX idx_rem_creator (created_by),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (done_by)    REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  // ── Product Metas (global por produto) ───────────────────────
  // Meta de contratação a nível de PRODUTO (não por fornecedor) — usado
  // no topo dos cards em /admin/fornecido. Independente das supplier_metas
  // (que continuam a representar o compromisso por fornecedor + produto).
  //
  // qty em kg para granéis, un para sacos. NULL = "por definir".
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS product_metas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product VARCHAR(64) NOT NULL,
      qty DECIMAL(14,2) NULL,
      unit VARCHAR(8) NOT NULL DEFAULT 'kg',
      note TEXT NULL,
      active TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by INT NULL,
      updated_by INT NULL,
      UNIQUE KEY uq_product_meta (product),
      INDEX idx_pm_active (active),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  // Seed inicial (só se vazia)
  const [[pmSeedCheck]] = await getPool().query("SELECT COUNT(*) AS n FROM product_metas");
  if (Number(pmSeedCheck.n) === 0) {
    try {
      const { METAS: PM_SEED } = require("../lib/product-metas-seed");
      const rows = [];
      for (const [product, info] of Object.entries(PM_SEED)) {
        const qty = info.qty == null ? null : Number(info.qty);
        const unit = String(info.unit || "kg").toLowerCase() === "un" ? "un" : "kg";
        rows.push([product, qty, unit]);
      }
      if (rows.length) {
        await getPool().query(
          "INSERT INTO product_metas (product, qty, unit) VALUES ?",
          [rows]
        );
        console.log(`[DB] seeded ${rows.length} product_metas`);
      }
    } catch (e) {
      console.warn("[DB] product_metas seed falhou:", e.message);
    }
  }

  // ── Supplier Metas ────────────────────────────────────────────
  // Metas de fornecimento por fornecedor + produto (editáveis via
  // /admin/supplier-metas). Substitui o hardcoded em lib/supplier-metas.js.
  //   - meta_key   : token de match fuzzy (ex: "SEEDCO", "MH-TENDERS")
  //   - product    : produto canónico (ex: "Milho", "Feijão", "Arroz",
  //                  "Sacos Hermét.", "Emamectim", ...)
  //   - qty        : kg para granéis, un para sacos. NULL = "por definir"
  //   - unit       : 'kg' ou 'un'
  //   - active     : 0 = soft-disable sem apagar
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS supplier_metas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      meta_key VARCHAR(64) NOT NULL,
      product VARCHAR(64) NOT NULL,
      qty DECIMAL(14,2) NULL,
      unit VARCHAR(8) NOT NULL DEFAULT 'kg',
      note TEXT NULL,
      active TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_by INT NULL,
      updated_by INT NULL,
      UNIQUE KEY uq_supplier_meta (meta_key, product),
      INDEX idx_meta_active (active),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  // Seed inicial: insere as metas do ficheiro hardcoded se a tabela
  // estiver vazia. Idempotente (só seed na primeira vez).
  const [[seedCheck]] = await getPool().query("SELECT COUNT(*) AS n FROM supplier_metas");
  if (Number(seedCheck.n) === 0) {
    try {
      const { METAS: HARDCODED } = require("../lib/supplier-metas-seed");
      const rows = [];
      for (const [metaKey, products] of Object.entries(HARDCODED)) {
        for (const [product, qty] of Object.entries(products)) {
          const isSaco = /sacos?\s*hermet|hermét/i.test(product);
          rows.push([metaKey, product, qty == null ? null : Number(qty), isSaco ? "un" : "kg"]);
        }
      }
      if (rows.length) {
        await getPool().query(
          "INSERT INTO supplier_metas (meta_key, product, qty, unit) VALUES ?",
          [rows]
        );
        console.log(`[DB] seeded ${rows.length} supplier_metas`);
      }
    } catch (e) {
      console.warn("[DB] supplier_metas seed falhou:", e.message);
    }
  }
}

async function init() {
  // Test connection
  const conn = await getPool().getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }

  // Run schema (multipleStatements is enabled)
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  // Split statements and run individually so foreign keys resolve in order
  const statements = schema.split(/;\s*[\r\n]/).map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    try {
      await getPool().query(stmt);
    } catch (e) {
      console.error("[DB] Failed to run:", stmt.slice(0, 80), "...");
      console.error("    ", e.message);
      throw e;
    }
  }

  // Run incremental migrations
  await migrate();

  console.log("[DB] MySQL connected, schema ready, migrations applied");
}

async function hasAnyUser() {
  const row = await queryOne("SELECT COUNT(*) AS c FROM users");
  return row && row.c > 0;
}

module.exports = { init, query, queryOne, execute, getPool, hasAnyUser, getActiveDbInfo };
