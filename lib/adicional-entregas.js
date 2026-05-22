/**
 * Vista unificada de TODAS as entregas: junta dados da API ADICIONAL DMS
 * com submissões dos batedores no Google Sheet (delivery_audit), incluindo
 * identidade real do batedor (nome + contacto da tabela `batedores`).
 *
 * Resultado: 1 linha por serviço (ADSN) com 15+ campos prontos para
 * mostrar numa tabela tipo Excel ou exportar.
 *
 * Match Sheet ↔ API: pela GTU normalizada (via lib/adicional-match).
 */

const { normGtu, qtyMatch, normName } = require("./adicional-match");

// Mapeamento SKU → nome amigável
const SKU_LABEL = {
  MXIXMILHOKG:     "Milho",
  MXIXFEIJAOKG:    "Feijão",
  MXIXARROZKG:     "Arroz",
  AGRIFEMMA01L:    "Emamectim",
  AGRIFEMMA0125L:  "Emamectim",
  AGRIFEMTINL:     "Emamectim",
  AGRIMIDACLORP1L: "Imidacloprid",
  AGRIMIDACLORIPLT:"Imidacloprid",
  AGRIMHMCPA1L:    "MCPA",
  AGRIMHMCPALT:    "MCPA",
  SEEDARROZM50KG:  "Arroz (saco 50kg)",
  MSEEDFJNHB5KG:   "Feijão (saco 5kg)",
  MSEEDOPVZM523:   "Milho (OPV)",
  MMRMINTER25:     "Stocofer",
  SUSSACO:         "Sacos Hermét.",
};
function skuLabel(sku) { return SKU_LABEL[sku] || sku || ""; }

/**
 * Recebe:
 *   - apiRows:      array de serviços da API DMS
 *   - sheetRows:    array do delivery_audit (filtrado por período)
 *   - batedoresMap: Map<email, {name, contact, contact_alt}>
 *   - beneficiariesMap: Map<nuit, {name, contact}> (opcional, para enriquecer extensionista)
 *   - attachmentsByGtu: Map<normGtu, {links: [...], signature: ...}> (opcional —
 *      vindo do cache.data parseado do Google Sheet, contém os URLs dos anexos
 *      que delivery_audit não persiste).
 *
 * Devolve array uniforme de objectos prontos para renderizar.
 */
