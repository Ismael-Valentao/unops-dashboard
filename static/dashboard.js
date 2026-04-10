/* ── AQI Delivery Dashboard – Frontend Logic ──────────────── */

(function () {
  "use strict";

  const REFRESH_INTERVAL = 5 * 60; // 5 minutes in seconds
  const PAGE_SIZE = 20;

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
    { key: "delivery_note_number", label: "GTU",                 defaultOn: true,  type: "text"   },
    { key: "beneficiary_name",     label: "Beneficiario",        defaultOn: true,  type: "text"   },
    { key: "supplier",             label: "Fornecedor",          defaultOn: false, type: "text"   },
    { key: "province",             label: "Provincia",           defaultOn: true,  type: "text"   },
    { key: "district",             label: "Distrito",            defaultOn: true,  type: "text"   },
    { key: "beneficiary_id",       label: "Benef. ID",           defaultOn: false, type: "text"   },
    { key: "product",              label: "Produto",             defaultOn: true,  type: "text"   },
    { key: "product_unit",         label: "Unidade",             defaultOn: false, type: "text"   },
    { key: "delivered_qty",        label: "Qtd. Entregue",       defaultOn: true,  type: "number" },
    { key: "packages",             label: "Pacotes",             defaultOn: true,  type: "number" },
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
        fetchData(true).then(() => { runVerification(); loadSnapshotList(); });
        return;
      }
      const m = Math.floor(countdown / 60);
      const s = countdown % 60;
      elCountdown.textContent =
        "Próxima actualização em " + m + ":" + String(s).padStart(2, "0");
    }, 1000);
  }

  // ── Filters ─────────────────────────────────────────────────
  function populateFilters() {
    const provinces = unique(allRows, "province");
    const suppliers = unique(allRows, "supplier");
    const products = unique(allRows, "product");
    fillSelect(fProvince, provinces, "Todas Províncias");
    fillSelect(fSupplier, suppliers, "Todos Fornecedores");
    fillSelect(fProduct, products, "Todos Produtos");
    updateDistrictOptions();
  }

  function updateDistrictOptions() {
    const prov = fProvince.value;
    const subset = prov ? allRows.filter((r) => r.province === prov) : allRows;
    const districts = unique(subset, "district");
    fillSelect(fDistrict, districts, "Todos Distritos");
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
      if (product && r.product !== product) return false;
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
    applyFilters();
  }

  // ── Metrics ─────────────────────────────────────────────────
  function renderMetrics() {
    const rows = filteredRows;
    const total = rows.length;
    const qty = rows.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);
    const pkgs = rows.reduce((s, r) => s + (Number(r.packages) || 0), 0);
    const verified = rows.filter(
      (r) => r.verification_status === "Verified"
    ).length;
    const pending = rows.filter(
      (r) => r.verification_status === "Pending Verification"
    ).length;
    const errors = rows.filter(
      (r) => r.verification_status === "#ERROR!"
    ).length;
    const pct = total > 0 ? ((verified / total) * 100).toFixed(1) : "0";

    $("#m-total").textContent = fmt(total);
    $("#m-qty").textContent = fmtDec(qty);
    $("#m-packages").textContent = fmt(pkgs);
    // Gap will be updated when PvD loads
    $("#m-verified-pct").textContent = pct + "%";
    $("#m-pending").textContent = fmt(pending);
    $("#m-errors").textContent = fmt(errors);
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
    const datasets = products.map((p, i) => ({
      label: p,
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
                  const planTxt = plan > 0 ? fmtNum(plan) : "?";
                  lines.push("  " + prod);
                  lines.push("    Planeado: " + planTxt + " kg");
                  lines.push("    Entregue: " + fmtNum(deliv) + " kg" +
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

  function renderTimelineChart() {
    // Stacked bars per day, one stack per product, value = delivered kg
    const dateProductMap = {}; // { iso: { product: kg } }
    const productSet = new Set();
    filteredRows.forEach((r) => {
      const d = r.delivery_date_iso || "";
      if (!d) return;
      const product = r.product || "Sem produto";
      const qty = Number(r.delivered_qty) || 0;
      if (!dateProductMap[d]) dateProductMap[d] = {};
      dateProductMap[d][product] = (dateProductMap[d][product] || 0) + qty;
      productSet.add(product);
    });

    const sortedDates = Object.keys(dateProductMap).sort();
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

    // Distinct color palette
    const palette = PRODUCT_PALETTE;
    const datasets = products.map((p, i) => ({
      label: p,
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
              footer: (items) => {
                const tot = items.reduce((s, it) => s + (Number(it.parsed.y) || 0), 0);
                return "Total: " + tot.toLocaleString("pt-PT") + " kg";
              },
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } },
          y: { stacked: true, beginAtZero: true, grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } },
            title: { display: true, text: "Quantidade (kg)", font: { size: 10 } } },
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

  function getTableSearchRows() {
    if (!tableSearchTerm) return filteredRows;
    const q = tableSearchTerm.toLowerCase();
    return filteredRows.filter((r) => {
      const hay = [
        r.delivery_id, r.beneficiary_name, r.province, r.district,
        r.product, r.delivery_note_number, r.submitted_by,
        r.verification_status, r.delivery_date,
        String(r.delivered_qty), String(r.packages),
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
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
        const active = sortCol === sk ? " sort-active" : "";
        return `<th data-col="${sk}" class="${active}">${esc(col.label)} \u25B4\u25BE</th>`;
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

  function renderTable() {
    renderTableHeader();
    const searchRows = getTableSearchRows();
    const start = (currentPage - 1) * PAGE_SIZE;
    const page = searchRows.slice(start, start + PAGE_SIZE);
    const q = tableSearchTerm;

    elTableBody.innerHTML = page
      .map((r) => {
        const cells = visibleCols
          .map((key) => {
            const col = getColDef(key);
            if (!col) return "<td></td>";
            const raw = r[key];
            if (col.type === "number") {
              return `<td style="text-align:right">${fmtDec(Number(raw) || 0)}</td>`;
            }
            if (col.type === "badge") {
              return `<td>${statusBadge(raw)}</td>`;
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
    if (s === "Pending Verification")
      return '<span class="badge badge-pending">Pending</span>';
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
    const payload = { columns: cols.map((c) => ({ key: c.key, label: c.label })) };
    downloadBlob("/api/export/tabela", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
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
    const duplicate_gtus = [];
    for (const [gtu, entries] of Object.entries(gtuMap)) {
      if (entries.length > 1) duplicate_gtus.push({ gtu, count: entries.length, entries });
    }
    const weight_mismatches = [];
    rows.forEach((r, i) => {
      if (r.packages <= 0) return;
      const match = UNITS.find((u) => Math.abs(r.delivered_qty - r.packages * u) < 0.01);
      if (!match) {
        const closest = UNITS.reduce((b, u) => { const d = Math.abs(r.delivered_qty - r.packages * u); return d < b.diff ? { unit: u, expected: r.packages * u, diff: d } : b; }, { unit: 0, expected: 0, diff: Infinity });
        weight_mismatches.push({ row: i + 2, delivery_id: r.delivery_id, gtu: r.delivery_note_number, beneficiary_name: r.beneficiary_name, district: r.district, product: r.product, packages: r.packages, delivered_qty: r.delivered_qty, closest_unit: closest.unit, expected_qty: closest.expected, difference: +(r.delivered_qty - closest.expected).toFixed(2) });
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

  function renderUrgencyTable(urgency) {
    const top = urgency.slice(0, 25);
    $("#urgency-body").innerHTML = top
      .map((d) => `<tr>
        <td style="font-weight:700;color:${d.rank <= 3 ? "#dc2626" : d.rank <= 10 ? "#d97706" : "#64748b"}">${d.rank}</td>
        <td style="font-weight:600">${esc(d.district)}</td>
        <td>${esc(d.province)}</td>
        <td style="text-align:right">${fmtDec(d.planned_kg)}</td>
        <td style="text-align:right">${fmtDec(d.delivered_kg)}</td>
        <td style="text-align:right;font-weight:700;color:${d.pct >= 95 ? "#16a34a" : d.pct > 0 ? "#d97706" : "#dc2626"}">${d.pct}%</td>
        <td>${pvdStatusBadge(d.status)}</td>
      </tr>`)
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
      if (prod) params.set("product", prod);
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

    // Cards
    $("#pvd-planned").textContent = fmtDec(t.planned_kg);
    $("#pvd-delivered").textContent = fmtDec(t.delivered_kg);
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

    // Update top gap card
    const gap = Math.max(0, t.planned_kg - t.delivered_kg);
    $("#m-gap").textContent = fmtDec(gap);

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
        plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 10 } } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 45 } },
          y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } } },
        },
      },
    });
  }

  function renderPvdProductChart() {
    const items = pvdData.by_product;
    const labels = items.map((p) => p.product);
    // Build "Entregue (X%)" labels with the execution % per product
    const deliveredLabels = items.map((p) => {
      const pct = p.planned_kg > 0 ? (p.delivered_kg / p.planned_kg * 100) : 0;
      return pct.toFixed(1) + "%";
    });

    if (chartPvdProduct) chartPvdProduct.destroy();
    chartPvdProduct = new Chart($("#chart-pvd-product"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Planeado (kg)", data: items.map((p) => p.planned_kg), backgroundColor: "rgba(15,76,117,.7)", borderRadius: 4 },
          { label: "Entregue (kg)", data: items.map((p) => p.delivered_kg), backgroundColor: "rgba(27,122,90,.8)", borderRadius: 4,
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
                const val = ctx.parsed.x;
                const base = ctx.dataset.label + ": " + Number(val).toLocaleString("pt-PT");
                if (ctx.datasetIndex === 1) {
                  const p = items[ctx.dataIndex];
                  const pct = p.planned_kg > 0 ? (p.delivered_kg / p.planned_kg * 100) : 0;
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
      .map(
        (r) => `<tr>
          <td>${esc(r.district)}</td>
          <td>${esc(r.province)}</td>
          <td>${esc(r.product)}</td>
          <td style="text-align:right">${fmtDec(r.planned_kg)}</td>
          <td style="text-align:right">${fmtDec(r.delivered_kg)}</td>
          <td style="text-align:right;color:${r.diff < 0 ? "#dc2626" : r.diff > 0 ? "#16a34a" : "#64748b"};font-weight:600">
            ${r.diff > 0 ? "+" : ""}${fmtDec(r.diff)}
          </td>
          <td style="text-align:right;font-weight:700;color:${r.pct >= 95 ? "#16a34a" : r.pct > 0 ? "#d97706" : "#dc2626"}">
            ${r.pct}%
          </td>
          <td>${pvdStatusBadge(r.status)}</td>
        </tr>`
      )
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
      runVerification();
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
    runVerification();
  }

  // ── Event Listeners ─────────────────────────────────────────
  function init() {
    // Refresh button
    $("#btn-refresh").addEventListener("click", () => fetchData(true).then(() => runVerification()));

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

    // Public visitor view at "/" hides the error verification section
    const isPublic = location.pathname === "/" || location.pathname === "";

    // Adjust header subtitle + nav links based on current view
    const subtitle = $("#header-subtitle");
    const opsLink = $("#ops-link");
    const cardErrors = $("#card-errors");
    if (isPublic) {
      if (subtitle) subtitle.textContent = "Delivery Monitoring Dashboard";
      // Show "Operations View" link for internal team
      if (opsLink) opsLink.style.display = "inline-block";
      // Hide error count card from public visitors
      if (cardErrors) cardErrors.style.display = "none";
    } else {
      if (subtitle) subtitle.textContent = "Operacoes - Monitoria Interna";
      // Hide "Operations View" since we're already there
      if (opsLink) opsLink.style.display = "none";
      if (cardErrors) cardErrors.style.display = "";
    }

    // Logistics control
    let logisticsData = null;
    let logisticsTab = "por_fechar";

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
        $$(".log-tab").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderLogisticsTable();
      });
    });
    const btnExportLog = $("#btn-export-logistics");
    if (btnExportLog) btnExportLog.addEventListener("click", exportLogisticsExcel);

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

      $("#log-total").textContent = s.total.toLocaleString("pt-PT");
      $("#log-matched").textContent = s.matched.toLocaleString("pt-PT");
      $("#log-transito").textContent = s.em_transito.toLocaleString("pt-PT");
      $("#log-sem-entrega").textContent = s.sem_entrega.toLocaleString("pt-PT");
      $("#log-tab-fechar-n").textContent = s.por_fechar;
      $("#log-tab-sem-n").textContent = s.sem_entrega;
      $("#log-tab-transito-n").textContent = s.em_transito;

      renderLogisticsTable();
    }

    function renderLogisticsTable() {
      if (!logisticsData) return;
      const rows = logisticsData[logisticsTab] || [];
      const body = $("#logistics-body");
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:1.5rem">Sem registos</td></tr>';
        return;
      }
      body.innerHTML = rows.map((r) => {
        const estadoBg = r.estado_logistico === "FINALIZADO" ? "#dcfce7" :
                         r.estado_logistico === "TRANSITO" ? "#fef3c7" : "#f1f5f9";
        const estadoColor = r.estado_logistico === "FINALIZADO" ? "#166534" :
                            r.estado_logistico === "TRANSITO" ? "#92400e" : "#64748b";
        const verifBadge = r.verificacao ? ('<span style="font-size:.72rem;padding:.15rem .45rem;border-radius:6px;background:' +
          (r.verificacao === "Verified" ? "#dcfce7;color:#166534" : "#fef3c7;color:#92400e") + '">' + esc(r.verificacao) + '</span>') : '—';
        return '<tr>' +
          '<td style="font-family:monospace;font-size:.78rem">' + esc(r.gtu) + '</td>' +
          '<td>' + esc(r.destinatario) + '</td>' +
          '<td>' + esc(r.distrito) + '</td>' +
          '<td>' + esc(r.provincia) + '</td>' +
          '<td>' + esc(r.produto) + '</td>' +
          '<td style="text-align:right">' + Number(r.peso).toLocaleString("pt-PT") + '</td>' +
          '<td style="font-size:.78rem">' + esc(r.matricula) + '</td>' +
          '<td><span style="font-size:.72rem;padding:.15rem .45rem;border-radius:6px;background:' + estadoBg + ';color:' + estadoColor + '">' + esc(r.estado_logistico) + '</span></td>' +
          '<td>' + verifBadge + '</td></tr>';
      }).join("");
    }

    function exportLogisticsExcel() {
      if (!logisticsData) return;
      const data = logisticsData.all || [];
      const csvRows = [["GTU","Estado Logístico","Entregue no Dashboard","Destinatário","Provincia","Distrito","Produto","Peso (kg)","Volumes","Matrícula","Origem","Qtd Entregue","Verificação"]];
      data.forEach((r) => {
        csvRows.push([r.gtu, r.estado_logistico, r.entregue_dashboard ? "SIM" : "NÃO", r.destinatario,
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
    fetchData(false).then(() => {
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
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
