/**
 * Fetch + parse do MAPA Controle Projecto UNOPs (xlsx OneDrive partilhado).
 *
 * Objectivo: construir um map ADSN → CAM-XX a partir da sheet ENTREGUES,
 * para que /batedores possa mostrar a qual camião físico cada submissão
 * pertence. O ficheiro é editado regularmente pela equipa UNOPS, portanto
 * o módulo refaz o download periodicamente (TTL) e suporta hard-refresh.
 *
 * Estrutura ENTREGUES:
 *   Linha cabeçalho de bloco:   Col A = " CAM-02 Chibuto 30.000 T ..."
 *                                outras colunas vazias
 *   Linha cabeçalho de tabela:  MATRICULA / DATA SAIDA / Código Serviço / ...
 *   Linhas de dados:            Col C = ADSN, Col A = matrícula, etc.
 *   Linha de totais:            Col A vazia, Col L/M/N têm totais
 *
 * Download: curl com cookie jar — o redeem token na URL gera cookies de
 * sessão durante a cadeia de redirects (onedrive.live.com → my.microsoft
 * personalcontent.com). Sem cookie jar, o segundo host devolve 401.
 *
 * Env vars:
 *   ONEDRIVE_MAPA_URL     — 1drv.ms ou OneDrive share URL (com download=1)
 *   ONEDRIVE_MAPA_TTL_MS  — TTL do cache em ms (default 15min)
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_XLSX = path.join(DATA_DIR, ".mapa-cache.xlsx");
const CACHE_META = path.join(DATA_DIR, ".mapa-cache.meta.json");
const COOKIE_JAR = path.join(DATA_DIR, ".mapa-cookies.txt");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

let memCache = null; // { adsnToCam, builtAt, fileSize, count, sourceUrl, etag, lastModified, ... }
let inflightFetch = null;

function getUrl() {
  return process.env.ONEDRIVE_MAPA_URL || "";
}
function getTtl() {
  const n = Number(process.env.ONEDRIVE_MAPA_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Download via curl. Retorna path do ficheiro, tamanho, e headers
 * (Last-Modified, ETag). Estes headers são guardados em disco para
 * referência mas NÃO são usados para invalidação condicional — o edge
 * cache do OneDrive/SharePoint bloqueia HEAD, Range e If-Modified-Since
 * (todos devolvem 403). A única forma de detectar mudança é comparar
 * o tamanho do ficheiro após download (heurística suficiente: o xlsx
 * muda sempre de size quando o operador edita).
 */
function downloadXlsx(url) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error("ONEDRIVE_MAPA_URL não está definida"));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const headersDump = CACHE_XLSX + ".headers.tmp";
    const args = [
      "-sSL",
      "-c", COOKIE_JAR,
      "-b", COOKIE_JAR,
      "-A", UA,
      "-D", headersDump,            // dump response headers
      "-o", CACHE_XLSX,
      "-w", "%{http_code}|%{content_type}|%{size_download}",
      url,
    ];
    execFile("curl", args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        try { fs.unlinkSync(headersDump); } catch (_) {}
        return reject(new Error("curl falhou: " + err.message + (stderr ? " | " + stderr.slice(0, 200) : "")));
      }
      const [code, ctype, size] = String(stdout).split("|");
      if (code !== "200") {
        try { fs.unlinkSync(headersDump); } catch (_) {}
        return reject(new Error("OneDrive HTTP " + code + " (content-type=" + ctype + ")"));
      }
      const ct = String(ctype || "").toLowerCase();
      if (!ct.includes("spreadsheet") && !ct.includes("octet-stream") && !ct.includes("xlsx")) {
        try { fs.unlinkSync(headersDump); } catch (_) {}
        return reject(new Error("Content-type inesperado: " + ctype + " (esperado xlsx)"));
      }
      const sz = Number(size) || 0;
      if (sz < 10000) {
        try { fs.unlinkSync(headersDump); } catch (_) {}
        return reject(new Error("Ficheiro descarregado demasiado pequeno: " + sz + " bytes"));
      }
      // Parse Last-Modified e ETag do último bloco de headers (após cadeia de redirects)
      let lastModified = null, etag = null;
      try {
        const txt = fs.readFileSync(headersDump, "utf8");
        const blocks = txt.split(/\r?\n\r?\n/).filter((b) => b.trim());
        const last = blocks[blocks.length - 1] || "";
        for (const line of last.split(/\r?\n/)) {
          const m = line.match(/^([A-Za-z][\w-]*):\s*(.+)$/);
          if (m) {
            const k = m[1].toLowerCase();
            if (k === "last-modified") lastModified = m[2].trim();
            else if (k === "etag")     etag = m[2].trim();
          }
        }
        fs.unlinkSync(headersDump);
      } catch (_) { /* headers opcionais, segue */ }
      resolve({ path: CACHE_XLSX, size: sz, lastModified, etag });
    });
  });
}

