/**
 * Agrupa entregas (array de buildEntregas) em VIAGENS (1 viagem = 1 camião
 * num dia para 1 destino com 1 batedor — pode ter múltiplas ADSNs).
 *
 * Mapeamento da vista Excel do operador:
 *   - Header: "CAM-XX <Distrito> <Tonelagem>"
 *   - Sub-header: "ORIGEM: <Fornecedor> TRANSPORTADOR: <Distributer>"
 *   - Linhas: cada extensionista do camião (1 ADSN cada)
 *   - Total: sum de volumes/peso/ton
 *
 * Chave da viagem: matricula + data_saida + batedor (ou destino se sem batedor)
 *
 * CAM-XX = sequencial por distrito, ordenado por data ASC.
 */

/**
 * Normaliza matrícula: remove espaços, slashes finais, uppercase.
 *   "AJT-984 -MP/AJ - 757 - MP" → "AJT-984-MP/AJ-757-MP"
 */
function normPlate(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, "").replace(/\/+$/, "");
}

/**
 * Determina o status agregado de uma viagem:
 *   - "ENTREGUE"     — todos os items FINALIZADO
 *   - "Em trânsito"  — todos TRANSITO
 *   - "Parcial"      — misto FINALIZADO + TRANSITO
 *   - "CRIADO"       — todos ainda no armazém
 */
function aggregateStatus(items) {
  const set = new Set(items.map((i) => String(i.status || "").toUpperCase()));
  if (set.size === 1) {
    const only = [...set][0];
    if (only === "FINALIZADO") return "ENTREGUE";
    if (only === "TRANSITO")   return "Em trânsito";
    return only || "—";
  }
  // Misto
  if (set.has("FINALIZADO") && set.has("TRANSITO")) return "Parcial";
  return "Misto";
}

/**
 * Recebe array de entregas (de buildEntregas) + supervisorMap opcional.
 * Devolve { viagens: [...], summary }.
 *
 * supervisorMap: Map<extensionist_id ou NUIT, supervisor_phone>
 */
function groupByViagem(entregas, supervisorMap = new Map()) {
  const byKey = new Map();

  for (const e of entregas) {
    const dateIso = (e.create_date || "").slice(0, 10);
    // Chave: matricula + data + batedor_email (ou ext_nuit se sem batedor)
    const key = [
      normPlate(e.truck_plate),
      dateIso,
      e.batedor_email || "(sem-batedor)",
    ].join("|");

    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        matricula: e.truck_plate || "",
        matricula_norm: normPlate(e.truck_plate),
        data_saida: dateIso,
        transportador: e.transporter_co || "",
        motorista: e.driver || "",
        batedor: e.batedor_name || e.batedor_email || null,
        batedor_email: e.batedor_email || null,
        batedor_contact: e.batedor_contact || null,
        fornecedor: e.supplier || "",
        origem: e.supplier_origin || "",
        // Destino: usa o do primeiro item (geralmente todos do mesmo destino)
        destino_distrito: e.district || "",
        destino_provincia: e.province || "",
        items: [],
        total_volumes: 0,
        total_kg: 0,
        total_ton: 0,
      });
    }
    const v = byKey.get(key);
    v.items.push(e);
    v.total_volumes += Number(e.volumes) || 0;
    v.total_kg     += Number(e.weight_kg) || 0;
    // Se item tem distrito/provincia mas viagem não tem, copia
    if (!v.destino_distrito && e.district) v.destino_distrito = e.district;
    if (!v.destino_provincia && e.province) v.destino_provincia = e.province;
  }

  // Compute totals + status + supervisor por viagem
  const viagens = [];
  for (const v of byKey.values()) {
    v.total_ton = Number((v.total_kg / 1000).toFixed(3));
    v.status = aggregateStatus(v.items);
    v.n_extensionistas = new Set(v.items.map((i) => i.ext_nuit || i.ext_name)).size;
    v.n_items = v.items.length;
    // Supervisor: pesquisa pelo NUIT do extensionista
    let supervisorPhone = null;
    for (const it of v.items) {
      const nuit = it.ext_nuit;
      if (nuit && supervisorMap.has(nuit)) {
        supervisorPhone = supervisorMap.get(nuit);
        break;
      }
    }
    v.supervisor_phone = supervisorPhone;
    // Ordena items por extensionista (estável)
    v.items.sort((a, b) => String(a.ext_name || "").localeCompare(String(b.ext_name || "")));
    viagens.push(v);
  }

  // Ordena viagens por data desc (mais recente primeiro)
  viagens.sort((a, b) => b.data_saida.localeCompare(a.data_saida));

  // CAM-XX numbering por distrito (ordenado por data ASC dentro de cada distrito)
  // Garante numeração estável: a 1ª viagem para Chibuto é CAM-01, etc.
  const byDistrict = new Map();
  for (const v of viagens) {
    const d = v.destino_distrito || "(sem-distrito)";
    if (!byDistrict.has(d)) byDistrict.set(d, []);
    byDistrict.get(d).push(v);
  }
  for (const [_d, list] of byDistrict) {
    // Ordena por data ASC para numeração estável
    list.sort((a, b) => a.data_saida.localeCompare(b.data_saida));
    list.forEach((v, i) => {
      v.cam_number = i + 1;
      v.cam_label = `CAM-${String(i + 1).padStart(2, "0")}`;
    });
  }

  // Re-ordena viagens por data desc para apresentação
  viagens.sort((a, b) => b.data_saida.localeCompare(a.data_saida));

  // Sumário
  const summary = {
    viagens: viagens.length,
    distritos: byDistrict.size,
    total_kg: viagens.reduce((s, v) => s + v.total_kg, 0),
    total_ton: 0,
    total_items: viagens.reduce((s, v) => s + v.n_items, 0),
    by_status: {},
  };
  summary.total_ton = Number((summary.total_kg / 1000).toFixed(2));
  summary.total_kg = Math.round(summary.total_kg);
  for (const v of viagens) {
    summary.by_status[v.status] = (summary.by_status[v.status] || 0) + 1;
  }

  return { viagens, summary };
}

module.exports = { groupByViagem, normPlate, aggregateStatus };
