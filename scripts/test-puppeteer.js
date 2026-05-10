const puppeteer = require("puppeteer");

(async () => {
  // Lista de candidatos por ordem de preferência:
  // 1) Chrome instalada do user (sempre actualizada)
  // 2) chrome-headless-shell baixado pelo puppeteer
  // 3) Chrome do cache do puppeteer (versão mais recente disponível)
  const path = require("path");
  const fs = require("fs");
  const os = require("os");

  const candidates = [
    "C:\\Users\\Ismael Chiziane\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    path.join(os.homedir(), ".cache", "puppeteer", "chrome-headless-shell", "win64-148.0.7778.97", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
  ];

  console.log("A testar candidates:");
  let found = null;
  for (const c of candidates) {
    const exists = fs.existsSync(c);
    console.log("  " + (exists ? "✓" : "✗") + " " + c);
    if (exists && !found) found = c;
  }
  if (!found) {
    console.error("Nenhum Chrome encontrado.");
    process.exit(1);
  }

  console.log("\nA usar: " + found);
  const b = await puppeteer.launch({ headless: true, executablePath: found });
  const v = await b.version();
  console.log("✓ Versão:", v);
  await b.close();
  console.log("✓ OK");
})().catch((e) => { console.error("✗", e.message); process.exit(1); });