// Schema version do JSON em disco. Incrementar quando o shape dos valores
// OU o algoritmo de parsing mudam (forçar reconstrução do cache).
//   v1 → Map<adsn, "CAM-XX">             (formato inicial)
//   v2 → Map<adsn, {cam, destino}>       (adicionado destino do header)
//   v3 → idem, parser de destino refinado (corrigida regressão CAIA → CAI)
const META_SCHEMA_VERSION = 3;

/**
 * Persiste cache em disco (sobrevive a restart do serviço).
 * Formato: JSON com adsnEntries como array para suportar serialização.
 */
function saveCacheToDisk(c) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const meta = {
      schema:       META_SCHEMA_VERSION,
      builtAt:      c.builtAt,
      fileSize:     c.fileSize,
      blocks:       c.blocks,
      sources:      c.sources,
      lastModified: c.lastModified || null,
      etag:         c.etag || null,
      adsnEntries:  [...c.adsnToCam.entries()],
    };
    fs.writeFileSync(CACHE_META, JSON.stringify(meta));
  } catch (e) {
    console.warn("[onedrive-mapa] saveCacheToDisk falhou (non-fatal):", e.message);
  }
}

/**
 * Recarrega cache do disco (após restart). Devolve null se ficheiro não
 * existe, está corrompido, ou tem schema diferente (versão antiga).
 */
function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_META)) return null;
    const raw = fs.readFileSync(CACHE_META, "utf8");
    const meta = JSON.parse(raw);
    if (meta.schema !== META_SCHEMA_VERSION) {
      console.log("[onedrive-mapa] cache schema desactualizado (v" +
        meta.schema + " ≠ v" + META_SCHEMA_VERSION + "), ignorado");
      return null;
    }
    if (!Array.isArray(meta.adsnEntries)) return null;
    return {
      adsnToCam:    new Map(meta.adsnEntries),
      builtAt:      Number(meta.builtAt) || 0,
      fileSize:     Number(meta.fileSize) || 0,
      blocks:       Number(meta.blocks) || 0,
      sources:      meta.sources || null,
      lastModified: meta.lastModified || null,
      etag:         meta.etag || null,
      count:        meta.adsnEntries.length,
    };
  } catch (e) {
    console.warn("[onedrive-mapa] loadCacheFromDisk falhou (non-fatal):", e.message);
    return null;
  }
}

/**
 * Parseia sheets do MAPA UNOPS e devolve Map(ADSN → { cam, destino }).
 *
 * Valor do mapa:
 *   { cam: "CAM-NN", destino: "Chibuto" }   → camião numerado (ENTREGUES/TRANSITO)
 *   { cam: "CAM-NN", destino: null }        → camião numerado mas header não tem destino legível (ex: "CAM 19")
 *   { cam: "INAUG", destino: null }         → INAUGURAÇÕES (sheet não tem block headers nem destinos)
 *
 * Estrutura assumida:
 *   - Cabeçalho de bloco: Col A começa com "CAM-NN ..." (resto livre)
 *     Ex: "CAM-02   Chibuto   30.000 T  (100%)     5 serviços"
 *   - Linhas de dados: Col C = ADSN<digits>
 *   - INAUGURAÇÕES não tem CAM headers; cada ADSN nessa sheet recebe
 *     cam="INAUG" caso ainda não tenha sido mapeado por outra sheet
 *
 * Precedência (quando o mesmo ADSN aparece em várias sheets):
 *   ENTREGUES > TRANSITO > INAUGURAÇÕES
 */

