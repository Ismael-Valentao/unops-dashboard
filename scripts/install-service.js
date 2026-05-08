/**
 * Instala a app AQI Dashboard como SERVIÇO DO WINDOWS.
 *
 * Depois de correr este script (UMA VEZ, como administrador):
 *   - O serviço "AQI Dashboard" aparece em services.msc
 *   - Arranca automaticamente quando ligas o computador
 *   - Reinicia automaticamente se crashar
 *   - Não precisas mais correr `node app.js` manualmente
 *
 * COMO CORRER:
 *   1. Abre PowerShell ou CMD COMO ADMINISTRADOR
 *      (Click direito no ícone → "Executar como administrador")
 *   2. cd "C:\Users\Ismael Chiziane\Documents\Claude\aqi-dashboard"
 *   3. node scripts/install-service.js
 *
 * Para desinstalar: node scripts/uninstall-service.js
 *
 * Logs do serviço:
 *   - Output normal: %LOCALAPPDATA%\AQI_Dashboard.daemon\aqidashboard.out.log
 *   - Erros:         %LOCALAPPDATA%\AQI_Dashboard.daemon\aqidashboard.err.log
 *   - Event Viewer Windows também regista start/stop/erros
 */

const { Service } = require("node-windows");
const path = require("path");
const fs = require("fs");

// Aviso se não for admin (não há check perfeito em Node, mas detectamos
// pela falha mais comum: tentar escrever numa pasta protegida)
function checkAdmin() {
  try {
    fs.accessSync("C:\\Windows\\System32\\drivers\\etc\\hosts", fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

if (!checkAdmin()) {
  console.error("");
  console.error("✗ ESTE SCRIPT TEM DE SER CORRIDO COMO ADMINISTRADOR");
  console.error("");
  console.error("  1. Fecha esta janela.");
  console.error("  2. Procura 'PowerShell' no menu Iniciar.");
  console.error("  3. Click DIREITO em 'PowerShell' → 'Executar como administrador'.");
  console.error("  4. cd \"" + path.join(__dirname, "..") + "\"");
  console.error("  5. node scripts/install-service.js");
  console.error("");
  process.exit(1);
}

const projectDir = path.join(__dirname, "..");
const scriptPath = path.join(projectDir, "app.js");

const svc = new Service({
  name: "AQI Dashboard",
  description: "AQI - Casa do Agricultor — Dashboard de Distribuição. Auto-arranca quando o Windows liga.",
  script: scriptPath,
  // Opções do Node: aumenta a memória disponível (planeamento + MAAP usam algumas centenas de MB)
  nodeOptions: ["--max-old-space-size=4096"],
  workingDirectory: projectDir,
  // Variáveis de ambiente — node-windows guarda no Registry
  env: [
    { name: "NODE_ENV", value: "production" },
  ],
  // Se crashar, espera 1s e reinicia. Se crashar 5x seguidas, espera 30s.
  wait: 1,
  grow: 0.25,
  maxRestarts: 40,
});

svc.on("install", () => {
  console.log("");
  console.log("✓ Serviço 'AQI Dashboard' instalado com sucesso!");
  console.log("");
  console.log("  - Aparece em services.msc como 'AQI Dashboard'");
  console.log("  - Auto-arranca quando o Windows liga");
  console.log("  - Reinicia automaticamente se crashar");
  console.log("  - Logs em %LOCALAPPDATA%\\AQI_Dashboard.daemon\\");
  console.log("");
  console.log("A iniciar serviço pela primeira vez...");
  svc.start();
});

svc.on("alreadyinstalled", () => {
  console.log("");
  console.log("⚠  Serviço já está instalado.");
  console.log("");
  console.log("Para reinstalar (ex: depois de actualizar app.js):");
  console.log("  1. node scripts/uninstall-service.js");
  console.log("  2. node scripts/install-service.js");
  console.log("");
  console.log("Ou tenta apenas reiniciar:");
  console.log("  net stop \"AQI Dashboard\" && net start \"AQI Dashboard\"");
  console.log("");
  process.exit(0);
});

svc.on("start", () => {
  console.log("");
  console.log("✓ Serviço iniciado. Acede em: http://localhost:5000");
  console.log("");
  console.log("Para verificar status: services.msc → procura 'AQI Dashboard'");
  console.log("Para parar: net stop \"AQI Dashboard\"");
  console.log("Para iniciar: net start \"AQI Dashboard\"");
  console.log("");
  process.exit(0);
});

svc.on("error", (err) => {
  console.error("✗ Erro:", err);
  process.exit(1);
});

svc.on("invalidinstallation", () => {
  console.error("✗ Instalação corrompida. Limpa com: node scripts/uninstall-service.js");
  process.exit(1);
});

console.log("A instalar serviço Windows 'AQI Dashboard'...");
console.log("  Script: " + scriptPath);
console.log("  Pasta:  " + projectDir);
svc.install();
