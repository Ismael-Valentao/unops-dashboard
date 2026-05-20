#!/usr/bin/env node
/**
 * Alterna o profile de DB activa entre "local" e "prod".
 *
 * Edita a linha DB_PROFILE no .env e dá instruções sobre o restart.
 *
 * USAGE:
 *   node scripts/db-switch.js status   → mostra qual está activa
 *   node scripts/db-switch.js local    → muda para local
 *   node scripts/db-switch.js prod     → muda para prod (Hostinger)
 *   node scripts/db-switch.js          → mostra ajuda + status
 */
const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");
const ENV_PROD_PATH = path.join(__dirname, "..", ".env.prod");

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function getCurrentProfile() {
  const text = readEnvFile(ENV_PATH);
  if (!text) return null;
  const m = text.match(/^DB_PROFILE\s*=\s*(\S+)/m);
  return m ? m[1].toLowerCase() : "local";
}

function setProfile(profile) {
  let text = readEnvFile(ENV_PATH);
  if (!text) { console.error("✗ .env não encontrado"); process.exit(2); }
  if (/^DB_PROFILE\s*=/m.test(text)) {
    text = text.replace(/^DB_PROFILE\s*=.*$/m, `DB_PROFILE=${profile}`);
  } else {
    // Adiciona no topo
    text = `DB_PROFILE=${profile}\n` + text;
  }
  fs.writeFileSync(ENV_PATH, text);
}

function showStatus() {
  const profile = getCurrentProfile();
  const text = readEnvFile(ENV_PATH);
  const localHost = (text || "").match(/^DB_HOST\s*=\s*(.+)$/m)?.[1]?.trim() || "?";
  const localName = (text || "").match(/^DB_NAME\s*=\s*(.+)$/m)?.[1]?.trim() || "?";
  let prodHost = "?", prodName = "?", prodAvail = false;
  const prodText = readEnvFile(ENV_PROD_PATH);
  if (prodText) {
    prodHost = prodText.match(/^DB_HOST\s*=\s*(.+)$/m)?.[1]?.trim() || "?";
    prodName = prodText.match(/^DB_NAME\s*=\s*(.+)$/m)?.[1]?.trim() || "?";
    prodAvail = !!prodHost && prodHost !== "?";
  }
  console.log();
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  DB Profile actual:  ${profile === "prod" ? "⚠️  PROD" : "✓ local"}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  local  ${profile === "local" ? "← activo" : ""}`);
  console.log(`         host:     ${localHost}`);
  console.log(`         database: ${localName}`);
  console.log();
  console.log(`  prod   ${profile === "prod" ? "← activo" : (prodAvail ? "" : "(.env.prod NÃO encontrado)")}`);
  if (prodAvail) {
    console.log(`         host:     ${prodHost}`);
    console.log(`         database: ${prodName}`);
  }
  console.log();
  console.log("Para alternar:");
  console.log("  node scripts/db-switch.js local");
  console.log("  node scripts/db-switch.js prod");
  console.log();
}

const arg = (process.argv[2] || "").toLowerCase();

if (!arg || arg === "status" || arg === "--help" || arg === "-h") {
  showStatus();
  process.exit(0);
}

if (arg !== "local" && arg !== "prod") {
  console.error("✗ Argumento inválido. Use 'local', 'prod' ou 'status'.");
  process.exit(1);
}

if (arg === "prod" && !fs.existsSync(ENV_PROD_PATH)) {
  console.error("✗ .env.prod não existe — crie-o primeiro com as credenciais prod.");
  console.error("  Template em mensagens anteriores ou em .env.example.");
  process.exit(2);
}

const current = getCurrentProfile();
if (current === arg) {
  console.log(`✓ Já está em "${arg}" — nada para mudar.`);
  process.exit(0);
}

setProfile(arg);
console.log();
console.log(`✓ DB_PROFILE alterado para "${arg}" no .env`);
console.log();
console.log("Próximo passo — reinicie o serviço para aplicar:");
console.log();
console.log("  PowerShell (admin):  Restart-Service \"AQI Dashboard\" -Force");
console.log("  CMD (admin):         net stop \"AQI Dashboard\" && net start \"AQI Dashboard\"");
console.log();
if (arg === "prod") {
  console.log("⚠️  ATENÇÃO: O serviço local vai começar a escrever directamente na DB PROD.");
  console.log("   Sessões, audit, polling, batedores — tudo será persistido em prod.");
  console.log("   Para voltar a local: node scripts/db-switch.js local");
  console.log();
}
