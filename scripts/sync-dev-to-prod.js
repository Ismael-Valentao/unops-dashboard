#!/usr/bin/env node
/**
 * Sincroniza tabelas curadas de DEV → PROD (Hostinger).
 *
 * USAGE:
 *   node scripts/sync-dev-to-prod.js              # dry-run (default)
 *   node scripts/sync-dev-to-prod.js --apply      # executa
 *   node scripts/sync-dev-to-prod.js --table=batedores --apply   # 1 tabela
 *
 * SEGURANÇA:
 *   - Default é DRY-RUN — só lista o que iria fazer
 *   - NUNCA faz DROP / TRUNCATE
 *   - Usa INSERT … ON DUPLICATE KEY UPDATE (idempotente)
 *   - Skippa delivery_audit/history (prod tem mais dados — não regredir)
 *   - Skippa audit_log/sessions/backup_* (locais/ephemerais)
 *
 * CREDENCIAIS:
 *   DEV  lê de .env (DB_HOST/USER/PASSWORD/NAME)
 *   PROD lê de .env.prod no root do projecto (mesma chave shape, com prefixo
 *        ou não — ver _loadProdEnv() abaixo). Este ficheiro está no
 *        .gitignore. Se quiser usar outro path: PROD_ENV_FILE=/path/to/.env
 */

const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

