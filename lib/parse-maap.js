/**
 * Parser dos ficheiros oficiais MAAP (Ministério da Agricultura).
 *
 * 1 ficheiro por província, cada com a contagem REAL e ACTUALIZADA de kits
 * por extensionista. Esta é a fonte de verdade para "quanto cada
 * extensionista deve receber" — substitui os valores antigos da sheet
 * "Planeamento Pós Realocação" que tinham dados desactualizados.
 *
 * Uso típico:
 *   const { loadMAAP, applyKitRecipe, KIT_RECIPE } = require("./parse-maap");
 *   const maap = loadMAAP();           // { ext_id → { kit1, kit2, ... } }
 *   const planned = applyKitRecipe(maap.ext_id, "Milho");  // total kg
 */

const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

// Diretório padrão onde estão os 6 ficheiros (1 por província).
// Localizado dentro do projecto (data/maap/) para que o deploy os leve
// automaticamente — funciona em dev (Windows) e em prod (Linux).
// Pode ser sobrescrito via env MAAP_DIR caso queiras mantê-los noutro local.
const DEFAULT_DIR = process.env.MAAP_DIR
  || path.join(__dirname, "..", "data", "maap");

// Ficheiros conhecidos (province → filename).
// Se o nome mudar, basta actualizar aqui.
const FILES = {
  Maputo:   "UPDATED INFORMATION FOR MAPUTO LIST.xlsx",
  Gaza:     "UPDATED INFORMATION FOR GAZA LIST.xlsx",
  Sofala:   "Copy of List Sofala.xlsx",
  Zambezia: "List Zambezia.xlsx",
  Manica:   "UPDATED INFORMATION FOR MANICA LIST.xlsx",
  Tete:     "UPDATED INFORMATION FOR TETE LIST (2).xlsx",
};

// Mapa de variantes ortográficas → nome canónico do distrito.
// Mantém-se sincronizado com lib/distribution-bootstrap.js → DISTRICT_ALIASES.
// Os ficheiros MAAP às vezes trazem grafias diferentes (ex: "Chongoene" vs
// "Chonguene") — esta tabela colapsa para a forma canónica usada na DB.
const DISTRICT_ALIASES = {
  "Chongoene": "Chonguene",
};

// Mapa de NOMES → ID correcto. Usado para resolver colisões de
// Extensionist_ID nos ficheiros MAAP, onde duas pessoas distintas têm o
// mesmo ID (provavelmente erro de digitação no source). Quando o parser
// encontra um destes nomes, usa o ID correcto em vez do que está no Excel.
//
// Esta tabela é a "source of truth" em código — não depende do que está
// no Excel. Se o Excel for corrigido depois, podemos retirar o nome daqui
// (mas não faz mal manter; a correspondência é idempotente).
//
// Origem dos IDs: confirmados pelo coordenador AQI no sistema MAAP
// (2026-05-06). Ver scripts/maap-conflicts-report.js para análise.
const MAAP_NAME_TO_ID_OVERRIDE = {
  // Tete — Chifunde (não Maravia)
  "Albertina Reis Martinho":         "0510-0008",
  // Tete — Mutarara (não Maravia, prefixo 0515)
  "Antonio Osvaldo Ausse":           "0515-0001",
  "Carlito Jose Angola":             "0515-0002",
  "Isaquel Amilcar Andate-Fanessi":  "0515-0003",
  "Julio Vasco Chimica":             "0515-0004",
  "Meque Nhamitambo":                "0515-0005",
  // Manica — Sussundenga (não Vanduzi/Barue, prefixo 0212)
  "Antonio J. Azeite":               "0212-0001",
  "Guilherme Mardez":                "0212-0002",
};

function normalizeDistrict(d) {
  if (!d) return "";
  const s = String(d).trim();
  if (!s) return "";
  const titleCased = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return DISTRICT_ALIASES[titleCased] || titleCased;
}

// Composição do Kit 1 e Kit 2 (por família/agricultor).
// Lido da sheet "Composição dos Kits" do Planeamento_Actualizado.xlsx.
// O nome do produto está alinhado com o "Referencia" usado no resto do
// sistema. Unidades estão na coluna unit.
const KIT_RECIPE = {
  Milho:                { unit: "Kg", kit1: 12.5, kit2: 0 },
  Arroz:                { unit: "Kg", kit1: 0,    kit2: 50 },
  "Feijão Vulgar":      { unit: "Kg", kit1: 15,   kit2: 15 },
  Couve:                { unit: "g",  kit1: 10,   kit2: 10 },
  Alface:               { unit: "g",  kit1: 10,   kit2: 10 },
  "NPK 12.24.12":       { unit: "Kg", kit1: 50,   kit2: 50 },
  Enxada:               { unit: "un", kit1: 1,    kit2: 1 },
  "Emamectim Benzoato": { unit: "L",  kit1: 0.5,  kit2: 0.5 },
  Imidacloprid:         { unit: "L",  kit1: 0.5,  kit2: 0 },
  MCPA:                 { unit: "L",  kit1: 0,    kit2: 1.5 },
  // Sacos: 20 un por kit. Armazenados como kg-equiv (0.145 kg/un = 2.9 kg/kit)
  // para consistência com o resto do sistema — o frontend faz un = kg / 0.145.
  "Sacos Hermeticos":   { unit: "un", kit1: 2.9,  kit2: 2.9 },
};

/**
 * Lê um ficheiro MAAP e devolve as rows agregadas por extensionista_id:
 *   { id → { kit1, kit2, name, district, location, prov, supervisor, supervisor_phone } }
 */
