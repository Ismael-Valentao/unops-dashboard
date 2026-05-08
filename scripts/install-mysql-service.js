/**
 * Regista o MySQL do XAMPP como serviço Windows.
 *
 * O XAMPP por defeito não corre como serviço — tens de abrir o XAMPP Control
 * Panel e clicar "Start" todos os dias. Com este script, o MySQL passa a
 * correr como serviço Windows que arranca quando o computador liga.
 *
 * COMO CORRER (como administrador):
 *   node scripts/install-mysql-service.js
 *
 * Para desinstalar:
 *   node scripts/install-mysql-service.js --uninstall
 *
 * NOTA: Se o XAMPP Control Panel estava a correr o MySQL, fecha-o primeiro
 * (Stop no Control Panel) — senão dá conflito de porta 3306.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SERVICE_NAME = "MySQL_AQI";
const SERVICE_DISPLAY = "MySQL (AQI XAMPP)";
const XAMPP_MYSQLD = "C:\\xampp\\mysql\\bin\\mysqld.exe";
const XAMPP_INI    = "C:\\xampp\\mysql\\bin\\my.ini";

function checkAdmin() {
  try {
    fs.accessSync("C:\\Windows\\System32\\drivers\\etc\\hosts", fs.constants.W_OK);
    return true;
  } catch (_) { return false; }
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { error: e.message, stderr: e.stderr ? e.stderr.toString() : "", stdout: e.stdout ? e.stdout.toString() : "" };
  }
}

function serviceExists() {
  const out = run(`sc query "${SERVICE_NAME}"`);
  // sc query retorna 0 e info do serviço quando existe.
  // Quando NÃO existe, retorna stderr/stdout com "1060" / "does not exist" / "não existe".
  if (typeof out === "string") return /SERVICE_NAME/i.test(out) || /STATE/i.test(out);
  return false;
}

const isUninstall = process.argv.includes("--uninstall");

if (!checkAdmin()) {
  console.error("");
  console.error("✗ Este script tem de ser corrido COMO ADMINISTRADOR.");
  console.error("  Click direito em PowerShell → Executar como administrador.");
  console.error("");
  process.exit(1);
}

// ── UNINSTALL ──────────────────────────────────────────────
if (isUninstall) {
  console.log(`A parar e remover serviço '${SERVICE_NAME}'...`);
  run(`sc stop "${SERVICE_NAME}"`);
  // Aguarda 2s para o stop terminar
  const sleep = require("util").promisify(setTimeout);
  (async () => {
    await sleep(2000);
    const r = run(`sc delete "${SERVICE_NAME}"`);
    if (typeof r === "string") {
      console.log("✓ Serviço removido.");
    } else if (r.stderr && (r.stderr.includes("does not exist") || r.stderr.includes("não existe"))) {
      console.log("⚠ Serviço já não existia.");
    } else {
      console.error("✗ Erro:", r.stderr || r.error);
      process.exit(1);
    }
    console.log("Para voltar a arrancar o MySQL via XAMPP Control Panel: abre o painel e click 'Start'.");
  })();
} else {
  // ── INSTALL ──────────────────────────────────────────────
  // 1. Verifica que o XAMPP existe
  if (!fs.existsSync(XAMPP_MYSQLD)) {
    console.error(`✗ XAMPP não encontrado em ${XAMPP_MYSQLD}`);
    console.error("Se está noutra pasta, edita XAMPP_MYSQLD no topo deste script.");
    process.exit(1);
  }
  if (!fs.existsSync(XAMPP_INI)) {
    console.error(`✗ my.ini não encontrado em ${XAMPP_INI}`);
    process.exit(1);
  }

  // 2. Verifica se já existe
  if (serviceExists()) {
    console.log(`⚠ Serviço '${SERVICE_NAME}' já existe.`);
    console.log("Para reinstalar: node scripts/install-mysql-service.js --uninstall && node scripts/install-mysql-service.js");
    process.exit(0);
  }

  // 3. Cria o serviço. Note: precisa do --install para o mysqld
  //    saber registar-se como serviço Windows (abordagem nativa MySQL).
  console.log("A instalar MySQL como serviço Windows...");
  console.log(`  Nome:     ${SERVICE_NAME}`);
  console.log(`  Binary:   ${XAMPP_MYSQLD}`);
  console.log(`  Config:   ${XAMPP_INI}`);
  console.log("");
  console.log("⚠ Se o MySQL do XAMPP Control Panel está a correr, ele vai parar agora.");
  console.log("  Aguardar 3s...");

  // Tenta parar processos mysqld pendentes
  run(`taskkill /F /IM mysqld.exe`);
  // Espera para libertar a porta
  execSync("powershell -command Start-Sleep -Seconds 3");

  // 3a. Tenta mysqld --install (mais limpo que sc create)
  const installCmd = `"${XAMPP_MYSQLD}" --install "${SERVICE_NAME}" --defaults-file="${XAMPP_INI}"`;
  console.log("  Tentativa 1: mysqld --install");
  const r1 = run(installCmd);
  // mysqld output sai em STDOUT, não stderr, e exit code pode ser 0 mesmo em falha.
  // Verificamos pela mensagem ou pela existência efectiva via sc query.
  const r1Output = (typeof r1 === "string" ? r1 : (r1.stdout + r1.stderr)) || "";
  if (/Install\/Remove of the Service Denied/i.test(r1Output) ||
      /Access is denied/i.test(r1Output)) {
    console.error("");
    console.error("✗ ACESSO NEGADO ao instalar serviço.");
    console.error("");
    console.error("Output do mysqld:");
    console.error("  " + r1Output.trim().split("\n").join("\n  "));
    console.error("");
    console.error("ISTO SIGNIFICA que esta janela NÃO TEM privilégios de Administrador SUFICIENTES.");
    console.error("");
    console.error("PASSOS PARA RESOLVER:");
    console.error("");
    console.error("  1. Fecha COMPLETAMENTE esta janela do PowerShell.");
    console.error("");
    console.error("  2. Abre o menu INICIAR e escreve 'PowerShell'.");
    console.error("");
    console.error("  3. Click DIREITO no resultado 'Windows PowerShell' →");
    console.error("     'Executar como administrador' (Run as administrator).");
    console.error("");
    console.error("  4. CONFIRMA o aviso UAC (Sim/Yes).");
    console.error("");
    console.error("  5. VERIFICA que o título da janela diz:");
    console.error("       'Administrator: Windows PowerShell'");
    console.error("       (se não disser 'Administrator', NÃO é a janela certa)");
    console.error("");
    console.error("  6. cd \"" + path.join(__dirname, "..") + "\"");
    console.error("");
    console.error("  7. node scripts/install-mysql-service.js");
    console.error("");
    process.exit(1);
  }

  // Verifica se ficou registado
  if (!serviceExists()) {
    console.log("  mysqld --install não registou — fallback para sc create...");
    const scCmd = `sc create "${SERVICE_NAME}" binPath= "\\"${XAMPP_MYSQLD}\\" --defaults-file=\\"${XAMPP_INI}\\"" DisplayName= "${SERVICE_DISPLAY}" start= auto`;
    const r2 = run(scCmd);
    const r2Output = (typeof r2 === "string" ? r2 : (r2.stdout + r2.stderr)) || "";
    if (/Access is denied/i.test(r2Output) || /Acesso negado/i.test(r2Output)) {
      console.error("✗ Acesso negado também via sc create — sessão sem privilégios suficientes.");
      console.error("Re-abre PowerShell COMO ADMINISTRADOR (ver instruções acima).");
      process.exit(1);
    }
    if (!serviceExists()) {
      console.error("✗ Falha total a registar o serviço.");
      console.error("Output: " + r2Output);
      process.exit(1);
    }
  }

  console.log("✓ Serviço registado com sucesso.");

  // 4. Configurações finais
  run(`sc config "${SERVICE_NAME}" start= auto`);
  run(`sc description "${SERVICE_NAME}" "MySQL Database Server (XAMPP) — usado pelo dashboard AQI"`);
  run(`sc failure "${SERVICE_NAME}" reset= 86400 actions= restart/5000/restart/5000/restart/5000`);

  // 5. Arranca
  console.log("");
  console.log("A arrancar o serviço...");
  const r3 = run(`sc start "${SERVICE_NAME}"`);
  const r3Output = (typeof r3 === "string" ? r3 : (r3.stdout + r3.stderr)) || "";

  // Aguarda até 10s pelo serviço a ficar RUNNING
  let running = false;
  for (let i = 0; i < 10; i++) {
    execSync("powershell -command Start-Sleep -Seconds 1");
    const q = run(`sc query "${SERVICE_NAME}"`);
    if (typeof q === "string" && /STATE\s*:\s*\d+\s+RUNNING/i.test(q)) { running = true; break; }
  }

  if (running) {
    console.log("✓ MySQL a correr como serviço Windows.");
  } else {
    console.warn("⚠ Serviço registado mas não conseguiu arrancar.");
    console.warn("  Verifica em services.msc o estado de 'MySQL_AQI'.");
    console.warn("  Logs do MySQL em: C:\\xampp\\mysql\\data\\*.err");
  }

  console.log("");
  console.log("✓ Pronto! Daqui em diante, MySQL arranca sozinho quando o Windows liga.");
  console.log("");
  console.log("Comandos úteis:");
  console.log(`  Parar:        net stop "${SERVICE_NAME}"`);
  console.log(`  Iniciar:      net start "${SERVICE_NAME}"`);
  console.log(`  Status:       sc query "${SERVICE_NAME}"`);
  console.log(`  Desinstalar:  node scripts/install-mysql-service.js --uninstall`);
}