// Carrega .env do dev (DB_*)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function _loadProdEnv() {
  const file = process.env.PROD_ENV_FILE || path.join(__dirname, "..", ".env.prod");
  if (!fs.existsSync(file)) {
    console.error(`✗ Ficheiro de credenciais prod não encontrado: ${file}`);
    console.error(`  Crie .env.prod no root do projecto com DB_HOST/PORT/USER/PASSWORD/NAME`);
    console.error(`  (ou aponte para outro path via PROD_ENV_FILE=...)`);
    process.exit(2);
  }
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const DEV = {
  host:     process.env.DB_HOST     || "127.0.0.1",
  port:     Number(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME     || "aqi_operations",
};
const prodEnv = _loadProdEnv();
const PROD = {
  host:     prodEnv.DB_HOST,
  port:     Number(prodEnv.DB_PORT) || 3306,
  user:     prodEnv.DB_USER,
  password: prodEnv.DB_PASSWORD,
  database: prodEnv.DB_NAME,
  connectTimeout: 15000,
};
if (!PROD.host || !PROD.user || !PROD.database) {
  console.error("✗ .env.prod incompleto. Necessário: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME");
  process.exit(2);
}

// Tabelas a sincronizar, na ordem (dependências FK primeiro).
// "createIfMissing" → se prod não tem a tabela, cria-a copiando CREATE do dev.
// "batchSize" → quantas rows por INSERT (default 200).
const TABLES = [
  // 1. Núcleo (sem dependências FK)
  { name: "products",            createIfMissing: true,  batchSize: 200 },
  { name: "suppliers",           createIfMissing: true,  batchSize: 200 },
  { name: "warehouses",          createIfMissing: true,  batchSize: 200 },
  { name: "trucks",              createIfMissing: true,  batchSize: 200 },
  { name: "batedores",           createIfMissing: true,  batchSize: 200 },
  { name: "beneficiaries",       createIfMissing: true,  batchSize: 200 },
  { name: "sms_templates",       createIfMissing: true,  batchSize: 200 },

  // 2. Operacionais que dependem das de cima
  { name: "purchase_orders",     createIfMissing: true,  batchSize: 200 },
  { name: "po_items",            createIfMissing: true,  batchSize: 200 },
  { name: "pickup_authorizations", createIfMissing: true, batchSize: 200 },
  { name: "pickup_auth_items",   createIfMissing: true,  batchSize: 200 },
  { name: "stock_entries",       createIfMissing: true,  batchSize: 200 },
  { name: "stock_entry_items",   createIfMissing: true,  batchSize: 200 },
  { name: "stock_entry_attachments", createIfMissing: true, batchSize: 200 },
  { name: "stock_exits",         createIfMissing: true,  batchSize: 200 },
  { name: "stock_movements",     createIfMissing: true,  batchSize: 200 },
  { name: "truck_cargo",         createIfMissing: true,  batchSize: 200 },
  { name: "truck_departures",    createIfMissing: true,  batchSize: 200 },
  { name: "truck_attachments",   createIfMissing: true,  batchSize: 200 },
  { name: "cargo_transfers",     createIfMissing: true,  batchSize: 200 },
  { name: "delivery_balances",   createIfMissing: true,  batchSize: 500 },
  { name: "delivery_services",   createIfMissing: true,  batchSize: 200 },
  { name: "delivery_service_items", createIfMissing: true, batchSize: 500 },
  { name: "delivery_plans",      createIfMissing: true,  batchSize: 200 },
  { name: "plan_items",          createIfMissing: true,  batchSize: 200 },
  { name: "departure_cargo",     createIfMissing: true,  batchSize: 200 },
  { name: "requisitions",        createIfMissing: true,  batchSize: 200 },
  { name: "adsn_services",       createIfMissing: true,  batchSize: 200 },
  { name: "reminders",           createIfMissing: true,  batchSize: 200 },
  { name: "supplier_metas",      createIfMissing: true,  batchSize: 200 },
];

// Tabelas que NUNCA sincronizamos (explicit deny-list — defensivo).
const NEVER_SYNC = new Set([
  "delivery_audit",         // prod tem polling do Sheet (já tem ≥ dev)
  "delivery_audit_history", // prod acumula histórico próprio
  "audit_log",              // local
  "sessions",               // ephemerais
  "sms_log",                // produção tem o seu próprio log
  "users",                  // admins de prod podem diferir; manual
  "devices", "mobile_devices", "updates",  // prod-only
]);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ONLY_TABLE = (args.find((a) => a.startsWith("--table=")) || "").split("=")[1] || null;

function log(...x) { console.log(...x); }

// Garante que a conexão prod está viva — se foi fechada, reconnecta e
// restaura FK checks off. Devolve a (nova) conexão.
async function ensureProdAlive(prodC) {
  try {
    await prodC.query("SELECT 1");
    return prodC;
  } catch (e) {
    log(`  ⟲ reconectando a prod (${e.code || e.message})…`);
    const next = await mysql.createConnection(PROD);
    if (APPLY) {
      await next.query("SET FOREIGN_KEY_CHECKS = 0");
      await next.query("SET UNIQUE_CHECKS = 0");
    }
    return next;
  }
}

async function syncTable(devC, prodC, cfg) {
  if (NEVER_SYNC.has(cfg.name)) {
    log(`  ⊘ ${cfg.name}: na deny-list — skip`);
    return { skipped: true, prodC };
  }
  // 1. Schema check
  const [prodTbl] = await prodC.execute(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",
    [PROD.database, cfg.name]
  );
  let prodTableExists = prodTbl.length > 0;
  if (!prodTableExists) {
    if (!cfg.createIfMissing) {
      log(`  ⊘ ${cfg.name}: não existe em prod e createIfMissing=false — skip`);
      return { skipped: true };
    }
    // Copia CREATE do dev
    const [createInfo] = await devC.execute(`SHOW CREATE TABLE \`${cfg.name}\``);
    const createSql = createInfo[0]["Create Table"];
    if (APPLY) {
      await prodC.query(createSql);
      prodTableExists = true;
      log(`  + ${cfg.name}: tabela criada em prod`);
    } else {
      log(`  + ${cfg.name}: [DRY] tabela seria criada em prod`);
    }
  }
  // 2. Row count
  const [[{ n: nDev }]]   = await devC.query(`SELECT COUNT(*) AS n FROM \`${cfg.name}\``);
  const nProd = prodTableExists ? (await prodC.query(`SELECT COUNT(*) AS n FROM \`${cfg.name}\``))[0][0].n : 0;
  log(`  · ${cfg.name}: dev=${nDev} rows · prod=${nProd} rows`);
  if (nDev === 0) {
    log(`    ↳ dev vazio — nada para sincronizar`);
    return { dev: 0, prod: nProd, inserted: 0, updated: 0 };
  }
  // 3. Stream dev rows → upsert em prod
  const [colInfo] = await devC.query(`SHOW COLUMNS FROM \`${cfg.name}\``);
  const cols = colInfo.map((c) => c.Field);
  const colList = cols.map((c) => `\`${c}\``).join(",");
  const placeholders = cols.map(() => "?").join(",");
  const updateClause = cols
    .filter((c) => c !== "id" && c !== "created_at")  // não sobrepor PK/timestamp inicial
    .map((c) => `\`${c}\`=VALUES(\`${c}\`)`)
    .join(",");
  const upsertSql = `INSERT INTO \`${cfg.name}\` (${colList}) VALUES (${placeholders}) ` +
    (updateClause ? `ON DUPLICATE KEY UPDATE ${updateClause}` : "");

  const batchSize = cfg.batchSize || 200;
  let offset = 0;
  let totalInserted = 0;
  if (!APPLY) {
    log(`    ↳ [DRY] iria fazer upsert de ${nDev} rows (batch=${batchSize})`);
    return { dev: nDev, prod: nProd, inserted: 0, updated: 0, dryRun: true };
  }
  // Sem transação por tabela — em prod com FK_CHECKS=0 fazemos commit
  // row-a-row para que falhas isoladas (ex: NULL num NOT NULL) não desfaçam
  // as 2900 rows que já passaram. Os erros são logados mas não bloqueiam.
  let errors = 0;
  try {
    while (true) {
      const [rows] = await devC.query(
        `SELECT * FROM \`${cfg.name}\` ORDER BY ${cols.includes("id") ? "id" : "1"} LIMIT ${batchSize} OFFSET ${offset}`
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const values = cols.map((c) => row[c]);
        try {
          await prodC.execute(upsertSql, values);
          totalInserted++;
        } catch (eRow) {
          errors++;
          if (errors <= 3) log(`    ! row error: ${eRow.message.slice(0, 110)}`);
        }
      }
      offset += rows.length;
      process.stdout.write(`    ↳ ${totalInserted}/${nDev}${errors ? ` (${errors} skipped)` : ""}\r`);
      if (rows.length < batchSize) break;
    }
    log(`    ✓ ${totalInserted}/${nDev} rows upserted${errors ? ` · ${errors} skipped` : ""}          `);
  } catch (e) {
    log(`    ✗ batch error: ${e.message}`);
    throw e;
  }
  return { dev: nDev, prod: nProd, inserted: totalInserted, errors };
}

(async () => {
  log(`\n=== Sync DEV → PROD ===`);
  log(`Mode: ${APPLY ? "APPLY (irá escrever)" : "DRY-RUN (não escreve)"}`);
  if (ONLY_TABLE) log(`Filter: --table=${ONLY_TABLE}`);
  log(`Dev:  ${DEV.host}/${DEV.database}`);
  log(`Prod: ${PROD.host}/${PROD.database}`);
  log();

  const devC  = await mysql.createConnection(DEV);
  const prodC = await mysql.createConnection(PROD);
  log(`✓ Conectado a ambas as DBs`);

  // Desactiva FK checks durante o sync — standard para data dumps onde as
  // tabelas pais e filhos são copiadas em ordens que podem não respeitar
  // dependências (ou onde users/etc. apontados pelas FKs ainda não existem).
  // No fim restauramos.
  if (APPLY) {
    await prodC.query("SET FOREIGN_KEY_CHECKS = 0");
    await prodC.query("SET UNIQUE_CHECKS = 0");
    log(`✓ FK checks desactivados em prod (durante o sync)\n`);
  } else {
    log();
  }

  const summary = [];
  let activeProdC = prodC;
  for (const cfg of TABLES) {
    if (ONLY_TABLE && cfg.name !== ONLY_TABLE) continue;
    try {
      activeProdC = await ensureProdAlive(activeProdC);
      const r = await syncTable(devC, activeProdC, cfg);
      if (r.prodC) activeProdC = r.prodC;
      summary.push({ table: cfg.name, ...r });
    } catch (e) {
      log(`  ✗ ${cfg.name}: ${e.message}`);
      summary.push({ table: cfg.name, error: e.message });
    }
  }

  log(`\n=== Resumo ===`);
  for (const s of summary) {
    if (s.error) log(`  ✗ ${s.table}: ERRO — ${s.error}`);
    else if (s.skipped) log(`  ⊘ ${s.table}: skipped`);
    else log(`  ${APPLY ? "✓" : "·"} ${s.table}: dev=${s.dev} prod=${s.prod} ${APPLY ? "→ inseridos/actualizados=" + s.inserted : "(dry-run)"}`);
  }

  if (APPLY) {
    try {
      await prodC.query("SET FOREIGN_KEY_CHECKS = 1");
      await prodC.query("SET UNIQUE_CHECKS = 1");
      log(`\n✓ FK checks restaurados em prod`);
    } catch (_) { /* prod conn pode estar fechada — ignora */ }
  }

  try { await devC.end();  } catch (_) {}
  try { await prodC.end(); } catch (_) {}
  log(`\nFeito. ${APPLY ? "Verifique em prod via /admin/* ." : "Para executar de verdade: npm run -- --apply, ou: node scripts/sync-dev-to-prod.js --apply"}\n`);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