function buildEntregas({ apiRows = [], sheetRows = [], batedoresMap = new Map(), beneficiariesMap = new Map(), attachmentsByGtu = new Map() }) {
  // Index sheet por GTU normalizada
  const sheetByGtu = new Map();
  for (const r of sheetRows) {
    const gtu = normGtu(r.gtu || r.delivery_note_number);
    if (!gtu) continue;
    if (!sheetByGtu.has(gtu)) sheetByGtu.set(gtu, []);
    sheetByGtu.get(gtu).push(r);
  }

  const entregas = apiRows.map((s) => {
    const gtu = normGtu(s.ClientBarCode);
    const matched = gtu ? (sheetByGtu.get(gtu) || []) : [];
    // Se há match, usa o batedor da 1ª submissão (tipicamente só 1 por GTU)
    let batedorEmail = null, batedorName = null, batedorContact = null;
    if (matched.length > 0) {
      batedorEmail = matched[0].submitted_by || null;
      if (batedorEmail) {
        const b = batedoresMap.get(String(batedorEmail).toLowerCase());
        if (b) {
          batedorName = b.name || null;
          batedorContact = b.contact || null;
        }
      }
    }

    // Extensionista: usa ReceiverName direto. Se houver beneficiariesMap
    // por NUIT, enriquece com contacto.
    const extName = String(s.ReceiverName || "").trim();
    const extNuit = String(s.ReceiverCode || "").trim();
    let extContact = null;
    if (extNuit && beneficiariesMap.has(extNuit)) {
      extContact = beneficiariesMap.get(extNuit).contact || null;
    }
    // Fallback: às vezes o telefone vem no ReceiverContactPhone da API
    if (!extContact && s.ReceiverContactPhone) extContact = String(s.ReceiverContactPhone).trim();

    // Comparação de quantidade entre API e Sheet UNOPS.
    // Tolerância: ±2% (ou ±1 kg para valores < 5 kg) — vem de adicional-match.qtyMatch.
    const apiKg   = Number(s.Weight) || 0;
    const sheetKg = matched[0]?.delivered_qty != null ? Number(matched[0].delivered_qty) : null;
    let qty_match = null, qty_diff_kg = null, qty_pct_diff = null;
    if (matched.length > 0 && sheetKg != null) {
      qty_match    = qtyMatch(apiKg, sheetKg);
      qty_diff_kg  = Number((sheetKg - apiKg).toFixed(2));
      qty_pct_diff = apiKg > 0
        ? Number(((sheetKg - apiKg) / apiKg * 100).toFixed(1))
        : null;
    }

    // Comparação de NOME entre API.ReceiverName e Sheet.beneficiary_name.
    // Match: exacto OU substring nas duas direcções (cobre "Nuro Cardoso" vs
    // "Nuro Cardoso Mucavele"). Se há sheet match mas nome diverge, é
    // possível que tenham lançado a GTU certa no extensionista errado.
    const sheetName = String(matched[0]?.beneficiary_name || "").trim();
    let name_match = null, sheet_name = null;
    if (matched.length > 0 && sheetName) {
      sheet_name = sheetName;
      const apiN   = normName(extName);
      const sheetN = normName(sheetName);
      name_match = apiN === sheetN
        || (apiN && sheetN && (apiN.includes(sheetN) || sheetN.includes(apiN)));
    }

    return {
      // Identificação
      service_id:     s.ServiceID,
      adsn:           s.ServiceCode || "",
      adse:           s.ParentServiceCode || "",
      gtu:            s.ClientBarCode || "",
      // Data + Status
      create_date:    s.CreateDate || "",
      delivery_date:  matched[0]?.delivery_date_iso || null,
      status:         s.StatusName || "",
      // Logística
      truck_plate:    String(s.VehiclePlate || "").replace(/\/+$/, ""),  // remove trailing slashes
      transporter_co: String(s.DistributerName || "").trim(),
      driver:         String(s.Transporter || "").trim(),
      // Batedor (do sheet/AppSheet)
      batedor_email:   batedorEmail,
      batedor_name:    batedorName,
      batedor_contact: batedorContact,
      sheet_matched:   matched.length > 0,
      // Origem
      supplier:        String(s.ShipFromName || "").trim(),
      supplier_origin: String(s.ShipFromAddress || "").trim(),
      // Produto
      sku:             s.SKU || "",
      product:         skuLabel(s.SKU),
      weight_kg:       apiKg,
      weight_ton:      Number((apiKg / 1000).toFixed(2)),
      volumes:         Number(s.VolumesQty) || 0,
      // Destinatário
      ext_nuit:    extNuit,
      ext_name:    extName,
      ext_contact: extContact,
      district:    String(s.ReceiverPostalPlace || "").trim(),
      province:    String(s.ReceiverAddress || "").trim(),
      // Quantity submetida no Sheet (pode diferir do API.Weight)
      sheet_qty_kg: sheetKg,
      // Match de quantidade: null se não há sheet, true se ±2% / false se diverge
      qty_match,       // true | false | null
      qty_diff_kg,     // sheet − api (positivo = sheet declara MAIS)
      qty_pct_diff,    // (sheet − api) / api × 100
      // Match de nome: null se não há sheet, true se nomes batem (exact ou
      // substring), false se diferem — possível submissão no benef. errado
      name_match,
      sheet_beneficiary_name: sheet_name,
      // Anexos: URLs dos PDFs/fotos da guia (delivery_note_link*) e assinatura
      // do beneficiário. Vêm do cache.data parseado do Google Sheet via
      // attachmentsByGtu (delivery_audit não os persiste).
      attachments:           gtu ? (attachmentsByGtu.get(gtu)?.links     || []) : [],
      beneficiary_signature: gtu ? (attachmentsByGtu.get(gtu)?.signature || null) : null,
    };
  });

  return entregas;
}

module.exports = { buildEntregas, skuLabel };