function parseMAAPFile(filepath, provLabel) {
  if (!fs.existsSync(filepath)) {
    console.warn("[MAAP] ficheiro não existe:", filepath);
    return new Map();
  }
  const wb = XLSX.readFile(filepath);
  // Procura sheet com a coluna "Quantities MAAP" ou "Updated quantities"
  let targetSheet = null;
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    const head = XLSX.utils.sheet_to_json(ws, { defval: "", header: 1, range: 0 })[0] || [];
    const headStr = head.map((h) => String(h || "").trim()).join("|");
    if (/quantities maap|updated quantit/i.test(headStr)) { targetSheet = sn; break; }
  }
  if (!targetSheet) {
    console.warn("[MAAP] não encontrei sheet com 'Quantities MAAP' em", filepath);
    return new Map();
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[targetSheet], { defval: "" });
  const out = new Map();
  // Counter para gerar IDs sintéticos para rows sem Extensionist_ID
  // (extensionistas novos ainda sem ID atribuído).
  let pendingIdx = 0;
  for (const r of rows) {
    let id = String(r["Extensionist_ID"] || "").trim();
    // Override: nomes que sabemos terem o ID errado no Excel.
    // Aplicado ANTES da lógica de pending-id (não trata como sintético).
    const nameRaw = String(r["Extensionist"] || "").trim();
    if (nameRaw && MAAP_NAME_TO_ID_OVERRIDE[nameRaw]) {
      id = MAAP_NAME_TO_ID_OVERRIDE[nameRaw];
    }
    if (!id) {
      // Verifica se row tem dados úteis (qty > 0) — senão skip
      let hasData = false;
      for (const k of Object.keys(r)) {
        if (/quantities maap|updated quantit/i.test(k) && Number(r[k]) > 0) { hasData = true; break; }
      }
      if (!hasData) continue;
      // ID sintético: MAAP-PEND-<prov>-<n>. Preserva os totais e sinaliza
      // que falta atribuição oficial.
      pendingIdx++;
      // ID curto para caber em VARCHAR(16) — ex: "P-TETE-001" (10 chars).
      // Província é abreviada à letra inicial + 3 chars do nome para
      // manter unicidade e legibilidade.
      const provShort = provLabel.toUpperCase().slice(0, 4);
      id = `P-${provShort}-${String(pendingIdx).padStart(3, "0")}`;
    }
    // Coluna pode chamar-se "Quantities MAAP" (com ou sem espaço inicial)
    // ou "Updated quantities" — tratamos ambos casos.
    let qty = 0;
    for (const k of Object.keys(r)) {
      if (/quantities maap|updated quantit/i.test(k)) {
        qty = Number(r[k]) || 0;
        break;
      }
    }
    const kit = String(r["Kit"] || r["KIT"] || "").toUpperCase();
    const isKit1 = /1/.test(kit);
    const isKit2 = /2/.test(kit);

    if (!out.has(id)) {
      out.set(id, {
        kit1: 0, kit2: 0,
        name: String(r["Extensionist"] || "").trim(),
        prov: String(r["Province"] || provLabel).trim() || provLabel,
        district: normalizeDistrict(r["District"]),
        location: String(r["Location"] || "").trim(),
        contact: String(r["Extensionist Contact"] || "").trim(),
        supervisor: String(r["Supervisor"] || "").trim(),
        supervisor_phone: String(r["Supervisor Contact"] || "").trim(),
      });
    }
    const e = out.get(id);
    if (isKit1) e.kit1 += qty;
    else if (isKit2) e.kit2 += qty;
  }
  return out;
}

/**
 * Carrega TODOS os 6 ficheiros e devolve mapa global.
 * Também regista totais por província para diagnóstico.
 */
function loadMAAP(dir = DEFAULT_DIR) {
  const all = new Map();
  const totalsByProv = {};
  let totalKit1 = 0, totalKit2 = 0;

  for (const [prov, fname] of Object.entries(FILES)) {
    const fp = path.join(dir, fname);
    const provMap = parseMAAPFile(fp, prov);
    let k1 = 0, k2 = 0;
    for (const [id, e] of provMap) {
      // Última escrita ganha — útil se o mesmo ext_id aparece em 2 províncias
      // (raro mas possível se houver erro). Em produção esperamos disjunto.
      all.set(id, e);
      k1 += e.kit1;
      k2 += e.kit2;
    }
    totalsByProv[prov] = { kit1: k1, kit2: k2, n_extensionists: provMap.size };
    totalKit1 += k1;
    totalKit2 += k2;
  }

  return {
    extensionists: all,
    totals: { kit1: totalKit1, kit2: totalKit2 },
    by_province: totalsByProv,
  };
}

/**
 * Para um extensionista do MAAP e um produto (label tipo "Milho", "Feijão Vulgar"),
 * devolve a quantidade total que aquele extensionista deve receber:
 *   total = kit1 × recipe.kit1 + kit2 × recipe.kit2
 *
 * Para sacos hermeticos a função NÃO produz output — eles não estão no kit
 * recipe. Vêm via planeamento separado.
 */
function applyKitRecipe(maapEntry, productLabel) {
  const recipe = KIT_RECIPE[productLabel];
  if (!recipe) return null;
  const total = maapEntry.kit1 * recipe.kit1 + maapEntry.kit2 * recipe.kit2;
  return { qty: total, unit: recipe.unit };
}

module.exports = {
  loadMAAP, applyKitRecipe, KIT_RECIPE, FILES, DEFAULT_DIR,
  normalizeDistrict, DISTRICT_ALIASES, MAAP_NAME_TO_ID_OVERRIDE,
};
