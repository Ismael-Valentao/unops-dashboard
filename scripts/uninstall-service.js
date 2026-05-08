/**
 * Desinstala o serviço Windows "AQI Dashboard".
 *
 * COMO CORRER (como administrador):
 *   node scripts/uninstall-service.js
 *
 * Depois disto, a app deixa de arrancar automaticamente. Os ficheiros do
 * projecto NÃO são tocados.
 */

const { Service } = require("node-windows");
const path = require("path");

const svc = new Service({
  name: "AQI Dashboard",
  script: path.join(__dirname, "..", "app.js"),
});

svc.on("uninstall", () => {
  console.log("");
  console.log("✓ Serviço 'AQI Dashboard' desinstalado.");
  console.log("");
  console.log("  - Já não aparece em services.msc");
  console.log("  - A app deixa de arrancar automaticamente");
  console.log("  - Para correr manualmente: node app.js");
  console.log("");
  process.exit(0);
});

svc.on("alreadyuninstalled", () => {
  console.log("⚠ Serviço já estava desinstalado.");
  process.exit(0);
});

svc.on("error", (err) => {
  console.error("✗ Erro ao desinstalar:", err);
  console.error("Se o erro persistir, tenta apagar manualmente:");
  console.error("  sc delete \"AQI Dashboard\"");
  process.exit(1);
});

console.log("A desinstalar serviço 'AQI Dashboard'...");
svc.uninstall();
