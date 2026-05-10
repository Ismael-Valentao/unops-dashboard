/**
 * Geração de PDF do Roteiro do Motorista usando Puppeteer (headless Chrome).
 *
 * Por que Puppeteer em vez de html2pdf.js?
 *   - html2pdf.js renderiza a página → canvas → divide em páginas via JS.
 *     Funciona MAL com tabelas longas, layouts flex, e largura variável
 *     (no nosso caso, conteúdo cortado à direita em PDFs reais).
 *   - Puppeteer usa o motor de print real do Chrome → respeita TODAS as
 *     regras de @media print, page-break-*, e calcula larguras certas.
 *
 * Estratégia de browser:
 *   1) Chrome instalada do utilizador (sempre actualizada) — preferida
 *   2) chrome-headless-shell que vem com o puppeteer
 *   3) Cache de Chrome dos antigos puppeteers
 *
 * Reutilizamos a MESMA página HTML que já existe (/admin/servicos/:id/roteiro)
 * — Puppeteer abre essa URL no localhost com a sessão do utilizador (cookies)
 * e gera PDF directamente. Zero duplicação de markup.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

let cachedBrowser = null;       // browser persistido entre requests
let cachedExecutablePath = null;

function findExecutable() {
  if (cachedExecutablePath) return cachedExecutablePath;
  const candidates = [
    // 1. Chrome instalada do user (Windows típico)
    path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    // 2. Microsoft Edge (também é Chromium)
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  // 3. Chrome-headless-shell descarregado pelo puppeteer (último recurso)
  const cacheDir = path.join(os.homedir(), ".cache", "puppeteer", "chrome-headless-shell");
  if (fs.existsSync(cacheDir)) {
    for (const sub of fs.readdirSync(cacheDir)) {
      const exe = path.join(cacheDir, sub, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  }
  // 4. Chrome cached do puppeteer (várias versões antigas que ficam no cache)
  const chromeDir = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (fs.existsSync(chromeDir)) {
    for (const sub of fs.readdirSync(chromeDir)) {
      const exe = path.join(chromeDir, sub, "chrome-win64", "chrome.exe");
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedExecutablePath = c;
      return c;
    }
  }
  return null;
}

async function getBrowser() {
  if (cachedBrowser && cachedBrowser.connected) return cachedBrowser;
  const puppeteer = require("puppeteer");
  const exe = findExecutable();
  if (!exe) throw new Error("Nenhum Chrome encontrado para o Puppeteer (instala Chrome ou re-corre `npm install puppeteer`).");
  cachedBrowser = await puppeteer.launch({
    headless: true,
    executablePath: exe,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  cachedBrowser.on("disconnected", () => { cachedBrowser = null; });
  return cachedBrowser;
}

/**
 * Gera o PDF do Roteiro do serviço dado.
 *
 * @param {object} opts
 * @param {string|number} opts.serviceId — id do serviço
 * @param {string} opts.baseUrl — base URL do servidor (ex: "http://localhost:5000")
 * @param {object} [opts.cookies] — cookies a injectar (sessão do user)
 * @returns {Promise<Buffer>} PDF como buffer
 */
async function generateRoteiroPdf({ serviceId, baseUrl, cookies }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // Injecta cookies de sessão para passar pelo middleware de auth.
    if (cookies && Object.keys(cookies).length) {
      const url = new URL(baseUrl);
      const cookiesArr = Object.entries(cookies).map(([name, value]) => ({
        name, value: String(value), domain: url.hostname, path: "/",
      }));
      await page.setCookie(...cookiesArr);
    }

    const targetUrl = `${baseUrl.replace(/\/$/, "")}/admin/servicos/${encodeURIComponent(serviceId)}/roteiro`;

    // Navega e espera pelo conteúdo carregar (a página faz fetch async)
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Espera até a tabela de beneficiários estar renderizada (a página
    // mostra "A carregar roteiro…" inicialmente). Timeout 15s.
    await page.waitForSelector("table.benef-list tbody tr", { timeout: 15000 }).catch(() => {
      // Se a tabela não aparecer (pode ser um serviço vazio) seguimos
      // mesmo assim — o utilizador verá o que existe.
    });

    // Pequena pausa para garantir que fontes e estilos finais aplicam
    await page.evaluate(() => new Promise((r) => setTimeout(r, 250)));

    // Esconde o toolbar (botões "Voltar/Imprimir/Baixar PDF") no PDF
    await page.addStyleTag({
      content: `
        .toolbar, .no-print { display: none !important; }
        body { background: #fff !important; }
        .page { box-shadow: none !important; max-width: 100% !important; margin: 0 !important; padding: 0 !important; }
      `,
    });

    // Gera PDF: A4 com margens padrão (25.4mm = 1 polegada, igual ao
    // "Normal" do Word/LibreOffice). Background preservado para os
    // headers azuis e banner amarelo aparecerem com cor.
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "25.4mm", right: "25.4mm", bottom: "25.4mm", left: "25.4mm" },
      displayHeaderFooter: false,
      preferCSSPageSize: false,
    });

    return pdf;
  } finally {
    await page.close().catch(() => { /* ignore */ });
  }
}

/** Tear down (chamado no graceful shutdown — opcional). */
async function closeBrowser() {
  if (cachedBrowser) {
    try { await cachedBrowser.close(); } catch (_) { /* ignore */ }
    cachedBrowser = null;
  }
}

module.exports = { generateRoteiroPdf, closeBrowser, findExecutable };
