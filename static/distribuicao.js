/* ── Distribuição (saldo + criar serviço) ──────────────────── */
(function () {
  const { fetchJSON, fmt, esc, sortRows, sortArrow, bindSortable,
          exportCSV, urlState, renderFilterChips } = window.AdminUI;

  // State
  let geo = {};                        // { province: { district: count } }
  let allRows = [];                    // current balance rows
  let selectedKeys = new Set();        // `${ext_id}|${sku}` of rows the user picked
  let truckCapacity = 30000;            // default 30T

  // Definição das colunas para sort
  const BAL_COLS = [
    { key: null,                 label: "",                   sortable: false },
    { key: "extensionist_id",    label: "ID",                 sortable: true,  type: "string" },
    { key: "beneficiary_name",   label: "Beneficiário",       sortable: true,  type: "string" },
    { key: "district",           label: "Distrito",           sortable: true,  type: "string" },
    { key: "product_name",       label: "Produto",            sortable: true,  type: "string" },
    { key: "planned_original",   label: "Plano Original",     sortable: true,  type: "number", numCol: true, title: "Quantidade originalmente planeada (NOVA QUANTIDADE A ENTREGAR)" },
    { key: "realocado_recebido", label: "Realoc. Recebido",   sortable: true,  type: "number", numCol: true, title: "Quantidade recebida via realocação de outro beneficiário" },
    { key: "planned_qty",        label: "Plano Ajustado",     sortable: true,  type: "number", numCol: true, title: "Plano após subtrair Realocado Recebido" },
    { key: "committed_qty",      label: "Entregue",           sortable: true,  type: "number", numCol: true, title: "Já entregue (TRANSITO + FINALIZADO no sistema externo)" },
    { key: "available_qty",      label: "Falta",              sortable: true,  type: "number", numCol: true, title: "Falta entregar = max(0, Plano Ajustado − Entregue)" },
    { key: "_pct",               label: "%",                  sortable: true,  type: "number", numCol: true },
  ];
  const balSort = { sortKey: "available_qty", sortAsc: false, render: () => renderRows() };

  // Helpers
  function $(s) { return document.querySelector(s); }
  function $$(s) { return [...document.querySelectorAll(s)]; }
  function rowKey(r) { return `${r.extensionist_id}|${r.sku}`; }
  function fmtKg(n) { return fmt(n) + " kg"; }
  function fmtL(n)  { return fmt(n) + " L"; }
  function fmtUn(n) { return fmt(n) + " un"; }
  function fmtUnit(qty, unit) {
    if (unit === "L")  return fmtL(qty);
    if (unit === "un") return fmtUn(qty);
    return fmtKg(qty);
  }

  // ── Filters ─────────────────────────────────────────────────
  async function loadGeo() {
    geo = await fetchJSON("/admin/api/distribution/geography");
    const sel = $("#f-province");
    const provinces = Object.keys(geo).sort();
    sel.innerHTML = ['<option value="">— Todas —</option>']
      .concat(provinces.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`))
      .join("");
  }

  function loadDistrictOptions() {
    const prov = $("#f-province").value;
    const sel = $("#f-district");
    if (!prov || !geo[prov]) {
      sel.innerHTML = '<option value="">— Escolhe província —</option>';
      return;
    }
    const districts = Object.keys(geo[prov]).sort();
    sel.innerHTML = ['<option value="">— Todos —</option>']
      .concat(districts.map((d) => `<option value="${esc(d)}">${esc(d)} (${geo[prov][d]})</option>`))
      .join("");
  }

  // ── Summary ────────────────────────────────────────────────
  // Quando há filtro por SKU, todos os cards passam a mostrar a unidade
  // desse SKU (kg/L/un). Sem filtro, agrega tudo e mostra kg como "principal"
  // + L/un como complemento (consistente com o que se vê no /admin/distribuicao
  // sem filtro).
  async function loadSummary() {
    const province = $("#f-province").value;
    const district = $("#f-district").value;
    const sku = $("#f-sku").value;
    const params = new URLSearchParams();
    if (province) params.set("province", province);
    if (district) params.set("district", district);
    if (sku)      params.set("sku", sku);
    const data = await fetchJSON("/admin/api/distribution/summary?" + params);

    const kg = data.kg || {};
    const L  = data.L  || {};
    const un = data.un || {};

    // Beneficiários com saldo > 0 / total
    const totalBenef = data.beneficiaries_total || 0;
    const withSaldo  = data.beneficiaries || 0;
    if (totalBenef && withSaldo !== totalBenef) {
      $("#s-benef").textContent = fmt(withSaldo);
      $("#s-benef-sub").textContent = "de " + fmt(totalBenef) + " no plano";
    } else {
      $("#s-benef").textContent = fmt(withSaldo);
      $("#s-benef-sub").textContent = "com saldo > 0";
    }

    // Quando filtrado por SKU, a unidade vem implícita pelo SKU.
    // Determina a unidade dominante (a com 'rows > 0').
    const units = [
      ["kg", kg], ["L", L], ["un", un],
    ].filter(([, v]) => v.rows > 0);

    if (sku) {
      // Filtro por SKU → usa só a unidade dessa categoria.
      const [unit, v] = units[0] || ["kg", { planned: 0, committed: 0, available: 0 }];
      const fmtU = unit === "L" ? fmtL : unit === "un" ? fmtUn : fmtKg;
      $("#s-planned-label").textContent = "Plano (" + unit + ")";
      $("#s-delivered-label").textContent = "Entregue (" + unit + ")";
      $("#s-available-label").textContent = "Falta (" + unit + ")";
      $("#s-planned").textContent   = fmtU(v.planned   || 0);
      $("#s-delivered").textContent = fmtU(v.committed || 0);
      $("#s-available").textContent = fmtU(v.available || 0);
      const pct = v.planned > 0 ? ((v.committed / v.planned) * 100).toFixed(1) + "%" : "—";
      $("#s-delivered-pct").textContent = "Taxa: " + pct;
      // Sub-rows (planeamento original, realocado) em vez do "outros un"
      const realocText = v.realocado_recebido > 0 ? "Realoc. recebido: " + fmtU(v.realocado_recebido) : "";
      $("#s-planned-other").textContent = v.planned_original
        ? "Original: " + fmtU(v.planned_original) + (realocText ? "  •  " + realocText : "")
        : "—";
      $("#s-available-other").textContent = "—";
    } else {
      // Sem filtro SKU — modo agregado (kg principal, L/un secundários).
      $("#s-planned-label").textContent = "Plano (kg)";
      $("#s-delivered-label").textContent = "Entregue (kg)";
      $("#s-available-label").textContent = "Falta (kg)";
      $("#s-planned").textContent   = fmtKg(kg.planned   || 0);
      $("#s-delivered").textContent = fmtKg(kg.committed || 0);
      $("#s-available").textContent = fmtKg(kg.available || 0);
      const pct = kg.planned > 0 ? ((kg.committed / kg.planned) * 100).toFixed(1) + "%" : "—";
      $("#s-delivered-pct").textContent = "Taxa: " + pct;
      $("#s-planned-other").textContent =
        [(L.planned   ? fmtL(L.planned) : null), (un.planned   ? fmtUn(un.planned)   : null)].filter(Boolean).join("  •  ") || "—";
      $("#s-available-other").textContent =
        [(L.available ? fmtL(L.available) : null), (un.available ? fmtUn(un.available) : null)].filter(Boolean).join("  •  ") || "—";
    }
  }

  // ── Balance table ──────────────────────────────────────────
  async function loadBalances() {
    const province = $("#f-province").value;
    const district = $("#f-district").value;
    const sku = $("#f-sku").value;
    const params = new URLSearchParams({ only_available: "1" });
    if (province) params.set("province", province);
    if (district) params.set("district", district);
    if (sku)      params.set("sku", sku);
    const data = await fetchJSON("/admin/api/distribution/balances?" + params);
    allRows = data.rows || [];

    // SKU dropdown options derived from full data set
    if (!sku) populateSkuOptions(allRows);

    // Drop selections that no longer exist
    selectedKeys = new Set([...selectedKeys].filter((k) => allRows.find((r) => rowKey(r) === k)));

    renderRows();
    updateCapBar();
  }

  function populateSkuOptions(rows) {
    // Agrupa por nome amigável (Feijão, Milho, Arroz, Sacos Hermeticos, etc.)
    // — esconde o código SKU técnico do operador.
    const set = new Map();
    rows.forEach((r) => {
      if (!set.has(r.sku)) set.set(r.sku, r.product_name || r.sku);
    });
    const cur = $("#f-sku").value;
    const opts = ['<option value="">Todos os produtos</option>']
      .concat([...set.entries()].sort((a, b) => a[1].localeCompare(b[1], "pt"))
        .map(([sku, name]) => `<option value="${esc(sku)}"${sku === cur ? " selected" : ""}>${esc(name)}</option>`))
      .join("");
    $("#f-sku").innerHTML = opts;
  }

  function renderHeader() {
    const head = $("#bal-thead-row");
    head.innerHTML = BAL_COLS.map((c) => {
      const cls = c.numCol ? "num" : (c.key === null ? "check-col" : "");
      if (!c.sortable) {
        return `<th class="${cls}">${c.key === null ? '<input type="checkbox" id="check-all" class="check-input" title="Selecc. todos">' : esc(c.label)}</th>`;
      }
      const titleAttr = c.title ? ` title="${esc(c.title)}"` : "";
      return `<th class="${cls}" data-sort="${c.key}" data-sort-type="${c.type}"${titleAttr}>${esc(c.label)}${sortArrow(c.key, balSort.sortKey, balSort.sortAsc)}</th>`;
    }).join("");
    bindSortable($("#bal-table"), balSort);
  }

  function renderRows() {
    renderHeader();
    const body = $("#bal-body");
    if (!allRows.length) {
      body.innerHTML = `<tr><td colspan="${BAL_COLS.length}"><div class="empty-state">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:.4rem"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <div>Nada a entregar nesta selecção. Tudo cumprido.</div>
      </div></td></tr>`;
      $("#row-count").textContent = "0 itens";
      return;
    }
    // Inject _pct field para ordenação
    allRows.forEach((r) => {
      const planned = Number(r.planned_qty) || 0;
      const committed = Number(r.committed_qty) || 0;
      r._pct = planned > 0 ? Math.round((committed / planned) * 100) : 0;
    });
    const col = BAL_COLS.find((c) => c.key === balSort.sortKey);
    const sorted = sortRows(allRows, balSort.sortKey, balSort.sortAsc, col?.type);
    body.innerHTML = sorted.map((r) => {
      const k = rowKey(r);
      const sel = selectedKeys.has(k);
      const plannedOrig = Number(r.planned_original) || 0;
      const realoc = Number(r.realocado_recebido) || 0;
      const planned = Number(r.planned_qty) || 0;       // = original − realoc
      const committed = Number(r.committed_qty) || 0;
      const available = Number(r.available_qty) || 0;
      // % entregue/cumprido em relação ao plano ajustado
      const pct = planned > 0 ? Math.round((committed / planned) * 100) : 0;
      const pctClass = pct >= 100 ? "pct-high" : pct >= 50 ? "pct-mid" : "pct-0";
      const realocCell = realoc > 0
        ? `<span style="color:#7c3aed;font-weight:700" title="Recebeu ${fmtUnit(realoc, r.unit)} via realocação">${fmtUnit(realoc, r.unit)}</span>`
        : '<span style="color:#cbd5e1">—</span>';
      return `<tr class="${sel ? "selected" : ""}" data-key="${esc(k)}">
        <td class="check-col"><input type="checkbox" class="check-input row-check" ${sel ? "checked" : ""}></td>
        <td><code style="font-size:.7rem">${esc(r.extensionist_id)}</code></td>
        <td>${esc(r.beneficiary_name)}</td>
        <td>${esc(r.district || "")}</td>
        <td>${esc(r.product_name)} <span style="color:#94a3b8;font-size:.7rem">(${esc(r.sku)})</span></td>
        <td class="num" style="color:#64748b">${fmtUnit(plannedOrig, r.unit)}</td>
        <td class="num">${realocCell}</td>
        <td class="num" style="font-weight:700">${fmtUnit(planned, r.unit)}</td>
        <td class="num" style="color:#16a34a">${fmtUnit(committed, r.unit)}</td>
        <td class="num" style="color:#dc2626;font-weight:700">${fmtUnit(available, r.unit)}</td>
        <td class="num"><span class="pct ${pctClass}">${pct}%</span></td>
      </tr>`;
    }).join("");
    $("#row-count").textContent = allRows.length + " itens";

    // Bind row clicks
    $$("#bal-body tr[data-key]").forEach((tr) => {
      const cb = tr.querySelector(".row-check");
      tr.addEventListener("click", (e) => {
        if (e.target === cb) return; // checkbox click handles itself
        cb.checked = !cb.checked;
        toggleRow(tr.dataset.key, cb.checked);
      });
      cb.addEventListener("click", (e) => { e.stopPropagation(); toggleRow(tr.dataset.key, cb.checked); });
    });
    // "Check all" toggle
    const cAll = $("#check-all");
    cAll.checked = allRows.length > 0 && allRows.every((r) => selectedKeys.has(rowKey(r)));
    cAll.onclick = () => {
      if (cAll.checked) allRows.forEach((r) => selectedKeys.add(rowKey(r)));
      else selectedKeys.clear();
      renderRows();
      updateCapBar();
    };
  }

  function toggleRow(k, on) {
    if (on) selectedKeys.add(k);
    else    selectedKeys.delete(k);
    const tr = $(`#bal-body tr[data-key="${k.replace(/"/g, '\\"')}"]`);
    if (tr) tr.classList.toggle("selected", on);
    updateCapBar();
  }

  // ── Capacity bar ───────────────────────────────────────────
  function selectedRows() {
    return allRows.filter((r) => selectedKeys.has(rowKey(r)));
  }
  function selectedKgEquiv() {
    // For capacity, we treat L and un as kg-equivalent only crudely:
    // sementes (kg) count as kg, químicos (L) count as kg (1L≈1kg approx),
    // sacos (un) count as 0.3 kg/un. This is a UI-only estimate.
    return selectedRows().reduce((s, r) => {
      const q = Number(r.available_qty) || 0;
      if (r.unit === "un") return s + q * 0.3;
      return s + q; // kg ou L
    }, 0);
  }
  function updateCapBar() {
    const sel = selectedRows();
    const kg = selectedKgEquiv();
    const pct = Math.min(100, Math.round((kg / truckCapacity) * 100));
    $("#cap-fill").style.width = pct + "%";
    $("#cap-text").textContent = `${fmt(kg)} / ${fmt(truckCapacity)} kg • ${sel.length} itens`;
    $("#btn-create").disabled = !sel.length;
    $("#btn-create").style.background = kg > truckCapacity ? "#dc2626" : "";
  }

  // ── Auto-fill (greedy first-fit decreasing on available kg) ─
  function autoFill() {
    selectedKeys.clear();
    // Score & sort by available_qty descending; pick largest that fits
    const candidates = [...allRows]
      .map((r) => ({
        key: rowKey(r),
        weight: r.unit === "un" ? Number(r.available_qty) * 0.3 : Number(r.available_qty),
      }))
      .filter((c) => c.weight > 0)
      .sort((a, b) => b.weight - a.weight);
    let remaining = truckCapacity;
    for (const c of candidates) {
      if (c.weight <= remaining) {
        selectedKeys.add(c.key);
        remaining -= c.weight;
      }
      if (remaining < 100) break;
    }
    renderRows();
    updateCapBar();
  }

  // ── Modal: create service ──────────────────────────────────
  function openCreateModal() {
    const sel = selectedRows();
    if (!sel.length) return;
    const totalKg = selectedKgEquiv();
    const districts = new Set(sel.map((r) => r.district).filter(Boolean));
    const provinces = new Set(sel.map((r) => r.province).filter(Boolean));
    if (districts.size > 1 || provinces.size > 1) {
      alert("Selecciona apenas beneficiários do mesmo distrito para um serviço.");
      return;
    }
    const beneficiaries = new Set(sel.map((r) => r.extensionist_id));

    $("#modal-summary").innerHTML = `
      <strong>Distrito:</strong> ${esc([...provinces][0] || "—")} › ${esc([...districts][0] || "—")}<br>
      <strong>Total carregado:</strong> ${fmt(totalKg)} kg <span style="color:${totalKg > truckCapacity ? "#dc2626" : "#16a34a"}">(${Math.round((totalKg/truckCapacity)*100)}% do camião)</span><br>
      <strong>${beneficiaries.size}</strong> beneficiários • <strong>${sel.length}</strong> linhas (produto×pessoa)
    `;
    $("#m-capacity").value = fmt(truckCapacity) + " kg";
    $("#m-origem").value = sel[0]?.origem_supplier || "";
    $("#m-plate").value = "";
    $("#m-plate-2").value = "";
    $("#m-driver").value = "";
    $("#m-phone").value = "";
    $("#m-notes").value = "";
    $("#modal-err").classList.remove("show");
    $("#create-modal").classList.add("show");
    $("#m-plate").focus();
  }
  function closeCreateModal() { $("#create-modal").classList.remove("show"); }

  async function submitCreate(putInTransit) {
    const sel = selectedRows();
    if (!sel.length) return;
    const plate = $("#m-plate").value.trim();
    const driver = $("#m-driver").value.trim();
    const errBox = $("#modal-err");
    errBox.classList.remove("show");

    if (!plate) { errBox.textContent = "Matrícula é obrigatória"; errBox.classList.add("show"); return; }
    if (!driver) { errBox.textContent = "Nome do motorista é obrigatório"; errBox.classList.add("show"); return; }

    const province = sel[0].province;
    const district = sel[0].district;
    const items = sel.map((r) => ({
      extensionist_id: r.extensionist_id,
      sku: r.sku,
      qty: Number(r.available_qty),
    }));
    const body = {
      province, district,
      truck_capacity_kg: truckCapacity,
      truck_plate: plate,
      truck_plate_2: $("#m-plate-2").value.trim() || null,
      driver_name: driver,
      driver_phone: $("#m-phone").value.trim() || null,
      origem_supplier: $("#m-origem").value.trim() || null,
      notes: $("#m-notes").value.trim() || null,
      items,
    };

    try {
      const result = await fetchJSON("/admin/api/distribution/services", { method: "POST", body });
      if (result.error) {
        let msg = result.error;
        if (result.insufficient) {
          msg += "<br>" + result.insufficient.slice(0, 5)
            .map((x) => `• ${esc(x.beneficiary_name || x.extensionist_id)} / ${esc(x.product_name || x.sku)}: pediu ${fmt(x.requested)}, disponível ${fmt(x.available_qty)}`)
            .join("<br>");
          if (result.insufficient.length > 5) msg += "<br>...e mais " + (result.insufficient.length - 5);
        }
        errBox.innerHTML = msg; errBox.classList.add("show"); return;
      }

      // Optionally put in transit immediately
      if (putInTransit) {
        await fetchJSON(`/admin/api/distribution/services/${result.service_id}/in-transit`, {
          method: "POST",
          body: { truck_plate: plate, driver_name: driver, driver_phone: $("#m-phone").value.trim() || null },
        });
      }

      closeCreateModal();
      selectedKeys.clear();
      await Promise.all([loadBalances(), loadSummary()]);
      // Toast-like alert
      alert(`Serviço ${result.service_number} criado (${fmt(result.total_kg)} kg)${putInTransit ? " e em trânsito" : ""}.\nVer em /admin/servicos.`);
    } catch (e) {
      errBox.textContent = "Erro: " + e.message; errBox.classList.add("show");
    }
  }

  // ── URL state + filter chips + CSV export (Fase 6) ─────────
  const urlSync = urlState({
    "f-province": "province",
    "f-district": "district",
    "f-sku":      "sku",
  }, { onPopState: () => refresh() });

  function renderChips() {
    const province = $("#f-province").value;
    const district = $("#f-district").value;
    const skuValue = $("#f-sku").value;
    const skuOption = skuValue ? document.querySelector(`#f-sku option[value="${skuValue}"]`) : null;
    const productLabel = skuOption ? skuOption.textContent.trim() : skuValue;
    renderFilterChips($("#dist-filter-chips"), [
      { key: "f-province", label: "Província", value: province },
      { key: "f-district", label: "Distrito",  value: district },
      { key: "f-sku",      label: "Produto",   value: productLabel },
    ], (key) => {
      if (key === "__all__") {
        $("#f-province").value = "";
        $("#f-district").value = "";
        $("#f-sku").value = "";
        loadDistrictOptions();
      } else {
        $("#" + key).value = "";
        if (key === "f-province") loadDistrictOptions();
      }
      refresh();
    });
  }

  function doExportCSV() {
    const sorted = (() => {
      const col = BAL_COLS.find((c) => c.key === balSort.sortKey);
      return sortRows(allRows, balSort.sortKey, balSort.sortAsc, col?.type);
    })();
    const rows = selectedKeys.size > 0
      ? sorted.filter((r) => selectedKeys.has(rowKey(r)))
      : sorted;
    exportCSV(rows, {
      filename: "saldos",
      columns: [
        { key: "extensionist_id",    label: "Extens. ID" },
        { key: "beneficiary_name",   label: "Beneficiário" },
        { key: "province",           label: "Província" },
        { key: "district",           label: "Distrito" },
        { key: "product_name",       label: "Produto" },
        { key: "unit",               label: "Unidade" },
        { key: "planned_original",   label: "Plano Original" },
        { key: "realocado_recebido", label: "Realoc. Recebido" },
        { key: "planned_qty",        label: "Plano Ajustado" },
        { key: "committed_qty",      label: "Entregue" },
        { key: "available_qty",      label: "Falta" },
      ],
    });
  }

  // ── Init ───────────────────────────────────────────────────
  async function refresh() {
    urlSync.write();
    renderChips();
    await Promise.all([loadSummary(), loadBalances()]);
    // Toggle bootstrap panel based on whether geography returned anything
    const hasData = Object.keys(geo).length > 0;
    const panel = document.getElementById("bootstrap-panel");
    if (panel) panel.style.display = hasData ? "none" : "block";
  }

  // ── Bootstrap (first-run) ──────────────────────────────────
  async function uploadExcel(endpoint, fileInput, resultEl, btn) {
    if (!fileInput.files[0]) {
      resultEl.innerHTML = '<span style="color:#dc2626">Escolha um ficheiro</span>';
      return;
    }
    btn.disabled = true;
    btn.textContent = "A importar...";
    resultEl.textContent = "";
    try {
      const fd = new FormData();
      fd.append("file", fileInput.files[0]);
      const res = await fetch(endpoint, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      resultEl.innerHTML = '<div style="background:#dcfce7;color:#166534;padding:.5rem;border-radius:6px"><strong>Importado com sucesso:</strong><br>' +
        Object.entries(data).map(([k, v]) => `${k} = ${typeof v === "object" ? JSON.stringify(v) : v}`).join("<br>") + "</div>";
      await loadGeo();
      await refresh();
    } catch (e) {
      resultEl.innerHTML = `<span style="color:#dc2626">Erro: ${e.message}</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = btn.id === "bs-planning-btn" ? "Importar Planeamento" : "Importar Serviços";
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    // Capacity buttons
    $$(".cap-btn").forEach((b) => b.addEventListener("click", () => {
      $$(".cap-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      truckCapacity = Number(b.dataset.cap);
      updateCapBar();
    }));
    // Filter changes — SKU change actualiza tanto a tabela como os cards
    $("#f-province").addEventListener("change", () => { loadDistrictOptions(); refresh(); });
    $("#f-district").addEventListener("change", refresh);
    $("#f-sku").addEventListener("change", refresh);
    $("#btn-refresh").addEventListener("click", refresh);

    // Truck panel actions
    $("#btn-autofill").addEventListener("click", autoFill);
    $("#btn-clear-sel").addEventListener("click", () => {
      selectedKeys.clear(); renderRows(); updateCapBar();
    });
    $("#btn-create").addEventListener("click", openCreateModal);

    // Modal events
    $("#m-cancel").addEventListener("click", closeCreateModal);
    $("#m-confirm").addEventListener("click", () => submitCreate(false));
    $("#m-confirm-transit").addEventListener("click", () => submitCreate(true));
    $("#create-modal").addEventListener("click", (e) => {
      if (e.target.id === "create-modal") closeCreateModal();
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "1") clickCap("1000");
      if (e.key === "2") clickCap("2000");
      if (e.key === "3") clickCap("5000");
      if (e.key === "4") clickCap("10000");
      if (e.key === "5") clickCap("15000");
      if (e.key === "6") clickCap("30000");
      if (e.key.toLowerCase() === "a") $("#btn-autofill").click();
      if (e.key.toLowerCase() === "c") $("#btn-clear-sel").click();
      if (e.key === "Enter" && !$("#create-modal").classList.contains("show")) {
        if (!$("#btn-create").disabled) $("#btn-create").click();
      }
      if (e.key === "Escape" && $("#create-modal").classList.contains("show")) closeCreateModal();
    });
    function clickCap(cap) { const b = $(`.cap-btn[data-cap="${cap}"]`); if (b) b.click(); }

    // CSV export
    $("#btn-export-csv").addEventListener("click", doExportCSV);

    // Bootstrap upload buttons
    const bsPlanBtn = $("#bs-planning-btn");
    if (bsPlanBtn) bsPlanBtn.addEventListener("click", () =>
      uploadExcel("/admin/api/distribution/bootstrap/planning",
        $("#bs-planning-file"), $("#bs-planning-result"), bsPlanBtn));
    const bsSvcBtn = $("#bs-services-btn");
    if (bsSvcBtn) bsSvcBtn.addEventListener("click", () =>
      uploadExcel("/admin/api/distribution/bootstrap/services",
        $("#bs-services-file"), $("#bs-services-result"), bsSvcBtn));

    await loadGeo();
    // Restore filtros do URL APÓS geo carregar (precisamos das províncias)
    urlSync.read();
    loadDistrictOptions();
    urlSync.read(); // re-read porque distrito só agora está no DOM
    await refresh();
  });
})();
