/* ── AQI Delivery Dashboard – Frontend Logic ──────────────── */

(function () {
  "use strict";

  const REFRESH_INTERVAL = 5 * 60; // 5 minutes in seconds
  const PAGE_SIZE = 20;
  // Saco hermético: 0.145 kg cada. Mantém alinhado com app.js parseCSV
  // (que armazena delivered_qty já em kg = units × SACO_KG_PER_UNIT para sacos).
  const SACO_KG_PER_UNIT = 0.145;

  let allRows = [];
  let filteredRows = [];
  let currentPage = 1;
  let sortCol = "delivery_date_iso";
  let sortAsc = false;
  let countdown = REFRESH_INTERVAL;
  let countdownTimer = null;
  let historyMode = false; // true when viewing a snapshot

  // Chart instances
  let chartDistrict = null;
  let chartTimeline = null;

  // ── Column definitions ──────────────────────────────────────
  const ALL_COLUMNS = [
    { key: "delivery_id",          label: "ID",                  defaultOn: false, type: "text",   truncate: 8 },
    { key: "adsn",                 label: "ADSN",                defaultOn: true,  type: "text"   },
    { key: "delivery_note_number", label: "GTU",                 defaultOn: true,  type: "text"   },
    { key: "beneficiary_name",     label: "Beneficiario",        defaultOn: true,  type: "text"   },
    { key: "supplier",             label: "Fornecedor",          defaultOn: false, type: "text"   },
    { key: "province",             label: "Provincia",           defaultOn: true,  type: "text"   },
    { key: "district",             label: "Distrito",            defaultOn: true,  type: "text"   },
    { key: "beneficiary_id",       label: "Benef. ID",           defaultOn: false, type: "text"   },
    { key: "product",              label: "Produto",             defaultOn: true,  type: "text"   },
    { key: "product_unit",         label: "Unidade",             defaultOn: false, type: "text"   },
    { key: "delivered_qty",        label: "Qtd. Entregue",       defaultOn: true,  type: "number" },
    { key: "packages",             label: "Pacotes",             defaultOn: false, type: "number" },
    { key: "delivery_date",        label: "Data Entrega",        defaultOn: true,  type: "date",  sortKey: "delivery_date_iso" },
    { key: "submission_date",      label: "Data Submissao",      defaultOn: false, type: "date",  sortKey: "submission_date_iso" },
    { key: "submitted_by",         label: "Submetido por",       defaultOn: true,  type: "text"   },
    { key: "verification_status",  label: "Estado",              defaultOn: true,  type: "badge"  },
    { key: "delivery_notes_view",  label: "Nota Entrega",        defaultOn: true,  type: "notes"  },
    { key: "phone",                label: "Telefone",            defaultOn: false, type: "text"   },
    { key: "phone_alt",            label: "Tel. Alternativo",    defaultOn: false, type: "text"   },
    { key: "is_locked",            label: "Bloqueado",           defaultOn: false, type: "text"   },
    { key: "delivery_note_link",   label: "Nota Entrega Link",   defaultOn: false, type: "text"   },
    { key: "delivery_note_link2",  label: "Nota Entrega Link2",  defaultOn: false, type: "text"   },
    { key: "delivery_note_link3",  label: "Nota Entrega Link3",  defaultOn: false, type: "text"   },
    { key: "beneficiary_signature",label: "Assinatura",          defaultOn: false, type: "text"   },
  ];

  let visibleCols = ALL_COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);

  function getDefaultCols() {
    return ALL_COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);
  }

  function getColDef(key) {
    return ALL_COLUMNS.find((c) => c.key === key);
  }

  // ── DOM refs ────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const elLastUpdated = $("#last-updated");
  const elCountdown = $("#countdown");
  const elTableBody = $("#table-body");
  const elPagination = $("#pagination");
  const fProvince = $("#f-province");
  const fDistrict = $("#f-district");
  const fStatus = $("#f-status");
  const fSupplier = $("#f-supplier");
  const fProduct = $("#f-product");
  const fSearch = $("#f-search");

  // ── Data fetching ───────────────────────────────────────────
  async function fetchData(forceRefresh) {
    showLoading(true);
    try {
      const url = forceRefresh ? "/api/refresh" : "/api/data";
      const opts = forceRefresh ? { method: "POST" } : {};
      const res = await fetch(url, opts);
      const json = await res.json();
      allRows = json.rows || [];
      if (json.last_updated) {
        const d = new Date(json.last_updated);
        elLastUpdated.textContent = "Actualizado: " + d.toLocaleString("pt-PT");
      }
      populateFilters();
      applyFilters();
      resetCountdown();
    } catch (e) {
      console.error("Fetch error:", e);
    } finally {
      showLoading(false);
    }
  }

  function showLoading(show) {
    let el = $(".loading-overlay");
    if (show && !el) {
      el = document.createElement("div");
      el.className = "loading-overlay";
      el.innerHTML = '<div class="spinner"></div>';
      document.body.appendChild(el);
    } else if (!show && el) {
      el.remove();
    }
  }

  // ── Countdown ───────────────────────────────────────────────
  function resetCountdown() {
    countdown = REFRESH_INTERVAL;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      if (historyMode) return;
      countdown--;
      if (countdown <= 0) {
        fetchData(true).then(() => {
          // Only run operational checks on /operations/dashboard. On the
          // public home, refreshing should NOT pop the GTU/weight section.
          if (!IS_PUBLIC) runVerification();
          loadSnapshotList();
        });
        return;
      }
      const m = Math.floor(countdown / 60);
      const s = countdown % 60;
      elCountdown.textContent =
        "Próxima actualização em " + m + ":" + String(s).padStart(2, "0");
    }, 1000);
  }

  // ── Filters ─────────────────────────────────────────────────
  // Planning geography (provinces + districts)
  let planGeo = { provinces: [], districtsByProvince: {} };

  // Default = UPDATED plan on "/" and "/operations/dashboard".
  // The legacy/old plan is only used on "/anterior".
  const IS_OLD = location.pathname === "/anterior" || location.pathname.startsWith("/anterior/");
  const IS_UPDATED = !IS_OLD; // kept for backward compat in render code
  // The public homepage hides operational checks (GTU duplicates, weight
  // discrepancies, malformed GTU patterns). Those only show on
  // /operations/dashboard. Module-scoped so the auto-refresh timer can
  // reach it — init() defines a local `isPublic` with the same logic.
  const IS_PUBLIC = location.pathname === "/" || location.pathname === "";
  const PLAN_PARAM = IS_OLD ? "old=1" : "";
  const addPlanParam = (url) => {
    if (!PLAN_PARAM) return url;
    return url + (url.includes("?") ? "&" : "?") + PLAN_PARAM;
  };

  async function loadPlanningGeography() {
    try {
      const res = await fetch(addPlanParam("/api/planning-geography"));
      if (res.ok) planGeo = await res.json();
    } catch (e) { console.warn("Geography load error:", e); }
  }

  // ── Updates Summary (only shown on /updated) ─────────────────
  let updatesData = null;
  let removedData = null;
  let reducedData = null;
  let updNewSearch = "", updNewProv = "", updNewKit = "";
  let updRemSearch = "", updRemProv = "", updRemProd = "";
  let updRedSearch = "", updRedProv = "", updRedProd = "", updRedOnlyOver = true;

  function fmtSigned(n) {
    const v = Math.round(Number(n) || 0);
    if (v === 0) return "0";
    return (v > 0 ? "+" : "") + v.toLocaleString("pt-PT");
  }

  async function loadUpdatesSummary() {
    if (!IS_UPDATED) return;
    try {
      const r = await fetch("/api/planning-updates-summary");
      if (!r.ok) return;
      updatesData = await r.json();
      document.getElementById("updates-summary").style.display = "";
      const bn = document.getElementById("upd-badge-new");
      if (bn) bn.textContent = updatesData.newBeneficiaries.length;

      renderProvinceSummary();
      renderNewBenefs();
      renderKits();
      bindUpdatesTabs();

      // Load removed + reduced beneficiaries in parallel
      loadRemovedBenefs();
      loadReducedBenefs();
      loadRealocSummary();
    } catch (e) { console.warn("Updates summary load error:", e); }
  }

  async function loadRealocSummary() {
    if (!IS_UPDATED) return;
    try {
      const r = await fetch("/api/realocacao");
      if (!r.ok) return;
      const d = await r.json();
      const s = d.summary;
      const banner = document.getElementById("realoc-summary");
      const stats = document.getElementById("realoc-home-stats");
      if (banner && stats) {
        banner.style.display = "";
        stats.innerHTML = `<strong>${s.transferencias}</strong> operações de realocação (${s.intra_distrito} mesmo distrito · ${s.intra_provincial} mesma prov · ${s.inter_provincial} inter-prov) · <strong>${s.destinatarios_cobertos}/${s.destinatarios_total}</strong> destinatários cobertos`;
      }
    } catch (e) { console.warn("Realoc summary load error:", e); }
  }

  async function loadRemovedBenefs() {
    try {
      const r = await fetch("/api/planning-removed-beneficiaries");
      if (!r.ok) return;
      removedData = await r.json();
      const br = document.getElementById("upd-badge-removed");
      if (br) br.textContent = removedData.list.length;
      renderRemovedSummary();
      renderRemovedTable();
    } catch (e) { console.warn("Removed benefs load error:", e); }
  }

  function renderRemovedSummary() {
    const box = document.getElementById("upd-removed-summary");
    if (!box || !removedData) return;
    const s = removedData.summary;
    const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("pt-PT");
    box.innerHTML = `
      <div class="metric-mini"><div class="mm-lbl">Beneficiários únicos</div><div class="mm-val">${fmt(s.unique_beneficiaries)}</div></div>
      <div class="metric-mini"><div class="mm-lbl">Linhas removidas c/ entrega</div><div class="mm-val">${fmt(s.total_rows)}</div></div>
      <div class="metric-mini"><div class="mm-lbl">Total já entregue (kg)</div><div class="mm-val" style="color:#dc2626">${fmt(s.total_delivered_kg)}</div></div>
    `;
    // Populate filter dropdowns
    const provSel = document.getElementById("upd-rem-prov");
    if (provSel && provSel.options.length <= 1) {
      [...new Set(removedData.list.map((r) => r.provincia))].sort().forEach((p) => {
        const o = document.createElement("option"); o.value = p; o.textContent = p; provSel.appendChild(o);
      });
    }
    const prodSel = document.getElementById("upd-rem-prod");
    if (prodSel && prodSel.options.length <= 1) {
      [...new Set(removedData.list.map((r) => r.produto))].sort().forEach((p) => {
        const o = document.createElement("option"); o.value = p; o.textContent = p; prodSel.appendChild(o);
      });
    }
  }

  function renderRemovedTable() {
    const body = document.getElementById("upd-removed-body");
    if (!body || !removedData) return;
    const q = updRemSearch.toLowerCase();
    const list = removedData.list.filter((r) => {
      if (updRemProv && r.provincia !== updRemProv) return false;
      if (updRemProd && r.produto !== updRemProd) return false;
      if (q) {
        const hay = (r.beneficiario + " " + r.extensionista + " " + r.distrito + " " + r.posto).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (!list.length) { body.innerHTML = '<tr><td colspan="9" class="empty">Sem resultados</td></tr>'; return; }
    const fmtDec = (n) => Number(n || 0).toLocaleString("pt-PT", { maximumFractionDigits: 1 });
    body.innerHTML = list.map((r) => `<tr>
      <td><strong>${esc(r.beneficiario)}</strong>${r.posto ? '<br><small style="color:#64748b">' + esc(r.posto) + '</small>' : ''}</td>
      <td style="font-size:.82rem">${esc(r.extensionista || "—")}</td>
      <td>${esc(r.provincia)}</td>
      <td>${esc(r.distrito)}</td>
      <td>${esc(r.produto)}</td>
      <td style="text-align:right;color:#64748b">${fmtDec(r.qtd_planeada_original)}</td>
      <td style="text-align:right;color:#dc2626;font-weight:700">${fmtDec(r.qtd_entregue)}</td>
      <td style="font-size:.78rem">${r.datas.length ? esc(r.datas.join(", ")) : "—"}</td>
      <td style="font-size:.72rem;font-family:monospace">${esc(r.gtus.join(", "))}</td>
    </tr>`).join("");
  }

  async function loadReducedBenefs() {
    try {
      const r = await fetch("/api/planning-reduced-beneficiaries");
      if (!r.ok) return;
      reducedData = await r.json();
      const br = document.getElementById("upd-badge-reduced");
      if (br) br.textContent = reducedData.summary.rows_above;
      renderReducedSummary();
      renderReducedTable();
    } catch (e) { console.warn("Reduced benefs load error:", e); }
  }

  function renderReducedSummary() {
    const box = document.getElementById("upd-reduced-summary");
    if (!box || !reducedData) return;
    const s = reducedData.summary;
    const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("pt-PT");
    box.innerHTML = `
      <div class="metric-mini"><div class="mm-lbl">Acima da nova meta</div><div class="mm-val">${fmt(s.rows_above)}</div></div>
      <div class="metric-mini metric-mini-blue"><div class="mm-lbl">Dentro da meta</div><div class="mm-val">${fmt(s.rows_within)}</div></div>
      <div class="metric-mini"><div class="mm-lbl">Beneficiários com excesso</div><div class="mm-val">${fmt(s.unique_beneficiaries_above)}</div></div>
      <div class="metric-mini"><div class="mm-lbl">Total Excesso (kg)</div><div class="mm-val">${fmt(s.total_excesso_kg)}</div></div>
    `;
    const provSel = document.getElementById("upd-red-prov");
    if (provSel && provSel.options.length <= 1) {
      [...new Set(reducedData.list.map((r) => r.provincia))].sort().forEach((p) => {
        const o = document.createElement("option"); o.value = p; o.textContent = p; provSel.appendChild(o);
      });
    }
    const prodSel = document.getElementById("upd-red-prod");
    if (prodSel && prodSel.options.length <= 1) {
      [...new Set(reducedData.list.map((r) => r.produto))].sort().forEach((p) => {
        const o = document.createElement("option"); o.value = p; o.textContent = p; prodSel.appendChild(o);
      });
    }
  }

  function renderReducedTable() {
    const body = document.getElementById("upd-reduced-body");
    if (!body || !reducedData) return;
    const q = updRedSearch.toLowerCase();
    const list = reducedData.list.filter((r) => {
      if (updRedOnlyOver && !r.acima_da_nova_meta) return false;
      if (updRedProv && r.provincia !== updRedProv) return false;
      if (updRedProd && r.produto !== updRedProd) return false;
      if (q) {
        const hay = (r.beneficiario + " " + r.extensionista + " " + r.distrito + " " + r.posto).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => b.excesso - a.excesso);
    if (!list.length) { body.innerHTML = '<tr><td colspan="10" class="empty">Sem resultados</td></tr>'; return; }
    const fmtDec = (n) => Number(n || 0).toLocaleString("pt-PT", { maximumFractionDigits: 1 });
    body.innerHTML = list.map((r) => `<tr ${r.acima_da_nova_meta ? 'style="background:#fef2f2"' : ""}>
      <td><strong>${esc(r.beneficiario)}</strong>${r.posto ? '<br><small style="color:#64748b">' + esc(r.posto) + '</small>' : ''}</td>
      <td style="font-size:.82rem">${esc(r.extensionista || "—")}</td>
      <td>${esc(r.provincia)}</td>
      <td>${esc(r.distrito)}</td>
      <td>${esc(r.produto)}</td>
      <td style="text-align:right;color:#64748b">${fmtDec(r.qtd_planeada_original)}</td>
      <td style="text-align:right;color:#d97706;font-weight:600">${fmtDec(r.qtd_actualizada)}</td>
      <td style="text-align:right;color:${r.acima_da_nova_meta ? "#dc2626" : "#16a34a"};font-weight:700">${fmtDec(r.qtd_entregue)}</td>
      <td style="text-align:right;color:${r.excesso > 0 ? "#dc2626" : "#94a3b8"};font-weight:700">${r.excesso > 0 ? "+" + fmtDec(r.excesso) : "—"}</td>
      <td style="font-size:.78rem">${r.datas.length ? esc(r.datas.join(", ")) : "—"}</td>
    </tr>`).join("");
  }

  function renderProvinceSummary() {
    const body = document.getElementById("upd-prov-body");
    if (!body || !updatesData) return;
    const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("pt-PT");
    body.innerHTML = updatesData.provinceSummary.map((p) => {
      const varColor = (v) => v > 0 ? "#16a34a" : v < 0 ? "#dc2626" : "#64748b";
      const tr = [
        `<td><strong>${esc(p.province)}</strong></td>`,
        `<td class="num grp-grey">${fmt(p.antes.kit1)}</td>`,
        `<td class="num grp-grey">${fmt(p.antes.kit2)}</td>`,
        `<td class="num grp-grey"><strong>${fmt(p.antes.total)}</strong></td>`,
        `<td class="num grp-blue">${fmt(p.depois.kit1)}</td>`,
        `<td class="num grp-blue">${fmt(p.depois.kit2)}</td>`,
        `<td class="num grp-blue"><strong>${fmt(p.depois.total)}</strong></td>`,
        `<td class="num" style="color:${varColor(p.variacao.kit1)};font-weight:600">${fmtSigned(p.variacao.kit1)}</td>`,
        `<td class="num" style="color:${varColor(p.variacao.kit2)};font-weight:600">${fmtSigned(p.variacao.kit2)}</td>`,
        `<td class="num" style="color:${varColor(p.variacao.total)};font-weight:700">${fmtSigned(p.variacao.total)}</td>`,
      ].join("");
      return `<tr class="${p.isTotal ? "upd-total-row" : ""}">${tr}</tr>`;
    }).join("");
  }

  function renderNewBenefs() {
    if (!updatesData) return;
    // Populate filter dropdown
    const provSel = document.getElementById("upd-new-prov");
    const provs = [...new Set(updatesData.newBeneficiaries.map((n) => n.provincia))].sort();
    if (provSel && provSel.options.length <= 1) {
      provs.forEach((p) => { const o = document.createElement("option"); o.value = p; o.textContent = p; provSel.appendChild(o); });
    }

    const q = updNewSearch.toLowerCase();
    const list = updatesData.newBeneficiaries.filter((n) => {
      if (updNewProv && n.provincia !== updNewProv) return false;
      if (updNewKit && n.kit !== updNewKit) return false;
      if (q && !(n.extensionista.toLowerCase().includes(q) || n.distrito.toLowerCase().includes(q) || n.localidade.toLowerCase().includes(q) || n.extensionist_id.toLowerCase().includes(q))) return false;
      return true;
    });

    const body = document.getElementById("upd-new-body");
    if (!list.length) { body.innerHTML = '<tr><td colspan="9" class="empty">Sem resultados</td></tr>'; return; }
    body.innerHTML = list.map((n) => `<tr>
      <td><code style="font-size:.72rem">${esc(n.extensionist_id)}</code></td>
      <td>${esc(n.extensionista)}</td>
      <td style="font-size:.78rem">${esc(n.contacto)}</td>
      <td style="font-size:.78rem">${esc(n.supervisor)}</td>
      <td>${esc(n.provincia)}</td>
      <td>${esc(n.distrito)}</td>
      <td>${esc(n.localidade)}</td>
      <td><span style="font-size:.72rem;padding:.12rem .45rem;border-radius:4px;background:${n.kit === "Kit 1" ? "#dbeafe;color:#1e40af" : "#fef3c7;color:#92400e"}">${esc(n.kit)}</span></td>
      <td style="text-align:right;font-weight:700">${n.qtd_actualizada}</td>
    </tr>`).join("");
  }

  function renderKits() {
    const body = document.getElementById("upd-kits-body");
    if (!body || !updatesData) return;
    body.innerHTML = updatesData.kits.map((k) => `<tr>
      <td><strong>${esc(k.insumo)}</strong></td>
      <td>${esc(k.unidade)}</td>
      <td style="text-align:center">${k.kit1 && k.kit1 !== "-" ? '<strong>' + esc(k.kit1) + '</strong>' : '<span style="color:#94a3b8">—</span>'}</td>
      <td style="text-align:center">${k.kit2 && k.kit2 !== "-" ? '<strong>' + esc(k.kit2) + '</strong>' : '<span style="color:#94a3b8">—</span>'}</td>
      <td style="font-size:.8rem;color:#64748b">${esc(k.observacao)}</td>
    </tr>`).join("");
  }

  // (renderFlagged removed — replaced by renderRemovedTable)

  function bindUpdatesTabs() {
    document.querySelectorAll(".updates-tab").forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        document.querySelectorAll(".updates-tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".updates-panel").forEach((p) => p.style.display = "none");
        const pane = document.getElementById("upd-panel-" + btn.dataset.tab);
        if (pane) pane.style.display = "";
      });
    });
    const s = document.getElementById("upd-new-search");
    if (s && !s.dataset.bound) {
      s.dataset.bound = "1";
      s.addEventListener("input", (e) => { updNewSearch = e.target.value.trim(); renderNewBenefs(); });
    }
    const ps = document.getElementById("upd-new-prov");
    if (ps && !ps.dataset.bound) {
      ps.dataset.bound = "1";
      ps.addEventListener("change", (e) => { updNewProv = e.target.value; renderNewBenefs(); });
    }
    const ks = document.getElementById("upd-new-kit");
    if (ks && !ks.dataset.bound) {
      ks.dataset.bound = "1";
      ks.addEventListener("change", (e) => { updNewKit = e.target.value; renderNewBenefs(); });
    }

    // Removed beneficiaries filters
    const rs = document.getElementById("upd-rem-search");
    if (rs && !rs.dataset.bound) {
      rs.dataset.bound = "1";
      rs.addEventListener("input", (e) => { updRemSearch = e.target.value.trim(); renderRemovedTable(); });
    }
    const rp = document.getElementById("upd-rem-prov");
    if (rp && !rp.dataset.bound) {
      rp.dataset.bound = "1";
      rp.addEventListener("change", (e) => { updRemProv = e.target.value; renderRemovedTable(); });
    }
    const rpr = document.getElementById("upd-rem-prod");
    if (rpr && !rpr.dataset.bound) {
      rpr.dataset.bound = "1";
      rpr.addEventListener("change", (e) => { updRemProd = e.target.value; renderRemovedTable(); });
    }

    // Reduced filters
    const rds = document.getElementById("upd-red-search");
    if (rds && !rds.dataset.bound) {
      rds.dataset.bound = "1";
      rds.addEventListener("input", (e) => { updRedSearch = e.target.value.trim(); renderReducedTable(); });
    }
    const rdp = document.getElementById("upd-red-prov");
    if (rdp && !rdp.dataset.bound) {
      rdp.dataset.bound = "1";
      rdp.addEventListener("change", (e) => { updRedProv = e.target.value; renderReducedTable(); });
    }
    const rdpr = document.getElementById("upd-red-prod");
    if (rdpr && !rdpr.dataset.bound) {
      rdpr.dataset.bound = "1";
      rdpr.addEventListener("change", (e) => { updRedProd = e.target.value; renderReducedTable(); });
    }
    const rdov = document.getElementById("upd-red-only-over");
    if (rdov && !rdov.dataset.bound) {
      rdov.dataset.bound = "1";
      rdov.addEventListener("change", (e) => { updRedOnlyOver = e.target.checked; renderReducedTable(); });
    }
  }

  const SEED_PRODUCTS = new Set(["Maize Seeds (kg)", "Common Bean Seeds (kg)", "Bean Seeds (kg)", "Rice Seeds (kg)"]);

  function populateFilters() {
    // Merge planning provinces with delivery provinces
    const delivProvs = unique(allRows, "province");
    const allProvs = [...new Set([...delivProvs, ...planGeo.provinces])].sort();
    fillSelect(fProvince, allProvs, "Todas Províncias");

    const suppliers = unique(allRows, "supplier");
    fillSelect(fSupplier, suppliers, "Todos Fornecedores");

    // Products: add "Só Sementes" option at top, then individual products
    const products = unique(allRows, "product");
    const current = fProduct.value;
    fProduct.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = ""; opt0.textContent = "Todos Produtos"; fProduct.appendChild(opt0);
    const optS = document.createElement("option");
    optS.value = "__seeds__"; optS.textContent = "Só Sementes (Milho + Feijão + Arroz)";
    optS.style.fontWeight = "600"; fProduct.appendChild(optS);
    products.forEach((v) => {
      if (!v) return;
      const o = document.createElement("option");
      o.value = v; o.textContent = v; fProduct.appendChild(o);
    });
    if (current === "__seeds__" || products.includes(current)) fProduct.value = current;

    updateDistrictOptions();
  }

  function updateDistrictOptions() {
    const prov = fProvince.value;
    // Merge delivery districts with planning districts for the selected province
    const delivSubset = prov ? allRows.filter((r) => r.province === prov) : allRows;
    const delivDists = unique(delivSubset, "district");
    const planDists = prov && planGeo.districtsByProvince[prov] ? planGeo.districtsByProvince[prov] : [];
    const allDists = [...new Set([...delivDists, ...planDists])].sort();
    fillSelect(fDistrict, allDists, "Todos Distritos");
  }

  function fillSelect(el, values, placeholder) {
    const current = el.value;
    el.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = placeholder;
    el.appendChild(opt0);
    values.forEach((v) => {
      if (!v) return;
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      el.appendChild(o);
    });
    if (values.includes(current)) el.value = current;
  }

  function unique(rows, key) {
    return [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort();
  }

  function applyFilters() {
    const prov = fProvince.value;
    const dist = fDistrict.value;
    const status = fStatus.value;
    const supplier = fSupplier.value;
    const product = fProduct.value;
    const search = fSearch.value.trim().toLowerCase();

    filteredRows = allRows.filter((r) => {
      if (prov && r.province !== prov) return false;
      if (dist && r.district !== dist) return false;
      if (status && r.verification_status !== status) return false;
      if (supplier && r.supplier !== supplier) return false;
      if (product === "__seeds__") { if (!SEED_PRODUCTS.has(r.product)) return false; }
      else if (product && r.product !== product) return false;
      if (search) {
        const hay = (
          (r.beneficiary_name || "") +
          " " +
          (r.delivery_id || "")
        ).toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    currentPage = 1;
    sortRows();
    renderMetrics();
    renderCharts();
    renderTable();
    loadPvD();
  }

  function clearFilters() {
    fProvince.value = "";
    fStatus.value = "";
    fSupplier.value = "";
    fProduct.value = "";
    fSearch.value = "";
    updateDistrictOptions();
    fDistrict.value = "";
    // Also wipe per-column filters and the table search box
    colFilters = {};
    tableSearchTerm = "";
    const ts = $("#table-search"); if (ts) ts.value = "";
    applyFilters();
  }

  // ── Metrics ─────────────────────────────────────────────────
  // Sacos herméticos are pre-converted to kg at parse time (0.145 kg/un) so we
  // simply aggregate everything as kg here.
  function renderMetrics() {
    const rows = filteredRows;
    const total = rows.length;
    const qty = rows.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);
    const pkgs = rows.reduce((s, r) => s + (Number(r.packages) || 0), 0);
    // Counts + kg sums per status, with seed breakdown (Milho/Feijão/Arroz).
    // We classify each row by product name → one of the 3 seed buckets, or "other".
    function seedKey(productName) {
      const p = String(productName || "").toLowerCase();
      if (p.includes("maize") || p.includes("milho")) return "milho";
      if (p.includes("bean")  || p.includes("feij"))  return "feijao";
      if (p.includes("rice")  || p.includes("arroz")) return "arroz";
      return null;
    }
    const emptyBucket = () => ({ count: 0, kg: 0, milho: 0, feijao: 0, arroz: 0 });
    const byStatus = {};
    rows.forEach((r) => {
      const s = r.verification_status || "";
      if (!byStatus[s]) byStatus[s] = emptyBucket();
      byStatus[s].count++;
      const qty = Number(r.delivered_qty) || 0;
      byStatus[s].kg += qty;
      const sk = seedKey(r.product);
      if (sk) byStatus[s][sk] += qty;
    });
    const get = (s) => byStatus[s] || emptyBucket();
    const verified = get("Verified");
    const partial = get("Partially Verified");
    const review = get("Under Review");
    const pending = get("Pending Verification");
    const unreachable = get("Not Reachable");
    const rejected = get("Rejected");
    const errors = get("#ERROR!").count;
    const pct = total > 0 ? ((verified.count / total) * 100).toFixed(1) : "0";
    // If the product filter is a saco/hermetic bag, flip card to units
    const productFilter = fProduct.value;
    const filterIsSacos = /saco|hermetic/i.test(String(productFilter || ""));
    const qtyLabel = $("#m-qty-label");
    if (filterIsSacos) {
      if (qtyLabel) qtyLabel.textContent = "Qtd. Entregue (un)";
      $("#m-qty").textContent = fmt(Math.round(qty / SACO_KG_PER_UNIT));
    } else {
      if (qtyLabel) qtyLabel.textContent = "Qtd. Entregue (kg)";
      $("#m-qty").textContent = fmtDec(qty);
    }
    const packagesEl = $("#m-packages");
    if (packagesEl) packagesEl.textContent = fmt(pkgs);
    // Gap will be updated when PvD loads
    $("#m-verified-pct").textContent = pct + "%";
    // Per-status weight subtitle. Flip to "un" if the saco filter is active
    // (saco delivered_qty is stored in kg = units × SACO_KG_PER_UNIT, see parseCSV in app.js).
    const fmtWeight = filterIsSacos
      ? (n) => fmt(Math.round(n / SACO_KG_PER_UNIT)) + " un"
      : (n) => fmtDec(n) + " kg";
    // Seeds are always in kg (sacos are not seeds, so no unit flip needed here).
    const fmtSeedKg = (n) => fmtDec(n) + " kg";
    // Helper: paint the count + total kg + seed breakdown for one card group.
    function paintStatusCard(prefix, bucket) {
      const cEl = $("#m-" + prefix);          if (cEl) cEl.textContent = fmt(bucket.count);
      const kEl = $("#m-" + prefix + "-kg");   if (kEl) kEl.textContent = fmtWeight(bucket.kg);
      const mEl = $("#m-" + prefix + "-milho");  if (mEl) mEl.textContent = fmtSeedKg(bucket.milho);
      const fEl = $("#m-" + prefix + "-feijao"); if (fEl) fEl.textContent = fmtSeedKg(bucket.feijao);
      const aEl = $("#m-" + prefix + "-arroz");  if (aEl) aEl.textContent = fmtSeedKg(bucket.arroz);
    }
    paintStatusCard("partial",     partial);
    paintStatusCard("review",      review);
    paintStatusCard("pending",     pending);
    paintStatusCard("unreachable", unreachable);
    paintStatusCard("rejected",    rejected);
    // Taxa Verificação — same breakdown shape as the other cards, but the
    // big number is a percentage (already set above to #m-verified-pct), so
    // we only paint the kg subtitle + 3 seed rows here.
    const verKg = $("#m-verified-kg");    if (verKg) verKg.textContent = fmtWeight(verified.kg);
    const verM  = $("#m-verified-milho"); if (verM)  verM.textContent  = fmtSeedKg(verified.milho);
    const verF  = $("#m-verified-feijao"); if (verF)  verF.textContent  = fmtSeedKg(verified.feijao);
    const verA  = $("#m-verified-arroz");  if (verA)  verA.textContent  = fmtSeedKg(verified.arroz);
    // If the user filtered by a non-seed product (sacos, MCPA, Emamectin, etc.)
    // there are no seeds to break down — hide the breakdown blocks instead of
    // showing "0 kg / 0 kg / 0 kg" everywhere.
    const seedSum = [verified, partial, review, pending, unreachable, rejected]
      .reduce((s, b) => s + b.milho + b.feijao + b.arroz, 0);
    ["m-verified-bd","m-partial-bd","m-review-bd","m-pending-bd","m-unreachable-bd","m-rejected-bd"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = seedSum > 0 ? "" : "none";
    });
    $("#m-errors").textContent = fmt(errors);

    // Breakdown da quantidade entregue por categoria.
    // Sementes/Químicos/Outros em kg. Sacos em unidades (kg interno / SACO_KG_PER_UNIT).
    const cats = { "Sementes (kg)": 0, "Químicos (kg)": 0, "Sacos (un)": 0, "Outros (kg)": 0 };
    rows.forEach((r) => {
      const q = Number(r.delivered_qty) || 0;
      if (q <= 0) return;
      const name = String(r.product || "").toLowerCase();
      if (/milho|feij|arroz|maize|bean|rice|seed/.test(name)) cats["Sementes (kg)"] += q;
      else if (/emamectin|imidaclop|mcpa/.test(name)) cats["Químicos (kg)"] += q;
      else if (/saco|hermetic/.test(name)) cats["Sacos (un)"] += q / SACO_KG_PER_UNIT; // kg stored → back to units
      else cats["Outros (kg)"] += q;
    });
    const bdq = $("#m-qty-breakdown");
    if (bdq) {
      const entries = Object.entries(cats).filter(([, v]) => v > 0.5);
      bdq.innerHTML = entries.length
        ? entries.map(([k, v]) => {
            const isSacos = k.startsWith("Sacos");
            const value = isSacos ? fmt(Math.round(v)) : fmtDec(v);
            return `<div class="bd-row"><span class="bd-k">${k}</span><span class="bd-v bd-v-blue">${value}</span></div>`;
          }).join("")
        : "";
    }
  }

  function fmt(n) {
    return Number(n).toLocaleString("pt-PT");
  }
  function fmtDec(n) {
    return Number(n).toLocaleString("pt-PT", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }

  // ── Charts ──────────────────────────────────────────────────
  function renderCharts() {
    renderDistrictChart();
    renderTimelineChart();
  }

  // Shared product color palette (also used by timeline chart)
  const PRODUCT_PALETTE = [
    "#1b7a5a", "#0f4c75", "#d97706", "#7c3aed", "#0284c7",
    "#dc2626", "#16a34a", "#db2777", "#0891b2", "#65a30d",
    "#9333ea", "#ea580c", "#0d9488", "#be123c", "#4f46e5",
  ];

  // Map any product name (delivery or planning) to a canonical key,
  // mirroring the server-side matchProduct() in planning-data.js so the
  // client tooltip can join delivery rows with planned values regardless
  // of the exact label used (e.g. "Common Bean Seeds (kg)" → "Feijão").
  function canonicalProduct(name) {
    if (!name) return "";
    const lower = String(name).toLowerCase();
    if (lower.includes("maize") || lower.includes("milho")) return "Milho";
    if (lower.includes("bean") || lower.includes("feij")) return "Feijão";
    if (lower.includes("rice") || lower.includes("arroz")) return "Arroz";
    if (lower.includes("emamectin")) return "Emamectin";
    if (lower.includes("imid") || lower.includes("imad")) return "Imadocloprid";
    if (lower.includes("mcpa")) return "MCPA";
    if (lower.includes("saco") || lower.includes("hermetic")) return "Sacos Hermeticos";
    return name;
  }

  // Sacos hermeticos: armazenados em kg-equivalente (qty × 0.145) mas tipicamente
  // contados em unidades. Helpers para mostrar correctamente nos gráficos.
  function isSacoProduct(name) {
    if (!name) return false;
    const lower = String(name).toLowerCase();
    return lower.includes("saco") || lower.includes("hermetic");
  }
  // Converte qty (em kg interno) para a unidade de display do produto.
  // Devolve { value, unit } onde value é o número a mostrar e unit é "kg" ou "un".
  function displayQty(qtyKg, productName) {
    if (isSacoProduct(productName)) {
      return { value: (Number(qtyKg) || 0) / SACO_KG_PER_UNIT, unit: "un" };
    }
    return { value: Number(qtyKg) || 0, unit: "kg" };
  }
  // Formata para tooltip: "1.234,5 un" ou "1.234,5 kg"
  function fmtQtyForProduct(qtyKg, productName) {
    const d = displayQty(qtyKg, productName);
    return d.value.toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + " " + d.unit;
  }
  // Apêndice de unidade no label de legenda. Idempotente: se o nome já termina
  // com "(un)" (caso comum: "Hermetic bags (un)") devolve tal e qual; só anexa
  // quando o nome dum saco não tem essa marcação ainda.
  function labelWithUnit(productName) {
    if (!isSacoProduct(productName)) return productName;
    if (/\(un\)\s*$/i.test(productName)) return productName;
    return productName + " (un)";
  }

  function renderDistrictChart() {
    // Aggregate delivered qty per district AND per product
    const totalByDistrict = {};       // district -> total delivered_kg
    const districtProducts = {};      // district -> { product -> delivered_kg }
    const productTotals = {};         // product -> total delivered_kg (for global ordering)
    filteredRows.forEach((r) => {
      const d = r.district || "N/A";
      const p = r.product || "Sem produto";
      const qty = Number(r.delivered_qty) || 0;
      totalByDistrict[d] = (totalByDistrict[d] || 0) + qty;
      if (!districtProducts[d]) districtProducts[d] = {};
      districtProducts[d][p] = (districtProducts[d][p] || 0) + qty;
      productTotals[p] = (productTotals[p] || 0) + qty;
    });

    const entries = Object.entries(totalByDistrict).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const labels = entries.map((e) => e[0]);

    // Order products by total desc so the legend & stack are consistent
    // with "Evolução de Entregas por Data"
    const products = Object.entries(productTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);

    // Build planned_kg per district per product from PvD details
    const plannedMap = {};
    if (pvdData && Array.isArray(pvdData.details)) {
      pvdData.details.forEach((it) => {
        if (!plannedMap[it.district]) plannedMap[it.district] = {};
        const key = canonicalProduct(it.product) || it.product;
        plannedMap[it.district][key] = (plannedMap[it.district][key] || 0) + Number(it.planned_kg || 0);
      });
    }

    function fmtNum(n) { return Number(n).toLocaleString("pt-PT", { maximumFractionDigits: 1 }); }

    // One dataset per product, stacked horizontal bars
    // Os valores ficam em kg-equivalente para os totais somarem coerentemente.
    // O tooltip mostra cada produto na sua unidade natural (sacos em un).
    const datasets = products.map((p, i) => ({
      label: labelWithUnit(p),
      _rawProduct: p, // referência original para tooltips/breakdowns
      data: labels.map((d) => +(districtProducts[d][p] || 0).toFixed(1)),
      backgroundColor: PRODUCT_PALETTE[i % PRODUCT_PALETTE.length],
      borderRadius: 3,
      stack: "delivered",
    }));

    if (chartDistrict) chartDistrict.destroy();
    chartDistrict = new Chart($("#chart-district"), {
      type: "bar",
      data: { labels, datasets },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } },
          tooltip: {
            mode: "y",
            intersect: false,
            backgroundColor: "rgba(15,23,42,.95)",
            padding: 10,
            titleFont: { size: 12, weight: "700" },
            bodyFont: { size: 11 },
            footerFont: { size: 11, weight: "700" },
            callbacks: {
              // Replace per-dataset lines with a single summary
              label: function() { return null; },
              beforeBody: function(items) {
                if (!items.length) return "";
                const district = items[0].label;
                return "Total entregue: " + fmtNum(totalByDistrict[district] || 0) + " kg";
              },
              afterBody: function(items) {
                if (!items.length) return [];
                const district = items[0].label;
                const products = districtProducts[district] || {};
                const planned = plannedMap[district] || {};
                const lines = [""];
                lines.push("Por produto:");
                const sorted = Object.entries(products).sort((a, b) => b[1] - a[1]);
                sorted.forEach(([prod, deliv]) => {
                  if (deliv <= 0) return;
                  const plan = planned[canonicalProduct(prod)] || planned[prod] || 0;
                  const pct = plan > 0 ? ((deliv / plan) * 100).toFixed(1) : "—";
                  // Sacos hermeticos sao mostrados em unidades (deliv interno em kg)
                  const planDisp = displayQty(plan, prod);
                  const delivDisp = displayQty(deliv, prod);
                  const planTxt = plan > 0 ? fmtNum(planDisp.value) + " " + planDisp.unit : "?";
                  lines.push("  " + prod);
                  lines.push("    Planeado: " + planTxt);
                  lines.push("    Entregue: " + fmtNum(delivDisp.value) + " " + delivDisp.unit +
                    (plan > 0 ? "  (" + pct + "%)" : ""));
                });
                return lines;
              },
              // Hide the default coloured swatches since we already break it down
              labelColor: function() { return { backgroundColor: "transparent", borderColor: "transparent" }; },
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 9 } } },
          y: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
        },
      },
    });
  }

  // renderVerificationChart() removed — Execucao Global chart was deleted

  // Timeline period filter — começa em "7 dias" para evitar que muitos
  // dias quebrem o layout do gráfico (barras minúsculas, X-axis ilegível).
  // Estado mantido em memória; o utilizador pode alternar entre presets
  // (7/14/30/90/all) ou usar datepickers para um intervalo custom.
  const tlState = { mode: "preset", days: 7, from: null, to: null };

  function applyTimelineFilter(rows) {
    if (tlState.mode === "preset" && tlState.days === "all") return rows;
    let fromIso, toIso;
    if (tlState.mode === "custom") {
      fromIso = tlState.from || null;
      toIso   = tlState.to   || null;
      if (!fromIso && !toIso) return rows; // sem datas custom = mostrar tudo
    } else {
      // Janela "últimos N dias" baseada na MAIS RECENTE delivery_date dos
      // dados (não na data de hoje) — assim em fins-de-semana ou após
      // uma pausa o gráfico continua a mostrar algo útil.
      let maxDate = "";
      rows.forEach((r) => { if (r.delivery_date_iso > maxDate) maxDate = r.delivery_date_iso; });
      if (!maxDate) return rows;
      const d = new Date(maxDate);
      d.setDate(d.getDate() - (Number(tlState.days) - 1));
      fromIso = d.toISOString().slice(0, 10);
      toIso = maxDate;
    }
    return rows.filter((r) => {
      const d = r.delivery_date_iso || "";
      if (!d) return false;
      if (fromIso && d < fromIso) return false;
      if (toIso   && d > toIso)   return false;
      return true;
    });
  }

  // Determina o intervalo [from, to] que o gráfico vai mostrar.
  // Retorna sempre limites válidos (ISO yyyy-mm-dd) — mesmo quando não há
  // entregas, escolhemos o último dia disponível ou hoje como fallback.
  function getTimelineRange(rows) {
    let maxDate = "";
    rows.forEach((r) => { if (r.delivery_date_iso > maxDate) maxDate = r.delivery_date_iso; });
    if (tlState.mode === "custom" && (tlState.from || tlState.to)) {
      // Custom dates — usa o que o user pôs, com fallbacks razoáveis
      let minOverall = "9999-99-99";
      rows.forEach((r) => { if (r.delivery_date_iso && r.delivery_date_iso < minOverall) minOverall = r.delivery_date_iso; });
      return {
        from: tlState.from || (minOverall === "9999-99-99" ? maxDate : minOverall),
        to:   tlState.to   || maxDate || tlState.from,
      };
    }
    if (tlState.mode === "preset" && tlState.days === "all") {
      let minOverall = "9999-99-99";
      rows.forEach((r) => { if (r.delivery_date_iso && r.delivery_date_iso < minOverall) minOverall = r.delivery_date_iso; });
      return { from: minOverall === "9999-99-99" ? maxDate : minOverall, to: maxDate };
    }
    // Preset N dias — calcula janela contínua a contar para trás do maxDate
    if (!maxDate) return { from: null, to: null };
    const d = new Date(maxDate);
    d.setDate(d.getDate() - (Number(tlState.days) - 1));
    return { from: d.toISOString().slice(0, 10), to: maxDate };
  }

  // Gera lista de datas ISO entre 2 limites (inclusive). Garante CONTINUIDADE
  // — dias sem entregas aparecem na lista (com 0 no gráfico) em vez de
  // serem saltados, evitando o efeito de "buraco" entre datas distantes.
  function expandDateRange(fromIso, toIso) {
    if (!fromIso || !toIso) return [];
    const out = [];
    const d = new Date(fromIso);
    const end = new Date(toIso);
    while (d <= end) {
      out.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function renderTimelineChart() {
    const dateProductMap = {}; // { iso: { product: kg } }
    const productSet = new Set();
    const rowsForChart = applyTimelineFilter(filteredRows);
    rowsForChart.forEach((r) => {
      const d = r.delivery_date_iso || "";
      if (!d) return;
      const product = r.product || "Sem produto";
      const qty = Number(r.delivered_qty) || 0;
      if (!dateProductMap[d]) dateProductMap[d] = {};
      dateProductMap[d][product] = (dateProductMap[d][product] || 0) + qty;
      productSet.add(product);
    });

    // Expande para TODOS os dias do período (sem saltos). Para presets
    // numéricos (7/14/30/90) e custom-dates, geramos a sequência contínua
    // — dias sem entregas aparecem como barra a 0. Para "Tudo" (período
    // potencialmente longo) mantemos só os dias com entregas para o
    // gráfico não ficar com centenas de barras vazias.
    let sortedDates;
    const expand = !(tlState.mode === "preset" && tlState.days === "all");
    if (expand) {
      const range = getTimelineRange(filteredRows);
      sortedDates = expandDateRange(range.from, range.to);
      sortedDates.forEach((iso) => { if (!dateProductMap[iso]) dateProductMap[iso] = {}; });
    } else {
      sortedDates = Object.keys(dateProductMap).sort();
    }
    const labels = sortedDates.map((iso) => {
      const parts = iso.split("-");
      return parts[2] + "/" + parts[1] + "/" + parts[0];
    });

    // Order products by total descending so the legend is meaningful
    const products = [...productSet].sort((a, b) => {
      const ta = sortedDates.reduce((s, d) => s + (dateProductMap[d][a] || 0), 0);
      const tb = sortedDates.reduce((s, d) => s + (dateProductMap[d][b] || 0), 0);
      return tb - ta;
    });

    // Distinct color palette. Sacos hermeticos: stack em kg-equivalente para
    // os totais somarem, tooltip mostra em unidades (un).
    const palette = PRODUCT_PALETTE;
    const datasets = products.map((p, i) => ({
      label: labelWithUnit(p),
      _rawProduct: p,
      data: sortedDates.map((d) => +(dateProductMap[d][p] || 0).toFixed(1)),
      backgroundColor: palette[i % palette.length],
      borderRadius: 3,
      stack: "delivered",
    }));

    if (chartTimeline) chartTimeline.destroy();
    chartTimeline = new Chart($("#chart-timeline"), {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } },
          tooltip: {
            mode: "index",
            callbacks: {
              // Cada linha do tooltip: mostra o produto na sua unidade natural
              label: (ctx) => {
                const ds = ctx.dataset;
                const raw = ds._rawProduct || ds.label;
                const d = displayQty(ctx.parsed.y, raw);
                return ds.label + ": " + d.value.toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + " " + d.unit;
              },
              footer: (items) => {
                // Totais kg (só produtos kg) + Totais un (só sacos)
                let totalKg = 0, totalUn = 0;
                items.forEach((it) => {
                  const raw = it.dataset._rawProduct || it.dataset.label;
                  if (isSacoProduct(raw)) totalUn += (Number(it.parsed.y) || 0) / SACO_KG_PER_UNIT;
                  else                    totalKg += Number(it.parsed.y) || 0;
                });
                const lines = [];
                if (totalKg > 0) lines.push("Total kg: " + totalKg.toLocaleString("pt-PT", { maximumFractionDigits: 0 }) + " kg");
                if (totalUn > 0) lines.push("Total sacos: " + Math.round(totalUn).toLocaleString("pt-PT") + " un");
                return lines.join(" · ");
              },
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } },
          y: { stacked: true, beginAtZero: true, grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } },
            title: { display: true, text: "Quantidade (kg / kg-equiv. para sacos)", font: { size: 10 } } },
        },
      },
    });
  }

  // ── Table ───────────────────────────────────────────────────
  function sortRows() {
    filteredRows.sort((a, b) => {
      let va = a[sortCol] ?? "";
      let vb = b[sortCol] ?? "";
      if (sortCol === "delivered_qty" || sortCol === "packages") {
        va = Number(va) || 0;
        vb = Number(vb) || 0;
      }
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });
  }

  // ── Table search ────────────────────────────────────────────
  let tableSearchTerm = "";
  // Per-column filters: { colKey: filterValue }. Set by the in-table filter
  // row directly under the headers. Combine (AND) with global filters and
  // the free-text search box.
  let colFilters = {};

  // Categorical columns get a <select> dropdown (exact-match). Everything
  // else with type=text|date gets a free-text input (substring, ci).
  const SELECT_FILTER_KEYS = new Set([
    "verification_status", "province", "district", "product",
    "product_unit", "supplier", "submitted_by", "is_locked",
  ]);
  // Columns that can't be usefully filtered (URLs, photos, signatures, etc.)
  const SKIP_FILTER_KEYS = new Set([
    "delivery_note_link", "delivery_note_link2", "delivery_note_link3",
    "beneficiary_signature", "delivery_notes_view",
  ]);
  function colFilterType(col) {
    if (!col) return null;
    if (SKIP_FILTER_KEYS.has(col.key)) return null;
    if (SELECT_FILTER_KEYS.has(col.key)) return "select";
    if (col.type === "number" || col.type === "notes") return null;
    return "text";
  }
  function getColUniqueValues(key) {
    // Use filteredRows (after global filters, before col filters) so the
    // dropdown options reflect the user's current scope.
    const set = new Set();
    filteredRows.forEach((r) => {
      const v = String(r[key] ?? "").trim();
      if (v) set.add(v);
    });
    return [...set].sort((a, b) => a.localeCompare(b, "pt"));
  }

  function getTableSearchRows() {
    let rows = filteredRows;
    // Apply per-column filters first (cheap loop bail-out)
    const activeColFilters = Object.entries(colFilters).filter(([, v]) => v);
    if (activeColFilters.length) {
      rows = rows.filter((r) => {
        for (const [key, val] of activeColFilters) {
          if (SELECT_FILTER_KEYS.has(key)) {
            if (String(r[key] ?? "") !== val) return false;
          } else {
            if (!String(r[key] ?? "").toLowerCase().includes(val.toLowerCase())) return false;
          }
        }
        return true;
      });
    }
    // Then the free-text search box
    if (tableSearchTerm) {
      const q = tableSearchTerm.toLowerCase();
      rows = rows.filter((r) => {
        // Para sacos hermeticos: pesquisa também aceita o valor em unidades
        // (delivered_qty_units), porque é isso que o utilizador vê na tabela.
        const qtyUnits = r.delivered_qty_units != null ? String(r.delivered_qty_units) : "";
        const hay = [
          r.delivery_id, r.beneficiary_name, r.province, r.district,
          r.product, r.delivery_note_number, r.submitted_by,
          r.verification_status, r.delivery_date,
          String(r.delivered_qty), qtyUnits, String(r.packages),
        ].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }
    return rows;
  }

  function highlightMatch(text, term) {
    if (!term || !text) return esc(text);
    const escaped = esc(text);
    const termEsc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${termEsc})`, "gi");
    return escaped.replace(re, '<mark class="search-hl">$1</mark>');
  }

  // ── Render table header ──────────────────────────────────────
  function renderTableHeader() {
    const headRow = $("#table-thead-row");
    headRow.innerHTML = visibleCols
      .map((key) => {
        const col = getColDef(key);
        if (!col) return "";
        const sk = col.sortKey || key;
        const classes = [];
        if (sortCol === sk) classes.push("sort-active");
        if (col.type === "number" || col.type === "badge" || col.type === "notes") classes.push("num");
        return `<th data-col="${sk}" class="${classes.join(" ")}">${esc(col.label)} \u25B4\u25BE</th>`;
      })
      .join("");

    // Re-bind sort clicks
    $$("#table-thead-row th").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        if (!col) return;
        if (sortCol === col) sortAsc = !sortAsc;
        else { sortCol = col; sortAsc = true; }
        sortRows();
        renderTable();
      });
    });
  }

  // ── Render per-column filter row ─────────────────────────────
  // Re-rendered on full table renders (column visibility, global filters,
  // sort). Text input changes only re-render the body to keep focus.
  let colFilterDebounce = null;
  function renderColFilterRow() {
    const row = $("#table-filter-row");
    if (!row) return;
    row.innerHTML = visibleCols
      .map((key) => {
        const col = getColDef(key);
        if (!col) return "<th></th>";
        const ftype = colFilterType(col);
        if (!ftype) return '<th class="col-filter-empty"></th>';
        const cur = colFilters[key] || "";
        const hasVal = cur ? " has-value" : "";
        if (ftype === "select") {
          const values = getColUniqueValues(key);
          const opts = ['<option value="">— Todos —</option>']
            .concat(values.map((v) =>
              `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(v)}</option>`))
            .join("");
          return `<th><select class="col-filter-input${hasVal}" data-col-filter="${key}">${opts}</select></th>`;
        }
        return `<th><input type="text" class="col-filter-input${hasVal}" data-col-filter="${key}" placeholder="Filtrar…" value="${esc(cur)}"></th>`;
      })
      .join("");

    // Bind events. Text inputs debounce; selects are immediate.
    row.querySelectorAll(".col-filter-input").forEach((el) => {
      const isSelect = el.tagName === "SELECT";
      const handler = () => {
        const k = el.dataset.colFilter;
        const v = el.value.trim();
        if (v) colFilters[k] = v;
        else delete colFilters[k];
        el.classList.toggle("has-value", !!v);
        currentPage = 1;
        // Body-only render preserves focus on text inputs
        renderTableBody();
      };
      if (isSelect) {
        el.addEventListener("change", handler);
      } else {
        el.addEventListener("input", () => {
          clearTimeout(colFilterDebounce);
          colFilterDebounce = setTimeout(handler, 200);
        });
      }
    });
  }

  function renderTable() {
    renderTableHeader();
    renderColFilterRow();
    renderTableBody();
  }

  function renderTableBody() {
    const searchRows = getTableSearchRows();
    const start = (currentPage - 1) * PAGE_SIZE;
    const page = searchRows.slice(start, start + PAGE_SIZE);
    const q = tableSearchTerm;

    elTableBody.innerHTML = page
      .map((r) => {
        const isSaco = /saco|hermetic/i.test(String(r.product || ""));
        const cells = visibleCols
          .map((key) => {
            const col = getColDef(key);
            if (!col) return "<td></td>";
            const raw = r[key];
            if (col.type === "number") {
              // Sacos hermeticos: parseCSV converte delivered_qty para kg-equiv
              // (units × 0,3) para agregação consistente em kg nos cards/charts,
              // mas o utilizador quer ver UNIDADES na tabela. Usar
              // delivered_qty_units (valor original antes da conversão).
              if (isSaco && key === "delivered_qty") {
                const units = r.delivered_qty_units != null ? r.delivered_qty_units : raw;
                return `<td style="text-align:right">${fmtDec(Number(units) || 0)} <span style="color:#94a3b8;font-size:.72rem;font-weight:400">un</span></td>`;
              }
              return `<td style="text-align:right">${fmtDec(Number(raw) || 0)}</td>`;
            }
            if (col.type === "badge") {
              return `<td class="num">${statusBadge(raw)}</td>`;
            }
            if (col.type === "notes") {
              const links = [r.delivery_note_link, r.delivery_note_link2, r.delivery_note_link3]
                .filter((u) => u && String(u).trim());
              if (!links.length) return `<td style="text-align:center;color:#cbd5e1">—</td>`;
              const payload = encodeURIComponent(JSON.stringify(links));
              return `<td style="text-align:center"><button class="notes-eye" data-links="${payload}" title="Ver notas de entrega (${links.length})" style="background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;cursor:pointer;font-size:.72rem;font-weight:600;padding:.25rem .55rem;border-radius:6px;display:inline-flex;align-items:center;gap:.35rem;line-height:1"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>${links.length}</button></td>`;
            }
            let text = String(raw ?? "");
            if (col.truncate) text = text.slice(0, col.truncate);
            const titleAttr = col.truncate ? ` title="${esc(String(r[key] ?? ""))}"` : "";
            const styleAttr = col.type === "date" ? ' style="text-align:center"' : "";
            return `<td${titleAttr}${styleAttr}>${highlightMatch(text, q)}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");

    // Update search count
    const countEl = $("#table-search-count");
    const clearBtn = $("#btn-clear-table-search");
    if (q) {
      countEl.textContent = searchRows.length + " de " + filteredRows.length;
      clearBtn.style.display = "block";
    } else {
      countEl.textContent = "";
      clearBtn.style.display = "none";
    }

    renderPagination(searchRows.length);
  }

  // ── Notes modal (delivery note photos) ─────────────────────
  function ensureNotesModal() {
    if (document.getElementById("notes-modal")) return;
    const wrap = document.createElement("div");
    wrap.id = "notes-modal";
    wrap.innerHTML = `
      <style>
        #notes-modal{position:fixed;inset:0;background:rgba(15,23,42,.75);display:none;align-items:center;justify-content:center;z-index:9999;padding:1rem}
        #notes-modal.open{display:flex}
        #notes-modal .nm-box{background:#fff;border-radius:12px;max-width:900px;width:100%;max-height:90vh;overflow:auto;padding:1.25rem;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.4)}
        #notes-modal .nm-close{position:absolute;top:.6rem;right:.8rem;background:#f1f5f9;border:none;width:34px;height:34px;border-radius:50%;font-size:1.2rem;cursor:pointer;color:#334155}
        #notes-modal .nm-close:hover{background:#e2e8f0}
        #notes-modal h3{margin:0 0 1rem 0;font-size:1rem;color:#0f172a}
        #notes-modal .nm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.8rem}
        #notes-modal .nm-thumb{cursor:zoom-in;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#f8fafc;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center}
        #notes-modal .nm-thumb img{width:100%;height:100%;object-fit:cover;display:block}
        #notes-modal .nm-thumb:hover{border-color:#2563eb}
        #notes-modal .nm-link{display:block;text-align:center;font-size:.75rem;color:#64748b;margin-top:.3rem;text-decoration:none}
        #notes-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;z-index:10000;padding:2rem}
        #notes-lightbox.open{display:flex}
        #notes-lightbox img{max-width:95vw;max-height:90vh;object-fit:contain;border-radius:6px}
        #notes-lightbox .lb-close{position:absolute;top:1rem;right:1.5rem;background:#fff;border:none;width:42px;height:42px;border-radius:50%;font-size:1.5rem;cursor:pointer;color:#0f172a}
      </style>
      <div class="nm-box">
        <button class="nm-close" type="button">&times;</button>
        <h3>Notas de Entrega</h3>
        <div class="nm-grid"></div>
      </div>`;
    document.body.appendChild(wrap);

    const lb = document.createElement("div");
    lb.id = "notes-lightbox";
    lb.innerHTML = `<button class="lb-close" type="button">&times;</button><img alt="">`;
    document.body.appendChild(lb);

    wrap.addEventListener("click", (e) => {
      if (e.target === wrap || e.target.classList.contains("nm-close")) {
        wrap.classList.remove("open");
      }
    });
    lb.addEventListener("click", (e) => {
      if (e.target === lb || e.target.classList.contains("lb-close")) {
        lb.classList.remove("open");
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      lb.classList.remove("open");
      wrap.classList.remove("open");
    });
  }

  function openNotesModal(links) {
    ensureNotesModal();
    const wrap = document.getElementById("notes-modal");
    const grid = wrap.querySelector(".nm-grid");
    grid.innerHTML = links.map((url, i) => `
      <div>
        <div class="nm-thumb" data-url="${esc(url)}">
          <img src="${esc(url)}" alt="Nota ${i+1}" loading="lazy" onerror="this.parentNode.innerHTML='<span style=color:#94a3b8;font-size:.8rem;padding:1rem;text-align:center>Imagem indisponível</span>'">
        </div>
        <a class="nm-link" href="${esc(url)}" target="_blank" rel="noopener">Abrir original ↗</a>
      </div>`).join("");
    grid.querySelectorAll(".nm-thumb").forEach((el) => {
      el.addEventListener("click", () => {
        const lb = document.getElementById("notes-lightbox");
        lb.querySelector("img").src = el.dataset.url;
        lb.classList.add("open");
      });
    });
    wrap.classList.add("open");
  }

  // ── Column picker ──────────────────────────────────────────
  function renderColumnPicker() {
    const list = $("#col-picker-list");
    list.innerHTML = ALL_COLUMNS
      .map((col) => {
        const on = visibleCols.includes(col.key);
        return `<label class="col-chip ${on ? "on" : ""}" data-key="${col.key}">
          <span class="col-chip-dot"></span>
          <input type="checkbox" ${on ? "checked" : ""}>
          ${esc(col.label)}
        </label>`;
      })
      .join("");

    // Bind checkbox clicks
    list.querySelectorAll(".col-chip").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        const key = chip.dataset.key;
        const cb = chip.querySelector("input");
        if (visibleCols.includes(key)) {
          if (visibleCols.length <= 3) return; // keep at least 3
          visibleCols = visibleCols.filter((k) => k !== key);
          cb.checked = false;
          chip.classList.remove("on");
        } else {
          // Insert in original order
          const order = ALL_COLUMNS.map((c) => c.key);
          visibleCols.push(key);
          visibleCols.sort((a, b) => order.indexOf(a) - order.indexOf(b));
          cb.checked = true;
          chip.classList.add("on");
        }
        renderTable();
      });
    });
  }

  function toggleColumnPicker() {
    const picker = $("#col-picker");
    const btn = $("#btn-columns-toggle");
    const show = picker.style.display === "none";
    picker.style.display = show ? "block" : "none";
    btn.classList.toggle("active", show);
    if (show) renderColumnPicker();
  }

  function resetColumns() {
    visibleCols = getDefaultCols();
    renderColumnPicker();
    renderTable();
  }

  function statusBadge(s) {
    if (s === "Verified")
      return '<span class="badge badge-verified">Verified</span>';
    if (s === "Partially Verified")
      return '<span class="badge badge-partial">Partially Verified</span>';
    if (s === "Under Review")
      return '<span class="badge badge-review">Under Review</span>';
    if (s === "Pending Verification")
      return '<span class="badge badge-pending">Pending</span>';
    if (s === "Not Reachable")
      return '<span class="badge badge-unreachable">Not Reachable</span>';
    if (s === "Rejected")
      return '<span class="badge badge-rejected">Rejected</span>';
    if (s === "#ERROR!")
      return '<span class="badge badge-error">#ERROR!</span>';
    return esc(s || "—");
  }

  function esc(s) {
    if (!s) return "";
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Pagination ──────────────────────────────────────────────
  function renderPagination(totalItems) {
    const count = totalItems != null ? totalItems : getTableSearchRows().length;
    const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    let html = "";

    html += `<button ${currentPage <= 1 ? "disabled" : ""} data-page="${
      currentPage - 1
    }">&laquo;</button>`;

    const range = pagRange(currentPage, totalPages);
    range.forEach((p) => {
      if (p === "...") {
        html += `<span class="page-info">…</span>`;
      } else {
        html += `<button class="${p === currentPage ? "active" : ""}" data-page="${p}">${p}</button>`;
      }
    });

    html += `<button ${currentPage >= totalPages ? "disabled" : ""} data-page="${
      currentPage + 1
    }">&raquo;</button>`;
    html += `<span class="page-info">${count} registos</span>`;

    elPagination.innerHTML = html;
  }

  function pagRange(cur, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = [1];
    let lo = Math.max(2, cur - 1);
    let hi = Math.min(total - 1, cur + 1);
    if (lo > 2) pages.push("...");
    for (let i = lo; i <= hi; i++) pages.push(i);
    if (hi < total - 1) pages.push("...");
    pages.push(total);
    return pages;
  }

  // ── Export helpers ───────────────────────────────────────────
  function downloadBlob(url, opts) {
    return fetch(url, opts)
      .then((r) => {
        const disp = r.headers.get("content-disposition") || "";
        const match = disp.match(/filename="?([^"]+)"?/);
        const filename = match ? match[1] : "export.xlsx";
        return r.blob().then((b) => ({ blob: b, filename }));
      })
      .then(({ blob, filename }) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      });
  }

  function exportTableExcel() {
    const cols = visibleCols.map((k) => getColDef(k)).filter(Boolean);
    const exportRows = getTableSearchRows();
    // Generate CSV client-side to guarantee filtered data
    const header = cols.map((c) => c.label);
    const csvRows = [header.map((h) => '"' + String(h).replace(/"/g, '""') + '"').join(",")];
    exportRows.forEach((r) => {
      const isSaco = /saco|hermetic/i.test(String(r.product || ""));
      const row = cols.map((c) => {
        let val = r[c.key];
        // Para sacos hermeticos, exporta delivered_qty em UNIDADES (não em
        // kg-equivalente) — o que o utilizador vê na tabela.
        if (isSaco && c.key === "delivered_qty" && r.delivered_qty_units != null) {
          val = r.delivered_qty_units;
        }
        return '"' + String(val ?? "").replace(/"/g, '""') + '"';
      });
      csvRows.push(row.join(","));
    });
    const csv = csvRows.join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "entregas_" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportSection(section) {
    downloadBlob("/api/export/" + section);
  }

  function exportFullReport() {
    downloadBlob("/api/export/relatorio-completo");
  }

  // ── Client-side verification (for history mode) ─────────────
  function verifyClientSide(rows) {
    const UNITS = [1, 5, 10, 12.5, 15, 50];
    const DN_PATTERN = /^gt[us]98\/\d{9}$/i;
    const gtuMap = {};
    rows.forEach((r, i) => {
      const gtu = (r.delivery_note_number || "").trim();
      if (!gtu) return;
      if (!gtuMap[gtu]) gtuMap[gtu] = [];
      gtuMap[gtu].push({ row: i + 2, delivery_id: r.delivery_id, beneficiary_name: r.beneficiary_name, district: r.district, packages: r.packages, delivered_qty: r.delivered_qty, verification_status: r.verification_status });
    });
    const IGNORED_DUP_GTUS = new Set(["GTU98/202306448"]);
    const duplicate_gtus = [];
    for (const [gtu, entries] of Object.entries(gtuMap)) {
      if (entries.length > 1 && !IGNORED_DUP_GTUS.has(gtu)) duplicate_gtus.push({ gtu, count: entries.length, entries });
    }
    const weight_mismatches = [];
    rows.forEach((r, i) => {
      if (r.packages <= 0) return;
      const match = UNITS.find((u) => Math.abs(r.delivered_qty - r.packages * u) < 0.01);
      if (!match) {
        const closest = UNITS.reduce((b, u) => { const d = Math.abs(r.delivered_qty - r.packages * u); return d < b.diff ? { unit: u, expected: r.packages * u, diff: d } : b; }, { unit: 0, expected: 0, diff: Infinity });
        const diff = +(r.delivered_qty - closest.expected).toFixed(2);
        if (Math.abs(diff) < 1) return; // ignore differences < 1 kg
        weight_mismatches.push({ row: i + 2, delivery_id: r.delivery_id, gtu: r.delivery_note_number, beneficiary_name: r.beneficiary_name, district: r.district, product: r.product, packages: r.packages, delivered_qty: r.delivered_qty, closest_unit: closest.unit, expected_qty: closest.expected, difference: diff });
      }
    });
    const malformed_gtus = [];
    rows.forEach((r, i) => {
      const gtu = (r.delivery_note_number || "").trim();
      if (!gtu) { malformed_gtus.push({ row: i + 2, delivery_id: r.delivery_id, gtu: "(vazio)", beneficiary_name: r.beneficiary_name, district: r.district, reason: "Delivery Note em branco" }); return; }
      if (!DN_PATTERN.test(gtu)) {
        let reason = !/^gt[us]98\//i.test(gtu) ? "Prefixo incorrecto (esperado GTU98/ ou GTS98/)" : "Comprimento incorrecto (" + gtu.length + " chars, esperado 15)";
        malformed_gtus.push({ row: i + 2, delivery_id: r.delivery_id, gtu, beneficiary_name: r.beneficiary_name, district: r.district, reason });
      }
    });
    return {
      total_rows: rows.length, unique_gtus: Object.keys(gtuMap).length,
      duplicate_gtus, duplicate_gtu_count: duplicate_gtus.length,
      weight_mismatches, weight_mismatch_count: weight_mismatches.length,
      malformed_gtus, malformed_gtu_count: malformed_gtus.length,
    };
  }

  // ── Verification ─────────────────────────────────────────────
  async function runVerification() {
    const section = $("#verify-section");
    const summary = $("#verify-summary");
    const dupWrap = $("#verify-dup-wrap");
    const weightWrap = $("#verify-weight-wrap");
    const dupBody = $("#dup-table-body");
    const weightBody = $("#weight-table-body");
    const btn = $("#btn-run-verify");

    btn.disabled = true;
    btn.textContent = "A verificar...";

    try {
      let v;
      if (historyMode) {
        v = verifyClientSide(allRows);
      } else {
        const res = await fetch("/api/verify");
        v = await res.json();
      }

      // Summary badges
      const dupOk = v.duplicate_gtu_count === 0;
      const wOk = v.weight_mismatch_count === 0;
      const pOk = v.malformed_gtu_count === 0;

      summary.innerHTML =
        `<span class="verify-badge ${dupOk ? "ok" : "error"}">` +
        `<span class="vb-count">${v.duplicate_gtu_count}</span> GTUs duplicados</span>` +
        `<span class="verify-badge ${wOk ? "ok" : "error"}">` +
        `<span class="vb-count">${v.weight_mismatch_count}</span> Discrepancias peso</span>` +
        `<span class="verify-badge ${pOk ? "ok" : "error"}">` +
        `<span class="vb-count">${v.malformed_gtu_count}</span> GTUs fora do padrao</span>` +
        `<span class="verify-badge ok">` +
        `<span class="vb-count">${v.unique_gtus}</span> GTUs unicos de ${v.total_rows} registos</span>`;

      // Duplicate GTUs table
      if (v.duplicate_gtu_count > 0) {
        dupWrap.style.display = "block";
        dupBody.innerHTML = v.duplicate_gtus
          .flatMap((dup) =>
            dup.entries.map(
              (e, idx) =>
                `<tr class="${idx > 0 ? "dup-highlight" : ""}">
                  <td>${idx === 0 ? esc(dup.gtu) : '<span style="color:#94a3b8">↳ duplicado</span>'}</td>
                  <td>${idx === 0 ? dup.count : ""}</td>
                  <td>${esc(e.delivery_id)}</td>
                  <td>${esc(e.beneficiary_name)}</td>
                  <td>${esc(e.district)}</td>
                  <td style="text-align:right">${fmt(e.packages)}</td>
                  <td style="text-align:right">${fmtDec(e.delivered_qty)}</td>
                  <td>${statusBadge(e.verification_status)}</td>
                </tr>`
            )
          )
          .join("");
      } else {
        dupWrap.style.display = "none";
      }

      // Weight mismatches table (collapsible)
      if (v.weight_mismatch_count > 0) {
        weightWrap.style.display = "block";
        weightBody.innerHTML = v.weight_mismatches
          .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
          .map(
            (m) =>
              `<tr>
                <td>${esc(m.gtu)}</td>
                <td>${esc(m.delivery_id)}</td>
                <td>${esc(m.beneficiary_name)}</td>
                <td>${esc(m.district)}</td>
                <td>${esc(m.product || "")}</td>
                <td style="text-align:right">${fmt(m.packages)}</td>
                <td style="text-align:right">${fmtDec(m.delivered_qty)}</td>
                <td style="text-align:center;font-weight:600">${m.closest_unit || 12.5} kg</td>
                <td style="text-align:right">${fmtDec(m.expected_qty)}</td>
                <td class="${m.difference > 0 ? "diff-positive" : "diff-negative"}" style="text-align:right">
                  ${m.difference > 0 ? "+" : ""}${fmtDec(m.difference)}
                </td>
              </tr>`
          )
          .join("");
      } else {
        weightWrap.style.display = "none";
      }

      // Malformed GTU pattern table
      const patternWrap = $("#verify-pattern-wrap");
      const patternBody = $("#pattern-table-body");
      if (v.malformed_gtu_count > 0) {
        patternWrap.style.display = "block";
        patternBody.innerHTML = v.malformed_gtus
          .map(
            (m) =>
              `<tr>
                <td><code style="background:#fef2f2;padding:.1rem .4rem;border-radius:4px;color:#991b1b">${esc(m.gtu)}</code></td>
                <td>${esc(m.delivery_id)}</td>
                <td>${esc(m.beneficiary_name)}</td>
                <td>${esc(m.district)}</td>
                <td class="reason-cell">${esc(m.reason)}</td>
              </tr>`
          )
          .join("");
      } else {
        patternWrap.style.display = "none";
      }

      section.style.display = "block";
    } catch (e) {
      console.error("Verification error:", e);
      summary.innerHTML = '<span class="verify-badge error">Erro ao verificar dados</span>';
      section.style.display = "block";
    } finally {
      btn.disabled = false;
      btn.textContent = "Verificar GTUs & Pesos";
    }
  }

  // ── Analytics (exec summary, velocity, gaps, urgency, suppliers) ──
  async function loadAnalytics() {
    try {
      const ana = await (await fetch("/api/analytics")).json();
      renderExecSummary(ana);
      renderGapAnalysis(ana.gaps);
      renderUrgencyTable(ana.urgency);
      renderSupplierPerf(ana.supplier_performance);
    } catch (e) {
      console.error("Analytics error:", e);
    }
  }

  function renderExecSummary(ana) {
    // Summary lines
    const lines = $("#exec-lines");
    lines.innerHTML = ana.executive_summary
      .map((s) => `<div class="exec-line">${esc(s)}</div>`)
      .join("");

    // Velocity cards
    $("#exec-velocity").textContent = fmt(ana.velocity.avg_kg_per_day);
    $("#exec-est-days").textContent = ana.velocity.est_days_left ? fmt(ana.velocity.est_days_left) : "N/A";
    $("#exec-last7").textContent = fmtDec(ana.last7.kg);

    // Trend
    const diff = ana.last7.kg - ana.last7.prev_kg;
    const trendEl = $("#exec-trend");
    const trendIcon = $("#exec-trend-icon");
    if (diff > 0) {
      trendEl.textContent = "+" + fmtDec(diff) + " kg";
      trendEl.className = "exec-card-value exec-trend-up";
      trendIcon.textContent = "\u2191";
      trendIcon.style.color = "#4ade80";
    } else if (diff < 0) {
      trendEl.textContent = fmtDec(diff) + " kg";
      trendEl.className = "exec-card-value exec-trend-down";
      trendIcon.textContent = "\u2193";
      trendIcon.style.color = "#f87171";
    } else {
      trendEl.textContent = "0 kg";
      trendEl.className = "exec-card-value";
      trendIcon.textContent = "\u2192";
    }
  }

  function renderGapAnalysis(gaps) {
    const maxPlanned = Math.max(...gaps.map((g) => g.planned_kg), 1);
    $("#gap-analysis").innerHTML = gaps
      .map((g) => {
        const pctW = (g.planned_kg / maxPlanned) * 100;
        const delW = g.planned_kg > 0 ? (g.delivered_kg / g.planned_kg) * pctW : 0;
        const gapTons = Math.round((g.gap_kg) / 1000);
        return `<div class="gap-row">
          <div class="gap-label">${esc(g.product)}</div>
          <div class="gap-bar-wrap">
            <div class="gap-bar-planned" style="width:${pctW}%"></div>
            <div class="gap-bar-delivered" style="width:${Math.min(delW, pctW)}%"></div>
          </div>
          <div class="gap-pct" style="color:${g.pct >= 95 ? "#16a34a" : g.pct > 0 ? "#d97706" : "#dc2626"}">${g.pct}%</div>
          <div class="gap-remaining">-${fmt(gapTons)}t falta</div>
        </div>`;
      })
      .join("");
  }

  let urgencyData = [];
  let urgSortCol = "pct";
  let urgSortAsc = true;

  let provRankData = [];
  let provSortCol = "gap_kg";
  let provSortAsc = false; // descending by default (biggest gap first)

  function renderProvRankTable(data) {
    if (data) provRankData = data;
    const NUM_COLS = new Set(["rank", "planned_kg", "delivered_kg", "gap_kg", "pct"]);
    const sorted = provRankData.slice().sort((a, b) => {
      let va = a[provSortCol], vb = b[provSortCol];
      if (NUM_COLS.has(provSortCol)) { va = Number(va) || 0; vb = Number(vb) || 0; }
      else { va = String(va || "").toLowerCase(); vb = String(vb || "").toLowerCase(); }
      if (va < vb) return provSortAsc ? -1 : 1;
      if (va > vb) return provSortAsc ? 1 : -1;
      return 0;
    });
    $$("#prov-rank-thead th").forEach((th) => {
      th.classList.toggle("sort-active", th.dataset.col === provSortCol);
      th.style.cursor = "pointer";
    });
    $("#prov-rank-body").innerHTML = sorted
      .map((d, i) => {
        const rank = i + 1;
        const gapColor = d.gap_kg > 50000 ? "#dc2626" : d.gap_kg > 10000 ? "#d97706" : "#16a34a";
        return `<tr>
          <td class="num" style="font-weight:700;color:${rank <= 2 ? "#dc2626" : rank <= 4 ? "#d97706" : "#64748b"}">${rank}</td>
          <td style="font-weight:600">${esc(d.province)}</td>
          <td class="num">${fmtDec(d.planned_kg)}</td>
          <td class="num">${fmtDec(d.delivered_kg)}</td>
          <td class="num" style="font-weight:700;color:${gapColor}">${fmtDec(d.gap_kg)}</td>
          <td class="num" style="font-weight:700;color:${d.pct >= 95 ? "#16a34a" : d.pct > 0 ? "#d97706" : "#dc2626"}">${d.pct}%</td>
        </tr>`;
      })
      .join("");
  }

  function renderUrgencyTable(urgency) {
    if (urgency) urgencyData = urgency;
    const NUM_COLS = new Set(["rank", "planned_kg", "delivered_kg", "pct"]);
    const sorted = urgencyData.slice().sort((a, b) => {
      let va = a[urgSortCol], vb = b[urgSortCol];
      if (NUM_COLS.has(urgSortCol)) { va = Number(va) || 0; vb = Number(vb) || 0; }
      else { va = String(va || "").toLowerCase(); vb = String(vb || "").toLowerCase(); }
      if (va < vb) return urgSortAsc ? -1 : 1;
      if (va > vb) return urgSortAsc ? 1 : -1;
      return 0;
    });
    // Update header active state
    $$("#urgency-thead th").forEach((th) => {
      th.classList.toggle("sort-active", th.dataset.col === urgSortCol);
      th.style.cursor = "pointer";
    });
    $("#urgency-body").innerHTML = sorted
      .map((d, i) => {
        const rank = i + 1;
        return `<tr>
        <td class="num" style="font-weight:700;color:${rank <= 3 ? "#dc2626" : rank <= 10 ? "#d97706" : "#64748b"}">${rank}</td>
        <td style="font-weight:600">${esc(d.district)}</td>
        <td>${esc(d.province)}</td>
        <td class="num">${fmtDec(d.planned_kg)}</td>
        <td class="num">${fmtDec(d.delivered_kg)}</td>
        <td class="num" style="font-weight:700;color:${d.pct >= 95 ? "#16a34a" : d.pct > 0 ? "#d97706" : "#dc2626"}">${d.pct}%</td>
        <td class="num">${pvdStatusBadge(d.status)}</td>
      </tr>`;
      })
      .join("");
  }

  function renderSupplierPerf(suppliers) {
    const maxKg = Math.max(...suppliers.map((s) => s.total_kg), 1);
    $("#supplier-perf").innerHTML = suppliers
      .map((s, i) => `<div class="supplier-card">
        <div class="supplier-rank">${i + 1}</div>
        <div class="supplier-info">
          <div class="supplier-name">${esc(s.supplier)}</div>
          <div class="supplier-stats">${fmt(s.deliveries)} entregas | ${fmt(s.districts)} distritos | ${fmtDec(s.total_kg)} kg</div>
        </div>
        <div class="supplier-bar"><div class="supplier-bar-fill" style="width:${(s.total_kg / maxKg * 100)}%"></div></div>
      </div>`)
      .join("");
  }

  // renderProgressChart() removed — Progresso Diario chart was deleted

  // ── Planned vs Delivered ─────────────────────────────────────
  let chartPvdDistrict = null;
  let chartPvdProduct = null;
  let pvdData = null;
  let pvdSearchTerm = "";
  let pvdSortCol = "planned_kg";
  let pvdSortAsc = false;

  async function loadPvD() {
    try {
      const params = new URLSearchParams();
      const prov = fProvince.value;
      const dist = fDistrict.value;
      const prod = fProduct.value;
      if (prov) params.set("province", prov);
      if (dist) params.set("district", dist);
      if (prod && prod !== "__seeds__") params.set("product", prod);
      if (prod === "__seeds__") params.set("seeds_only", "1");
      if (IS_OLD) params.set("old", "1");
      const qs = params.toString();
      const res = await fetch("/api/planned-vs-delivered" + (qs ? "?" + qs : ""));
      if (!res.ok) return;
      pvdData = await res.json();
      renderPvD();
    } catch (e) {
      console.error("PvD load error:", e);
    }
  }

  function renderPvD() {
    if (!pvdData) return;
    const t = pvdData.totals;

    // Re-render the district delivery chart so its tooltip can show
    // planned/delivered/% per product (depends on pvdData being loaded)
    if (typeof renderDistrictChart === "function") renderDistrictChart();

    // Update urgency table from PvD data (respects product/seeds filter)
    if (pvdData.by_district) {
      const urgency = pvdData.by_district
        .filter((d) => d.pct < 100)
        .sort((a, b) => a.pct - b.pct)
        .map((d, i) => ({ ...d, rank: i + 1 }));
      renderUrgencyTable(urgency);

      // Build province ranking by aggregating districts
      const provMap = {};
      pvdData.by_district.forEach((d) => {
        const p = d.province || "N/A";
        if (!provMap[p]) provMap[p] = { province: p, planned_kg: 0, delivered_kg: 0 };
        provMap[p].planned_kg += d.planned_kg;
        provMap[p].delivered_kg += d.delivered_kg;
      });
      const provRank = Object.values(provMap).map((p) => ({
        ...p,
        gap_kg: Math.max(0, p.planned_kg - p.delivered_kg),
        pct: p.planned_kg > 0 ? Math.round((p.delivered_kg / p.planned_kg) * 1000) / 10 : 0,
      }));
      renderProvRankTable(provRank);
    }

    // Cards — quando o filtro de produto é Sacos Hermeticos, mostrar
    // valores em UNIDADES (que é como sacos são contados no terreno).
    // Caso contrário, mostrar em kg (incluindo sacos convertidos a 0.145).
    const productFilterCard = fProduct.value;
    const filterIsSacosCard = /saco|hermetic/i.test(String(productFilterCard || ""));
    const plannedUnit = $("#pvd-planned-unit");
    const deliveredUnit = $("#pvd-delivered-unit");
    if (filterIsSacosCard) {
      $("#pvd-planned").textContent = fmt(Math.round((t.planned_kg || 0) / SACO_KG_PER_UNIT));
      $("#pvd-delivered").textContent = fmt(Math.round((t.delivered_kg || 0) / SACO_KG_PER_UNIT));
      if (plannedUnit) plannedUnit.textContent = "un";
      if (deliveredUnit) deliveredUnit.textContent = "un";
    } else {
      $("#pvd-planned").textContent = fmtDec(t.planned_kg);
      $("#pvd-delivered").textContent = fmtDec(t.delivered_kg);
      if (plannedUnit) plannedUnit.textContent = "kg";
      if (deliveredUnit) deliveredUnit.textContent = "kg";
    }
    $("#pvd-pct").textContent = t.pct + "%";
    $("#pvd-progress-bar").style.width = Math.min(t.pct, 100) + "%";

    // Seeds-only sub-bar (always Milho + Feijao + Arroz, ignores product filter)
    const seeds = pvdData.totals_seeds;
    if (seeds) {
      $("#pvd-seeds-pct").textContent = seeds.pct + "%";
      $("#pvd-seeds-bar").style.width = Math.min(seeds.pct, 100) + "%";
    }

    // Scope label (province/district/product filters)
    const scopeParts = [];
    if (fProduct.value) scopeParts.push(fProduct.value);
    if (fDistrict.value) scopeParts.push(fDistrict.value);
    if (fProvince.value) scopeParts.push(fProvince.value);
    const scopeEl = $("#pvd-pct-scope");
    if (scopeEl) {
      scopeEl.textContent = scopeParts.length > 0
        ? "(" + scopeParts.join(" / ") + ")"
        : "(global)";
    }

    // Populate chart province filter
    const provs = [...new Set(pvdData.by_district.map((d) => d.province).filter(Boolean))].sort();
    const provSel = $("#pvd-chart-province");
    const curProv = provSel.value;
    provSel.innerHTML = '<option value="">Todas Provincias</option>' +
      provs.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    if (provs.includes(curProv)) provSel.value = curProv;

    // Update top gap card — tudo em kg (sacos já convertidos 0.145 kg/un).
    // Se o filtro activo for sacos, mostrar o card em unidades para coerência.
    const gap = Math.max(0, t.planned_kg - t.delivered_kg);
    const productFilterG = fProduct.value;
    const filterIsSacosG = /saco|hermetic/i.test(String(productFilterG || ""));
    const gapLabel = $("#m-gap-label");
    if (filterIsSacosG) {
      if (gapLabel) gapLabel.textContent = "Falta Entregar (un)";
      $("#m-gap").textContent = fmt(Math.round(gap / SACO_KG_PER_UNIT));
    } else {
      if (gapLabel) gapLabel.textContent = "Falta Entregar (kg)";
      $("#m-gap").textContent = fmtDec(gap);
    }

    const categories = { "Sementes (kg)": 0, "Químicos (kg)": 0, "Sacos (un)": 0, "Outros (kg)": 0 };
    (pvdData.by_product || []).forEach((p) => {
      const g = Math.max(0, (p.planned_kg || 0) - (p.delivered_kg || 0));
      if (g <= 0.5) return;
      const name = String(p.product || p.product_plan || "").toLowerCase();
      if (/milho|feij|arroz|maize|bean|rice|sementes?|seed/.test(name)) categories["Sementes (kg)"] += g;
      else if (/emamectin|imidaclop|mcpa|qu[ií]m|chem/.test(name)) categories["Químicos (kg)"] += g;
      else if (/saco|hermetic/.test(name)) categories["Sacos (un)"] += g / SACO_KG_PER_UNIT; // back to units for display
      else categories["Outros (kg)"] += g;
    });
    const bd = $("#m-gap-breakdown");
    if (bd) {
      const entries = Object.entries(categories).filter(([, v]) => v > 0.5);
      bd.innerHTML = entries.length
        ? entries.map(([k, v]) => {
            const isSacos = k.startsWith("Sacos");
            const value = isSacos ? fmt(Math.round(v)) : fmtDec(v);
            return `<div class="bd-row"><span class="bd-k">${k}</span><span class="bd-v">${value}</span></div>`;
          }).join("")
        : "";
    }

    // Charts
    renderPvdDistrictChart();
    renderPvdProductChart();
    renderPvdTable();
  }

  function renderPvdDistrictChart() {
    const provFilter = ($("#pvd-chart-province") || {}).value || "";
    let all = pvdData.by_district.filter((d) => d.planned_kg > 0);
    if (provFilter) all = all.filter((d) => d.province === provFilter);
    const items = all.slice(0, 20);
    const labels = items.map((d) => d.district);

    if (chartPvdDistrict) chartPvdDistrict.destroy();
    chartPvdDistrict = new Chart($("#chart-pvd-district"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Planeado (kg)", data: items.map((d) => d.planned_kg), backgroundColor: "rgba(15,76,117,.7)", borderRadius: 4 },
          { label: "Entregue (kg)", data: items.map((d) => d.delivered_kg), backgroundColor: "rgba(27,122,90,.8)", borderRadius: 4 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", labels: { boxWidth: 12, font: { size: 10 } } },
          tooltip: {
            callbacks: {
              afterBody: () => "Sacos hermeticos: convertidos a 0.145 kg/un",
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 45 } },
          y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } },
        },
      },
    });
  }

  function renderPvdProductChart() {
    const items = pvdData.by_product;
    // Para sacos hermeticos: converte valores kg → un (cada linha eh um produto
    // separado, portanto nao ha problema de mistura de unidades no eixo X).
    // Cada item armazena os valores de DISPLAY (un para sacos, kg para outros).
    const displayItems = items.map((p) => {
      const planned = displayQty(p.planned_kg, p.product);
      const delivered = displayQty(p.delivered_kg, p.product);
      return {
        product: labelWithUnit(p.product),
        raw_product: p.product,
        unit: planned.unit,
        planned_display: planned.value,
        delivered_display: delivered.value,
        // Preserva os kg originais para o calculo de %
        planned_raw_kg: p.planned_kg,
        delivered_raw_kg: p.delivered_kg,
      };
    });
    const labels = displayItems.map((p) => p.product);
    // Build "Entregue (X%)" labels with the execution % per product
    const deliveredLabels = displayItems.map((p) => {
      const pct = p.planned_raw_kg > 0 ? (p.delivered_raw_kg / p.planned_raw_kg * 100) : 0;
      return pct.toFixed(1) + "%";
    });

    if (chartPvdProduct) chartPvdProduct.destroy();
    chartPvdProduct = new Chart($("#chart-pvd-product"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Planeado", data: displayItems.map((p) => p.planned_display), backgroundColor: "rgba(15,76,117,.7)", borderRadius: 4 },
          { label: "Entregue", data: displayItems.map((p) => p.delivered_display), backgroundColor: "rgba(27,122,90,.8)", borderRadius: 4,
            _pctLabels: deliveredLabels },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", labels: { boxWidth: 12, font: { size: 10 } } },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                const p = displayItems[ctx.dataIndex];
                const val = ctx.parsed.x;
                const base = ctx.dataset.label + ": " + Number(val).toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + " " + p.unit;
                if (ctx.datasetIndex === 1) {
                  const pct = p.planned_raw_kg > 0 ? (p.delivered_raw_kg / p.planned_raw_kg * 100) : 0;
                  return base + "  (" + pct.toFixed(1) + "% do planeado)";
                }
                return base;
              }
            }
          }
        },
        scales: {
          x: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } },
          y: { grid: { display: false }, ticks: { font: { size: 10 } } },
        },
        animation: {
          onComplete: function () {
            const chart = this;
            const ctx = chart.ctx;
            const ds = chart.data.datasets[1];
            const meta = chart.getDatasetMeta(1);
            ctx.save();
            ctx.font = "bold 10px -apple-system, sans-serif";
            ctx.fillStyle = "#fff";
            ctx.textAlign = "right";
            ctx.textBaseline = "middle";
            meta.data.forEach((bar, i) => {
              const pct = deliveredLabels[i];
              const val = ds.data[i];
              if (val > 0) {
                ctx.fillText(pct, bar.x - 4, bar.y);
              } else {
                ctx.fillStyle = "#94a3b8";
                ctx.fillText(pct, bar.base + 30, bar.y);
                ctx.fillStyle = "#fff";
              }
            });
            ctx.restore();
          }
        }
      },
    });
  }

  function pvdStatusBadge(status) {
    if (status === "Completo") return '<span class="badge badge-complete">Completo</span>';
    if (status === "Em progresso") return '<span class="badge badge-progress">Em progresso</span>';
    if (status === "Sem entregas") return '<span class="badge badge-none">Sem entregas</span>';
    return esc(status);
  }

  const PVD_PAGE_SIZE = 20;
  let pvdPage = 1;

  function getPvdFilteredRows() {
    let rows = pvdData ? pvdData.details.slice() : [];
    const statusFilter = ($("#pvd-f-status") || {}).value || "";
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    if (pvdSearchTerm) {
      const q = pvdSearchTerm.toLowerCase();
      rows = rows.filter((r) => (r.district + " " + r.product + " " + r.province).toLowerCase().includes(q));
    }
    rows.sort((a, b) => {
      let va = a[pvdSortCol] ?? "";
      let vb = b[pvdSortCol] ?? "";
      if (typeof va === "number") {
        if (va < vb) return pvdSortAsc ? -1 : 1;
        if (va > vb) return pvdSortAsc ? 1 : -1;
        return 0;
      }
      return pvdSortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
    return rows;
  }

  function renderPvdTable() {
    const rows = getPvdFilteredRows();
    const totalPages = Math.max(1, Math.ceil(rows.length / PVD_PAGE_SIZE));
    if (pvdPage > totalPages) pvdPage = totalPages;
    const start = (pvdPage - 1) * PVD_PAGE_SIZE;
    const page = rows.slice(start, start + PVD_PAGE_SIZE);

    $("#pvd-table-body").innerHTML = page
      .map((r) => {
        const isSacos = /saco|hermetic/i.test(String(r.product || ""));
        // For sacos, display in units (kg / SACO_KG_PER_UNIT). For everything else, kg.
        const displayVal = (kg) => isSacos
          ? `${fmt(Math.round(kg / SACO_KG_PER_UNIT))} <span class="bd-unit">un</span>`
          : fmtDec(kg);
        const diffSign = r.diff > 0 ? "+" : r.diff < 0 ? "-" : "";
        const diffAbs = Math.abs(r.diff);
        const diffHtml = isSacos
          ? `${diffSign}${fmt(Math.round(diffAbs / SACO_KG_PER_UNIT))} <span class="bd-unit">un</span>`
          : `${diffSign}${fmtDec(diffAbs)}`;
        return `<tr>
          <td>${esc(r.district)}</td>
          <td>${esc(r.province)}</td>
          <td>${esc(r.product)}</td>
          <td class="num">${displayVal(r.planned_kg)}</td>
          <td class="num">${displayVal(r.delivered_kg)}</td>
          <td class="num" style="color:${r.diff < 0 ? "#dc2626" : r.diff > 0 ? "#16a34a" : "#64748b"};font-weight:600">${diffHtml}</td>
          <td class="num" style="font-weight:700;color:${r.pct >= 95 ? "#16a34a" : r.pct > 0 ? "#d97706" : "#dc2626"}">
            ${r.pct}%
          </td>
          <td class="num">${pvdStatusBadge(r.status)}</td>
        </tr>`;
      })
      .join("");

    // Pagination
    const pagEl = $("#pvd-pagination");
    let html = `<button ${pvdPage <= 1 ? "disabled" : ""} data-p="${pvdPage - 1}">&laquo;</button>`;
    for (let i = 1; i <= Math.min(totalPages, 7); i++) {
      html += `<button class="${i === pvdPage ? "active" : ""}" data-p="${i}">${i}</button>`;
    }
    if (totalPages > 7) html += `<span class="page-info">…${totalPages}</span>`;
    html += `<button ${pvdPage >= totalPages ? "disabled" : ""} data-p="${pvdPage + 1}">&raquo;</button>`;
    html += `<span class="page-info">${rows.length} linhas</span>`;
    pagEl.innerHTML = html;
  }

  // ── History / Snapshot navigation ───────────────────────────
  async function loadSnapshotList() {
    try {
      const res = await fetch("/api/snapshots");
      const list = await res.json();
      const sel = $("#history-select");
      // Keep "live" option, remove old snapshot options
      sel.innerHTML = '<option value="live">Hoje (live)</option>';
      list.forEach((s) => {
        const parts = s.date.split("-");
        const label = `${parts[2]}/${parts[1]}/${parts[0]}`;
        const extra = `${s.total} reg, ${s.verified} verif`;
        const opt = document.createElement("option");
        opt.value = s.date;
        opt.textContent = `${label}  (${extra})`;
        sel.appendChild(opt);
      });
    } catch (e) {
      console.error("Failed to load snapshots:", e);
    }
  }

  async function loadSnapshot(date) {
    showLoading(true);
    try {
      const res = await fetch("/api/snapshots/" + date);
      if (!res.ok) throw new Error("Snapshot not found");
      const json = await res.json();
      allRows = json.rows || [];
      historyMode = true;

      // Update UI for history mode
      const parts = date.split("-");
      const label = `${parts[2]}/${parts[1]}/${parts[0]}`;
      $("#history-date-label").textContent = label;
      $("#history-banner").style.display = "flex";
      $("#btn-refresh").disabled = true;
      $("#btn-refresh").style.opacity = "0.4";
      if (countdownTimer) clearInterval(countdownTimer);
      elCountdown.textContent = "Modo historico";
      elLastUpdated.textContent = "Snapshot de " + label;

      populateFilters();
      applyFilters();
      if (!IS_PUBLIC) runVerification();
    } catch (e) {
      console.error("Snapshot load error:", e);
    } finally {
      showLoading(false);
    }
  }

  async function backToLive() {
    historyMode = false;
    $("#history-banner").style.display = "none";
    $("#history-select").value = "live";
    $("#btn-refresh").disabled = false;
    $("#btn-refresh").style.opacity = "1";
    await fetchData(true);
    if (!IS_PUBLIC) runVerification();
  }

  // ── Event Listeners ─────────────────────────────────────────
  function init() {
    // Refresh button
    $("#btn-refresh").addEventListener("click", () => fetchData(true).then(() => {
      if (!IS_PUBLIC) runVerification();
    }));

    // Save snapshot
    $("#btn-save-snapshot").addEventListener("click", async () => {
      const btn = $("#btn-save-snapshot");
      btn.disabled = true;
      btn.textContent = "A guardar...";
      try {
        const res = await fetch("/api/snapshots/save-now", { method: "POST" });
        const json = await res.json();
        if (json.saved) {
          btn.innerHTML = "&#10003; Guardado";
          btn.classList.add("saved");
          loadSnapshotList();
          setTimeout(() => {
            btn.disabled = false;
            btn.classList.remove("saved");
            btn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" style="vertical-align:-2px;margin-right:3px"><path d="M15.988 3.012A2.25 2.25 0 0118 5.25v9.5A2.25 2.25 0 0115.75 17h-11.5A2.25 2.25 0 012 14.75v-9.5A2.25 2.25 0 014.012 3.012L4.25 3h11.5l.238.012zM6 3.5v3.25c0 .414.336.75.75.75h6.5a.75.75 0 00.75-.75V3.5H6zm4 8a2 2 0 100 4 2 2 0 000-4z"/></svg> Guardar';
          }, 3000);
        }
      } catch (e) {
        console.error("Save snapshot error:", e);
        btn.textContent = "Erro!";
        setTimeout(() => { btn.disabled = false; btn.textContent = "Guardar"; }, 2000);
      }
    });

    // Province ranking sort
    const provThead = $("#prov-rank-thead");
    if (provThead) provThead.addEventListener("click", (e) => {
      const th = e.target.closest("th");
      if (!th || !th.dataset.col) return;
      const col = th.dataset.col;
      if (provSortCol === col) provSortAsc = !provSortAsc;
      else { provSortCol = col; provSortAsc = col === "province"; }
      renderProvRankTable();
    });

    // Urgency table sort
    const urgThead = $("#urgency-thead");
    if (urgThead) urgThead.addEventListener("click", (e) => {
      const th = e.target.closest("th");
      if (!th || !th.dataset.col) return;
      const col = th.dataset.col;
      if (urgSortCol === col) urgSortAsc = !urgSortAsc;
      else { urgSortCol = col; urgSortAsc = true; }
      renderUrgencyTable();
    });

    // Filters
    fProvince.addEventListener("change", () => {
      updateDistrictOptions();
      applyFilters();
    });
    fDistrict.addEventListener("change", applyFilters);
    fStatus.addEventListener("change", applyFilters);
    fSupplier.addEventListener("change", applyFilters);
    fProduct.addEventListener("change", applyFilters);
    fSearch.addEventListener("input", applyFilters);
    $("#btn-clear-filters").addEventListener("click", clearFilters);

    // Column picker
    $("#btn-columns-toggle").addEventListener("click", toggleColumnPicker);
    $("#btn-col-reset").addEventListener("click", resetColumns);

    // Close picker when clicking outside
    document.addEventListener("click", (e) => {
      const picker = $("#col-picker");
      if (picker.style.display !== "none" &&
          !e.target.closest("#col-picker") &&
          !e.target.closest("#btn-columns-toggle")) {
        picker.style.display = "none";
        $("#btn-columns-toggle").classList.remove("active");
      }
    });

    // Notes modal: open
    elTableBody.addEventListener("click", (e) => {
      const btn = e.target.closest(".notes-eye");
      if (!btn) return;
      try {
        const links = JSON.parse(decodeURIComponent(btn.dataset.links));
        openNotesModal(links);
      } catch (err) { console.error(err); }
    });

    // Pagination
    elPagination.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || btn.disabled) return;
      currentPage = Number(btn.dataset.page);
      renderTable();
    });

    // Export buttons
    $("#btn-export").addEventListener("click", exportTableExcel);
    $("#btn-export-full").addEventListener("click", exportFullReport);
    document.querySelectorAll(".btn-export-xs").forEach((btn) => {
      btn.addEventListener("click", () => exportSection(btn.dataset.export));
    });

    // Table search
    let searchDebounce = null;
    $("#table-search").addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        tableSearchTerm = e.target.value.trim();
        currentPage = 1;
        renderTable();
      }, 200);
    });
    $("#btn-clear-table-search").addEventListener("click", () => {
      $("#table-search").value = "";
      tableSearchTerm = "";
      currentPage = 1;
      renderTable();
      $("#table-search").focus();
    });

    // Timeline chart period filter
    function activateTimelinePreset(daysAttr) {
      tlState.mode = "preset";
      tlState.days = daysAttr === "all" ? "all" : Number(daysAttr);
      // Limpa datepickers (já não são o filtro activo)
      const fromEl = $("#tl-from"), toEl = $("#tl-to");
      if (fromEl) fromEl.value = "";
      if (toEl)   toEl.value   = "";
      // Visual: marca botão activo
      document.querySelectorAll("#timeline-filter .tl-preset").forEach((b) => {
        b.classList.toggle("active", b.dataset.days === String(daysAttr));
      });
      renderTimelineChart();
    }
    document.querySelectorAll("#timeline-filter .tl-preset").forEach((btn) => {
      btn.addEventListener("click", () => activateTimelinePreset(btn.dataset.days));
    });
    function applyCustomDates() {
      const from = ($("#tl-from") || {}).value || "";
      const to   = ($("#tl-to")   || {}).value || "";
      if (!from && !to) return;
      tlState.mode = "custom";
      tlState.from = from || null;
      tlState.to   = to   || null;
      // Tira destaque dos preset buttons
      document.querySelectorAll("#timeline-filter .tl-preset").forEach((b) => b.classList.remove("active"));
      renderTimelineChart();
    }
    if ($("#tl-from")) $("#tl-from").addEventListener("change", applyCustomDates);
    if ($("#tl-to"))   $("#tl-to").addEventListener("change", applyCustomDates);
    // Inicial: marca o "7 dias" como activo
    activateTimelinePreset("7");

    // Planned vs Delivered
    $("#pvd-chart-province").addEventListener("change", () => {
      if (pvdData) renderPvdDistrictChart();
    });
    $("#pvd-search").addEventListener("input", (e) => {
      pvdSearchTerm = e.target.value.trim();
      pvdPage = 1;
      renderPvdTable();
    });
    $("#pvd-f-status").addEventListener("change", () => {
      pvdPage = 1;
      renderPvdTable();
    });
    $("#pvd-pagination").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || btn.disabled) return;
      pvdPage = Number(btn.dataset.p);
      renderPvdTable();
    });
    $$("#pvd-table thead th").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.dataset.sort;
        if (!col) return;
        if (pvdSortCol === col) pvdSortAsc = !pvdSortAsc;
        else { pvdSortCol = col; pvdSortAsc = true; }
        renderPvdTable();
      });
    });
    $("#btn-export-pvd").addEventListener("click", () => {
      downloadBlob("/api/export/planeado-vs-entregue");
    });

    // History navigation
    $("#history-select").addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "live") backToLive();
      else loadSnapshot(val);
    });
    $("#btn-back-live").addEventListener("click", backToLive);

    // Verification
    $("#btn-run-verify").addEventListener("click", runVerification);

    // Weight section collapsible toggle
    $("#weight-toggle").addEventListener("click", (e) => {
      if (e.target.closest(".btn-export-xs")) return; // don't toggle on export click
      const body = $("#weight-body-wrap");
      const arrow = $("#weight-arrow");
      const open = body.style.display === "none";
      body.style.display = open ? "block" : "none";
      arrow.classList.toggle("open", open);
    });

    // Pattern (Malformed GTUs) section collapsible toggle
    const patternToggle = $("#pattern-toggle");
    if (patternToggle) patternToggle.addEventListener("click", (e) => {
      if (e.target.closest(".btn-export-xs")) return;
      const body = $("#pattern-body-wrap");
      const arrow = $("#pattern-arrow");
      if (!body || !arrow) return;
      const open = body.style.display === "none";
      body.style.display = open ? "block" : "none";
      arrow.classList.toggle("open", open);
    });

    // Public visitor view at "/" hides the error verification section.
    // Mirror of IS_PUBLIC defined at module scope (used by the auto-refresh
    // timer); kept locally for readability of the init() flow.
    const isPublic = IS_PUBLIC;

    // Adjust header subtitle + nav links based on current view
    const subtitle = $("#header-subtitle");
    const opsLink = $("#ops-link");
    const cardErrors = $("#card-errors");
    if (IS_OLD) {
      // Deprecated view — grey/amber style + banner warning user
      document.body.classList.add("view-old");
      if (subtitle) subtitle.textContent = "Plano Anterior (desactualizado)";
      if (opsLink) opsLink.style.display = "none";
      if (cardErrors) cardErrors.style.display = "none";
      const hl = document.querySelector(".header-left");
      if (hl && !document.getElementById("back-current-link")) {
        const a = document.createElement("a");
        a.id = "back-current-link";
        a.href = "/";
        a.className = "header-nav-link";
        a.textContent = "← Plano Actual";
        hl.appendChild(a);
      }
      const t = document.querySelector("h1.logo");
      if (t && !t.dataset.oldAdded) {
        const badge = document.createElement("span");
        badge.id = "old-badge";
        badge.textContent = "ANTERIOR";
        t.appendChild(badge);
        t.dataset.oldAdded = "1";
      }
      document.title = "AQI Control File — Plano Anterior";
    } else if (isPublic) {
      // Default view — uses the UPDATED plan
      if (subtitle) subtitle.textContent = "Delivery Monitoring Dashboard";
      if (opsLink) opsLink.style.display = "inline-block";
      if (cardErrors) cardErrors.style.display = "none";
      // Link to old/deprecated view
      const hl = document.querySelector(".header-left");
      if (hl && !document.getElementById("old-link")) {
        const a = document.createElement("a");
        a.id = "old-link";
        a.href = "/anterior";
        a.className = "header-nav-link header-nav-old";
        a.title = "Ver o plano anterior (desactualizado)";
        a.textContent = "📄 Plano Anterior";
        hl.appendChild(a);
      }
    } else {
      if (subtitle) subtitle.textContent = "Operacoes - Monitoria Interna";
      if (opsLink) opsLink.style.display = "none";
      if (cardErrors) cardErrors.style.display = "";
    }

    // ── Logistics control ──────────────────────────────────────
    const LOG_COLUMNS = [
      { key: "adsn",              label: "ADSN",             defaultOn: true,  type: "text" },
      { key: "gtu",               label: "GTU",              defaultOn: true,  type: "text" },
      { key: "destinatario",      label: "Destinatário",     defaultOn: true,  type: "text" },
      { key: "distrito",          label: "Distrito",         defaultOn: true,  type: "text" },
      { key: "provincia",         label: "Provincia",        defaultOn: true,  type: "text" },
      { key: "produto",           label: "Produto",          defaultOn: true,  type: "text" },
      { key: "peso",              label: "Peso (kg)",        defaultOn: true,  type: "number" },
      { key: "volumes",           label: "Volumes",          defaultOn: false, type: "number" },
      { key: "matricula",         label: "Matrícula",        defaultOn: true,  type: "text" },
      { key: "origem",            label: "Origem",           defaultOn: false, type: "text" },
      { key: "estado_logistico",  label: "Estado Log.",      defaultOn: true,  type: "badge_log" },
      { key: "qtd_entregue",      label: "Qtd Entregue",     defaultOn: false, type: "number" },
      { key: "verificacao",       label: "Verificação",      defaultOn: true,  type: "badge_verif" },
    ];
    let logisticsData = null;
    let logisticsTab = "por_fechar";
    let logVisibleCols = LOG_COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);
    let logSortCol = "gtu";
    let logSortAsc = true;
    let logPage = 1;
    const LOG_PAGE_SIZE = 20;

    function getLogColDef(key) { return LOG_COLUMNS.find((c) => c.key === key); }

    const logFileInput = $("#logistics-file");
    if (logFileInput) {
      logFileInput.addEventListener("change", async () => {
        if (!logFileInput.files.length) return;
        await loadLogistics();
      });
    }
    $$(".log-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        logisticsTab = btn.dataset.tab;
        logPage = 1;
        $$(".log-tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderLogisticsTable();
      });
    });
    const btnExportLog = $("#btn-export-logistics");
    if (btnExportLog) btnExportLog.addEventListener("click", exportLogisticsExcel);

    // Column picker toggle
    const btnLogCols = $("#btn-log-columns");
    const logColPicker = $("#log-col-picker");
    if (btnLogCols && logColPicker) {
      btnLogCols.addEventListener("click", (e) => {
        e.stopPropagation();
        logColPicker.style.display = logColPicker.style.display === "none" ? "" : "none";
        if (logColPicker.style.display !== "none") renderLogColPicker();
      });
      document.addEventListener("click", (e) => {
        if (!logColPicker.contains(e.target) && e.target !== btnLogCols) logColPicker.style.display = "none";
      });
      const resetBtn = $("#btn-log-col-reset");
      if (resetBtn) resetBtn.addEventListener("click", () => {
        logVisibleCols = LOG_COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);
        renderLogColPicker();
        renderLogisticsHeader();
        renderLogisticsTable();
      });
    }

    // Sort on header click
    const logThead = $("#logistics-thead-row");
    if (logThead) logThead.addEventListener("click", (e) => {
      const th = e.target.closest("th");
      if (!th || !th.dataset.col) return;
      const col = th.dataset.col;
      if (logSortCol === col) logSortAsc = !logSortAsc;
      else { logSortCol = col; logSortAsc = true; }
      renderLogisticsTable();
    });

    // Pagination
    const logPagEl = $("#log-pagination");
    if (logPagEl) logPagEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || btn.disabled) return;
      logPage = Number(btn.dataset.page);
      renderLogisticsTable();
    });

    function renderLogColPicker() {
      const list = $("#log-col-picker-list");
      if (!list) return;
      list.innerHTML = LOG_COLUMNS.map((col) => {
        const on = logVisibleCols.includes(col.key);
        return '<label class="col-chip ' + (on ? "on" : "") + '" data-key="' + col.key + '"><span class="col-chip-dot"></span>' + esc(col.label) + '</label>';
      }).join("");
      list.querySelectorAll(".col-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const k = chip.dataset.key;
          if (logVisibleCols.includes(k)) logVisibleCols = logVisibleCols.filter((c) => c !== k);
          else logVisibleCols.push(k);
          chip.classList.toggle("on");
          renderLogisticsHeader();
          renderLogisticsTable();
        });
      });
    }

    function renderLogisticsHeader() {
      if (!logThead) return;
      logThead.innerHTML = logVisibleCols.map((key) => {
        const col = getLogColDef(key);
        if (!col) return "";
        const classes = [];
        if (logSortCol === key) classes.push("sort-active");
        if (col.type === "number" || col.type === "badge_log" || col.type === "badge_verif") classes.push("num");
        return '<th data-col="' + key + '" class="' + classes.join(" ") + '">' + esc(col.label) + ' \u25B4\u25BE</th>';
      }).join("");
    }

    async function loadLogistics() {
      try {
        const res = await fetch("/api/logistics/compare");
        if (!res.ok) { alert("Erro ao carregar dados logísticos"); return; }
        logisticsData = await res.json();
        renderLogistics();
      } catch (e) { console.error(e); alert("Erro: " + e.message); }
    }

    function renderLogistics() {
      if (!logisticsData) return;
      const s = logisticsData.summary;
      $("#logistics-empty").style.display = "none";
      $("#logistics-content").style.display = "";
      $("#btn-export-logistics").style.display = "";

      const fmtP = (n) => Number(n).toLocaleString("pt-PT", { maximumFractionDigits: 0 }) + " kg";
      $("#log-concluidos").textContent = s.concluidos.toLocaleString("pt-PT");
      $("#log-peso-concluidos").textContent = fmtP(s.peso_concluidos);
      $("#log-por-fechar").textContent = s.por_fechar.toLocaleString("pt-PT");
      $("#log-peso-por-fechar").textContent = fmtP(s.peso_por_fechar);
      $("#log-transito").textContent = s.em_transito.toLocaleString("pt-PT");
      $("#log-peso-transito").textContent = fmtP(s.peso_em_transito);
      $("#log-sem-entrega").textContent = s.sem_entrega.toLocaleString("pt-PT");
      $("#log-peso-sem-entrega").textContent = fmtP(s.peso_sem_entrega);
      $("#log-tab-fechar-n").textContent = s.por_fechar;
      $("#log-tab-concluidos-n").textContent = s.concluidos;
      $("#log-tab-sem-n").textContent = s.sem_entrega;
      $("#log-tab-transito-n").textContent = s.em_transito;
      $("#log-tab-scresp-n").textContent = s.sem_correspondencia;

      renderLogisticsHeader();
      renderLogisticsTable();
    }

    function renderLogisticsTable() {
      if (!logisticsData) return;
      const rows = (logisticsData[logisticsTab] || []).slice();
      const body = $("#logistics-body");
      const colCount = logVisibleCols.length;

      // Sort
      rows.sort((a, b) => {
        let va = a[logSortCol], vb = b[logSortCol];
        const col = getLogColDef(logSortCol);
        if (col && col.type === "number") { va = Number(va) || 0; vb = Number(vb) || 0; }
        else { va = String(va || "").toLowerCase(); vb = String(vb || "").toLowerCase(); }
        if (va < vb) return logSortAsc ? -1 : 1;
        if (va > vb) return logSortAsc ? 1 : -1;
        return 0;
      });

      // Pagination
      const totalPages = Math.max(1, Math.ceil(rows.length / LOG_PAGE_SIZE));
      if (logPage > totalPages) logPage = totalPages;
      const start = (logPage - 1) * LOG_PAGE_SIZE;
      const page = rows.slice(start, start + LOG_PAGE_SIZE);

      if (!page.length) {
        body.innerHTML = '<tr><td colspan="' + colCount + '" style="text-align:center;color:#94a3b8;padding:1.5rem">Sem registos</td></tr>';
        renderLogPagination(0);
        return;
      }

      body.innerHTML = page.map((r) => {
        return "<tr>" + logVisibleCols.map((key) => {
          const col = getLogColDef(key);
          if (!col) return "<td></td>";
          const raw = r[key];
          if (col.type === "number") {
            return '<td style="text-align:right">' + Number(raw || 0).toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + '</td>';
          }
          if (col.type === "badge_log") {
            const bg = raw === "FINALIZADO" ? "#dcfce7" : raw === "TRANSITO" ? "#fef3c7" : "#f1f5f9";
            const color = raw === "FINALIZADO" ? "#166534" : raw === "TRANSITO" ? "#92400e" : "#64748b";
            return '<td><span style="font-size:.72rem;padding:.15rem .45rem;border-radius:6px;background:' + bg + ';color:' + color + '">' + esc(raw || "") + '</span></td>';
          }
          if (col.type === "badge_verif") {
            if (!raw) return "<td>—</td>";
            const bg2 = raw === "Verified" ? "#dcfce7;color:#166534" : "#fef3c7;color:#92400e";
            return '<td><span style="font-size:.72rem;padding:.15rem .45rem;border-radius:6px;background:' + bg2 + '">' + esc(raw) + '</span></td>';
          }
          const style = key === "gtu" || key === "adsn" ? ' style="font-family:monospace;font-size:.78rem"' : "";
          return "<td" + style + ">" + esc(String(raw || "")) + "</td>";
        }).join("") + "</tr>";
      }).join("");

      renderLogPagination(rows.length);
    }

    function renderLogPagination(total) {
      if (!logPagEl) return;
      const totalPages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
      if (totalPages <= 1) { logPagEl.innerHTML = ""; return; }
      let html = '<button data-page="' + (logPage - 1) + '"' + (logPage <= 1 ? " disabled" : "") + '>&laquo;</button>';
      const start = Math.max(1, logPage - 2);
      const end = Math.min(totalPages, logPage + 2);
      for (let p = start; p <= end; p++) {
        html += '<button data-page="' + p + '"' + (p === logPage ? ' class="active"' : '') + '>' + p + '</button>';
      }
      html += '<button data-page="' + (logPage + 1) + '"' + (logPage >= totalPages ? " disabled" : "") + '>&raquo;</button>';
      html += '<span style="font-size:.75rem;color:#64748b;margin-left:.5rem">' + total + ' registos</span>';
      logPagEl.innerHTML = html;
    }

    function exportLogisticsExcel() {
      if (!logisticsData) return;
      const data = logisticsData.all || [];
      const csvRows = [["ADSN","GTU","Estado Logístico","Entregue no Dashboard","Destinatário","Provincia","Distrito","Produto","Peso (kg)","Volumes","Matrícula","Origem","Qtd Entregue","Verificação"]];
      data.forEach((r) => {
        csvRows.push([r.adsn, r.gtu, r.estado_logistico, r.entregue_dashboard ? "SIM" : "NÃO", r.destinatario,
          r.provincia, r.distrito, r.produto, r.peso, r.volumes, r.matricula, r.origem, r.qtd_entregue, r.verificacao]);
      });
      const csv = csvRows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "controlo_logistico_" + new Date().toISOString().slice(0, 10) + ".csv";
      a.click();
    }

    // Show verify section and auto-run on first load
    loadPlanningGeography().then(() => fetchData(false)).then(() => {
      if (!isPublic) {
        $("#verify-section").style.display = "block";
        runVerification();
      } else {
        // Hide verification-related UI on the public homepage
        const vs = $("#verify-section");
        if (vs) vs.style.display = "none";
      }
      loadSnapshotList();
      loadPvD();
      loadAnalytics();
      loadLogistics();
      loadUpdatesSummary();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