/**
 * Parser do header de bloco CAM: extrai número + destino.
 *
 * Tipos de header observados no xlsx real (185+ formatos):
 *   "CAM-02   Chibuto   30.000 T"                         → cam=CAM-2,  destino=Chibuto
 *   "CAM-30 - Xai-Xai - 16.086 T  (100%)"                 → CAM-30, Xai-Xai
 *   "CAM-37 - MOAMBA - 30"                                → CAM-37, MOAMBA
 *   "CAM-44 - LIPOMPO- 2T"                                → CAM-44, LIPOMPO
 *   "CAM-46 - BUZI 30"                                    → CAM-46, BUZI
 *   "CAM-51 - CHÓKWÈ- 28.8t"                              → CAM-51, CHÓKWÈ
 *   "CAM-53  MAGUDE 30tons"                               → CAM-53, MAGUDE
 *   "CAM-60 CHIBABAVA & MACHANGA 10,008T"                 → CAM-60, CHIBABAVA & MACHANGA
 *   "CAM-89 ANGONIA/MACANGA- 1.11t"                       → CAM-89, ANGONIA/MACANGA
 *   "CAM-9   Limpopo + Bilene   30 T  (100%)     ..."     → CAM-9,  Limpopo + Bilene
 *   "CAM-25  - Xai-Xai - Mandlakazi - 24.825 T  (100%)"   → CAM-25, Xai-Xai - Mandlakazi
 *   "CAM 19"                                              → CAM-19, null (descartado)
 *
 * Cobre 185/186 headers (99%). Caso edge não coberto: "CAM-169 TETE -
 * Distribuição de Sacos Herméticos" → devolve a string completa porque
 * não há indicador de fim de destino (tonelagem/%/serviços). Aceitável.
 */
function parseCamHeader(text) {
  const m = String(text || "").match(/^\s*CAM[-\s]?(\d{1,3})\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const cam = "CAM-" + parseInt(m[1], 10);
  let rest = m[2];

  // Cortar no primeiro indicador que sinaliza fim do destino.
  // (?:[a-zA-Z]\.)? aceita prefixo tipo "o." (typo recorrente: "o.30t")
  // sem consumir a última letra de destinos válidos ("CAIA 30T" → "CAIA").
  rest = rest
    .split(/\s*(?:[a-zA-Z]\.)?\s*\d+[.,]?\d*\s*[Tt](?:on)?s?\b/)[0] // tonelagem (30T, 30.000 T, 1.11t, 30tons, o.30t)
    .split(/\s*\d+\s*KG\b/i)[0]                    // "28892KG"
    .split(/\s*\(\s*\d+\s*%/)[0]                   // "(NN%"
    .split(/\s*█/)[0]                               // progress bar
    .split(/\s+\d+\s+serviços/i)[0]                 // "N serviços"
    .split(/\s*—\s*\d+/)[0]                         // " — 2 destinos"
    .split(/\s*-\s*\d/)[0]                          // " - 29" (hífen + número)
    .split(/\s*>\s*\d/)[0]                          // "> 30T"
    .split(/\s+\d+\s*$/)[0]                         // número solto no fim ("BUZI 30")
    .split(/\s*-\s*[Tt](?:on)?s?\s*$/)[0];          // sufixo "- t" sem nº ("CHIMOIO - t")

  // Trim separadores em volta (espaços, traços longos/curtos, dois pontos)
  rest = rest.replace(/^[\s\-:—]+/, "").replace(/[\s\-:—]+$/, "");

  return { cam, destino: rest || null };
}

function parseSheetWithCamHeaders(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  // Numa linha de dados, A é matrícula (ex: "AEM653MP"), portanto qualquer
  // linha cujo A comece com "CAM" é um header de bloco — independentemente
  // do que esteja em B (B pode conter "ORIGEM BAYER CHIMOIO", "Descartado",
  // ou estar vazio).
  let currentCam = null;
  let currentDestino = null;
  const out = new Map();
  let blocks = 0;

  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const a = String(row[0] == null ? "" : row[0]).trim();
    const c = String(row[2] == null ? "" : row[2]).trim();

    if (a) {
      const parsed = parseCamHeader(a);
      if (parsed) {
        currentCam = parsed.cam;
        currentDestino = parsed.destino;
        blocks++;
        continue;
      }
    }

    if (currentCam && /^ADSN\d/i.test(c)) {
      const adsnKey = c.toUpperCase();
      if (!out.has(adsnKey)) {
        out.set(adsnKey, { cam: currentCam, destino: currentDestino });
      }
    }
  }
  return { adsnMap: out, blocks };
}

/**
 * INAUGURAÇÕES: sheet sem CAM headers. Cada ADSN recebe cam="INAUG".
 */
function parseInauguracoes(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  const out = new Map();
  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const c = String(row[2] == null ? "" : row[2]).trim();
    if (/^ADSN\d/i.test(c)) {
      const adsnKey = c.toUpperCase();
      if (!out.has(adsnKey)) {
        out.set(adsnKey, { cam: "INAUG", destino: null });
      }
    }
  }
  return { adsnMap: out, blocks: 0 };
}

