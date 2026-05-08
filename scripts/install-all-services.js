/**
 * Instala TUDO o que é preciso para o sistema correr sozinho:
 *   1. MySQL (XAMPP) como serviço Windows
 *   2. AQI Dashboard (Node.js) como serviço Windows
 *
 * Depois disto, basta ligar o computador. Tudo arranca automaticamente.
 *
 * COMO CORRER (UMA vez, como administrador):
 *   1. Abre PowerShell COMO ADMINISTRADOR
 *   2. cd "C:\Users\Ismael Chiziane\Documents\Claude\aqi-dashboard"
 *   3. node scripts/install-all-services.js
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function checkAdmin() {
  try {
    fs.accessSync("C:\\Windows\\System32\\drivers\\etc\\hosts", fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
}

if (!checkAdmin()) {
  console.error("");
  console.error("✗ ESTE SCRIPT TEM DE SER CORRIDO COMO ADMINISTRADOR.");
  console.error("");
  console.error("  1. Procura 'PowerShell' no menu Iniciar.");
  console.error("  2. Click DIREITO em 'PowerShell' → 'Executar como administrador'.");
  console.error("  3. cd \"" + path.join(__dirname, "..") + "\"");
  console.error("  4. node scripts/install-all-services.js");
  console.error("");
  process.exit(1);
}

console.log("=".repeat(70));
console.log("INSTALAÇÃO DE SERVIÇOS — AQI Dashboard");
console.log("=".repeat(70));
console.log("");

// ── 1. MySQL ─────────────────────────────────────────────────
console.log("[1/2] A instalar MySQL como serviço Windows...");
const mysqlScript = path.join(__dirname, "install-mysql-service.js");
const r1 = spawnSync("node", [mysqlScript], { stdio: "inherit" });
if (r1.status !== 0) {
  console.error("");
  console.error("✗ Falhou a instalação do MySQL como serviço.");
  console.error("Continuando para o Node.js — podes correr `node scripts/install-mysql-service.js` depois.");
  console.error("");
}
console.log("");

// ── 2. AQI Dashboard ─────────────────────────────────────────
console.log("[2/2] A instalar AQI Dashboard (Node.js) como serviço Windows...");
const dashScript = path.join(__dirname, "install-service.js");
const r2 = spawnSync("node", [dashScript], { stdio: "inherit" });
if (r2.status !== 0) {
  console.error("✗ Falhou a instalação do AQI Dashboard como serviço.");
  process.exit(1);
}

console.log("");
console.log("=".repeat(70));
console.log("✓ INSTALAÇÃO CONCLUÍDA");
console.log("=".repeat(70));
console.log("");
console.log("O QUE MUDOU:");
console.log("  - 'MySQL_AQI'    — serviço Windows (auto-arranca quando ligas o PC)");
console.log("  - 'AQI Dashboard'— serviço Windows (auto-arranca quando ligas o PC)");
console.log("");
console.log("VERIFICAR: services.msc → procura 'AQI Dashboard' e 'MySQL (AQI XAMPP)'");
console.log("");
console.log("ACEDER:    http://localhost:5000");
console.log("");
console.log("PROBLEMAS? Logs em:");
console.log("  %LOCALAPPDATA%\\AQI_Dashboard.daemon\\aqidashboard.err.log");
