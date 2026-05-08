/**
 * Diagnostica o ambiente para instalação dos serviços.
 * Não instala nada — só verifica e dá feedback.
 *
 * USO: node scripts/diagnose-services.js
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function ok(msg)   { console.log("  ✓ " + msg); }
function fail(msg) { console.log("  ✗ " + msg); }
function warn(msg) { console.log("  ⚠ " + msg); }
function info(msg) { console.log("    " + msg); }

function run(cmd) {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return { error: e.message, stderr: (e.stderr||"").toString(), stdout: (e.stdout||"").toString() }; }
}

console.log("=".repeat(70));
console.log("DIAGNÓSTICO DE INSTALAÇÃO DE SERVIÇOS");
console.log("=".repeat(70));
console.log("");

// 1. Admin?
console.log("[1/6] Permissões de administrador:");
let isAdmin = false;
try {
  fs.accessSync("C:\\Windows\\System32\\drivers\\etc\\hosts", fs.constants.W_OK);
  isAdmin = true;
  ok("A correr como ADMINISTRADOR ✓");
} catch (_) {
  fail("NÃO está a correr como administrador.");
  info("Solução: fechar PowerShell, abrir como Administrador e correr de novo.");
}
console.log("");

// 2. node-windows instalado?
console.log("[2/6] Pacote node-windows:");
const nwPath = path.join(__dirname, "..", "node_modules", "node-windows");
if (fs.existsSync(nwPath)) {
  ok("node-windows instalado em " + nwPath);
} else {
  fail("node-windows NÃO instalado.");
  info("Solução: cd <projecto> && npm install");
}
console.log("");

// 3. XAMPP existe?
console.log("[3/6] Instalação do XAMPP:");
const mysqld = "C:\\xampp\\mysql\\bin\\mysqld.exe";
const myini  = "C:\\xampp\\mysql\\bin\\my.ini";
if (fs.existsSync(mysqld) && fs.existsSync(myini)) {
  ok("XAMPP MySQL encontrado");
  info("mysqld.exe: " + mysqld);
  info("my.ini:     " + myini);
} else {
  fail("XAMPP MySQL NÃO encontrado em C:\\xampp\\mysql\\bin\\");
  info("Se o XAMPP está noutra pasta, edita scripts/install-mysql-service.js linhas 21-22");
}
console.log("");

// 4. Porta 3306 livre?
console.log("[4/6] Porta 3306 (MySQL):");
const portCheck = run('netstat -ano | findstr ":3306" | findstr "LISTENING"');
if (typeof portCheck === "string" && portCheck.trim()) {
  warn("Algo já está a usar a porta 3306:");
  info(portCheck.trim());
  info("Provavelmente o MySQL já está a correr (XAMPP Control Panel?). Se sim, OK.");
} else {
  info("Porta 3306 livre.");
}
console.log("");

// 5. Serviços já instalados?
console.log("[5/6] Estado dos serviços:");
const svcMysql = run('sc query "MySQL_AQI"');
if (typeof svcMysql === "string") {
  ok("Serviço MySQL_AQI EXISTE");
  const stateMatch = svcMysql.match(/STATE\s*:\s*\d+\s+(\w+)/);
  if (stateMatch) info("  estado: " + stateMatch[1]);
} else {
  warn("Serviço MySQL_AQI NÃO existe (ainda não instalado).");
}
const svcDash = run('sc query "AQI Dashboard"');
if (typeof svcDash === "string") {
  ok("Serviço 'AQI Dashboard' EXISTE");
  const stateMatch = svcDash.match(/STATE\s*:\s*\d+\s+(\w+)/);
  if (stateMatch) info("  estado: " + stateMatch[1]);
} else {
  warn("Serviço 'AQI Dashboard' NÃO existe (ainda não instalado).");
}
console.log("");

// 6. Logs do node-windows (se já tentou instalar)
console.log("[6/6] Logs do node-windows:");
const logDir = path.join(process.env.LOCALAPPDATA || "", "AQI_Dashboard.daemon");
if (fs.existsSync(logDir)) {
  const files = fs.readdirSync(logDir);
  ok("Pasta de logs existe: " + logDir);
  for (const f of files) {
    const fpath = path.join(logDir, f);
    const stat = fs.statSync(fpath);
    info(`  ${f.padEnd(40)} ${(stat.size/1024).toFixed(1)} KB  ${stat.mtime.toLocaleString("pt-PT")}`);
    // Imprime últimas 10 linhas se for log
    if (f.endsWith(".log") && stat.size > 0 && stat.size < 200000) {
      const content = fs.readFileSync(fpath, "utf8");
      const lines = content.split("\n").filter(Boolean).slice(-10);
      if (lines.length) {
        info(`  --- últimas 10 linhas de ${f} ---`);
        for (const l of lines) info("    " + l);
      }
    }
  }
} else {
  warn("Pasta de logs não existe — node-windows ainda não foi corrido.");
}

console.log("");
console.log("=".repeat(70));
if (isAdmin) {
  console.log("PRÓXIMO PASSO: node scripts/install-all-services.js");
} else {
  console.log("PRÓXIMO PASSO: re-abre PowerShell como Administrador, depois corre");
  console.log("                node scripts/install-all-services.js");
}
console.log("=".repeat(70));