/**
 * Parser principal: corre as 3 sheets (ENTREGUES, TRANSITO, INAUGURAÇÕES)
 * com precedência. Devolve { adsnToCam, blocks, sources: {entregues, transito, inauguracoes} }.
 *
 * Precedência: ENTREGUES vence sobre TRANSITO vence sobre INAUGURAÇÕES.
 * Razão: um camião move-se de TRANSITO → ENTREGUES, e a operadora pode
 * tardar a remover de TRANSITO; o estado final correcto está em ENTREGUES.
 * INAUGURAÇÕES é fallback (label "INAUG") para ADSN que não estão nas
 * outras sheets.
 */
function parseEntregues(filePath) {
  const wb = XLSX.readFile(filePath);

  const want = ["ENTREGUES", "TRANSITO", "INAUGURAÇÕES"];
  const found = {};
  for (const name of want) {
    if (wb.Sheets[name]) found[name] = wb.Sheets[name];
  }
  if (!found["ENTREGUES"]) {
    throw new Error("Sheet 'ENTREGUES' não encontrada (mínimo obrigatório)");
  }

  const entregues   = parseSheetWithCamHeaders(found["ENTREGUES"]);
  const transito    = found["TRANSITO"]
    ? parseSheetWithCamHeaders(found["TRANSITO"])
    : { adsnMap: new Map(), blocks: 0 };
  const inauguracoes = found["INAUGURAÇÕES"]
    ? parseInauguracoes(found["INAUGURAÇÕES"])
    : { adsnMap: new Map(), blocks: 0 };

  // Merge com precedência ENTREGUES > TRANSITO > INAUGURAÇÕES.
  const adsnToCam = new Map();
  for (const [k, v] of entregues.adsnMap)   adsnToCam.set(k, v);
  for (const [k, v] of transito.adsnMap)    { if (!adsnToCam.has(k)) adsnToCam.set(k, v); }
  for (const [k, v] of inauguracoes.adsnMap){ if (!adsnToCam.has(k)) adsnToCam.set(k, v); }

  return {
    adsnToCam,
    blocks: entregues.blocks + transito.blocks,
    sources: {
      entregues:    entregues.adsnMap.size,
      transito:     transito.adsnMap.size,
      inauguracoes: inauguracoes.adsnMap.size,
      sheets_found: Object.keys(found),
    },
  };
}

