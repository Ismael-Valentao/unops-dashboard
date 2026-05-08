/**
 * Remove TODOS os serviços instalados pelo install-all-services.js.
 * Deixa o projecto intacto — apenas para de arrancar automaticamente.
 *
 * USO (como administrador):
 *   node scripts/uninstall-all-services.js
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function checkAdmin() {
  try {
    fs.accessSync("C:\\Windows\\System32\\drivers\\etc\\hosts", fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
}

if (!checkAdmin()) {
  console.error("✗ Corre como administrador (PowerShell → Executar como administrador).");
  process.exit(1);
}

console.log("A remover serviços…");
console.log("");

console.log("[1/2] AQI Dashboard...");
spawnSync("node", [path.join(__dirname, "uninstall-service.js")], { stdio: "inherit" });

console.log("");
console.log("[2/2] MySQL (XAMPP)...");
spawnSync("node", [path.join(__dirname, "install-mysql-service.js"), "--uninstall"], { stdio: "inherit" });

console.log("");
console.log("✓ Todos os serviços removidos.");
console.log("Para correr manualmente:");
console.log("  - MySQL:    abre o XAMPP Control Panel → click 'Start' em MySQL");
console.log("  - App:      cd <projecto> && node app.js");