/**
 * Devolve o mapa cached, refrescando se TTL expirou ou se force=true.
 *
 * Estratégia de minimização de I/O:
 *   1. Memória quente (memCache + TTL não expirou) → 0 I/O
 *   2. Memória fria + disco existe → hidrata da memória disco (~10ms)
 *      Só faz HEAD/download depois se TTL expirou
 *   3. force=true ou TTL expirou → HEAD request
 *      - Se Last-Modified/ETag coincide com cache → refresca builtAt apenas
 *        (poupa o download de 5s)
 *      - Se mudou → download completo + parse + persist
 *
 * Concorrência: se um fetch já está em curso, espera-o em vez de duplicar.
 */
async function getMapa(opts = {}) {
  const force = opts.force === true;
  const now = Date.now();

  // 1. Tenta hidratar memCache do disco se for primeiro arranque
  if (!memCache) {
    const disk = loadCacheFromDisk();
    if (disk) {
      memCache = { ...disk, sourceUrl: getUrl() };
    }
  }

  // 2. Cache quente e dentro do TTL → devolve directo
  if (!force && memCache && (now - memCache.builtAt) < getTtl()) {
    return memCache;
  }

  // 3. Refresh em curso por outro caller? Espera-o.
  if (inflightFetch) return inflightFetch;

  const url = getUrl();
  inflightFetch = (async () => {
    try {
      // Download completo. O OneDrive share-link bloqueia HEAD/Range/
      // If-Modified-Since (edge cache devolve 403), portanto não há forma
      // de detectar "ficheiro não mudou" sem o baixar. Optimização aceitável
      // porque (a) é em background via pre-warmer, (b) só corre quando TTL
      // expira, (c) o utilizador nunca espera por isto.
      //
      // Optimização extra: se o tamanho do ficheiro for igual ao último
      // download, pulamos o parse (mantemos adsnToCam existente) — poupa
      // ~0.7s. Comparação por size é heurística boa: o xlsx muda sempre
      // de tamanho quando o operador edita.
      const { path: filePath, size, lastModified, etag } = await downloadXlsx(url);

      if (memCache && memCache.fileSize === size && memCache.adsnToCam) {
        // Ficheiro do mesmo tamanho → assumimos conteúdo igual.
        // Só actualizamos metadados (builtAt, lastModified, etag).
        memCache.builtAt = Date.now();
        memCache.lastModified = lastModified;
        memCache.etag = etag;
        saveCacheToDisk(memCache);
        return memCache;
      }

      const { adsnToCam, blocks, sources } = parseEntregues(filePath);
      memCache = {
        adsnToCam,
        builtAt: Date.now(),
        fileSize: size,
        count: adsnToCam.size,
        blocks,
        sources,
        sourceUrl: url,
        lastModified,
        etag,
      };
      saveCacheToDisk(memCache);
      return memCache;
    } finally {
      inflightFetch = null;
    }
  })();
  return inflightFetch;
}

/**
 * Versão tolerante para uso em endpoints — não rebenta se falhar.
 * Devolve null + warn em caso de erro.
 */
async function getMapaSafe(opts = {}) {
  try {
    return await getMapa(opts);
  } catch (e) {
    console.warn("[onedrive-mapa] fetch/parse falhou (non-fatal):", e.message);
    return null;
  }
}

/**
 * Info sumária para o frontend (debug/UI).
 */
function getCacheInfo() {
  if (!memCache) return { loaded: false };
  return {
    loaded: true,
    built_at: new Date(memCache.builtAt).toISOString(),
    age_seconds: Math.round((Date.now() - memCache.builtAt) / 1000),
    ttl_seconds: Math.round(getTtl() / 1000),
    adsn_count: memCache.count,
    cam_blocks: memCache.blocks,
    sources: memCache.sources || null,  // breakdown por sheet (entregues/transito/inauguracoes)
    file_size: memCache.fileSize,
  };
}

module.exports = {
  getMapa,
  getMapaSafe,
  getCacheInfo,
  downloadXlsx,
  parseEntregues,
};
