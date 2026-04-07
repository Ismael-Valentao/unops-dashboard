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
  let chartVerification = null;
  let chartTimeline = null;

  // ── Column definitions ──────────────────────────────────────
  const ALL_COLUMNS = [
    { key: "delivery_id",          label: "ID",                  defaultOn: true,  type: "text",   truncate: 8 },
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
    renderVerificationChart();
    renderTimelineChart();
  }

  function renderDistrictChart() {
    const map = {};
    filteredRows.forEach((r) => {
      const d = r.district || "N/A";
      map[d] = (map[d] || 0) + (Number(r.delivered_qty) || 0);
    });
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 15);
    const labels = entries.map((e) => e[0]);
    const data = entries.map((e) => e[1]);

    if (chartDistrict) chartDistrict.destroy();
    chartDistrict = new Chart($("#chart-district"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Qtd. Entregue (kg)",
            data,
            backgroundColor: "#0f4c75",
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { display: false } },
        },
      },
    });
  }

  function renderVerificationChart() {
    // Show execution gap: Entregue vs Falta
    const delivered = filteredRows.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);
    const planned = pvdData ? pvdData.totals.planned_kg : delivered;
    const remaining = Math.max(0, planned - delivered);

    if (chartVerification) chartVerification.destroy();
    chartVerification = new Chart($("#chart-verification"), {
      type: "doughnut",
      data: {
        labels: ["Entregue (kg)", "Falta entregar (kg)"],
        datasets: [
          {
            data: [delivered, remaining],
            backgroundColor: ["#16a34a", "#e2e8f0"],
            borderWidth: 2,
            borderColor: "#fff",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "65%",
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                const val = ctx.parsed;
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;
                return ctx.label + ": " + Number(val).toLocaleString("pt-PT") + " (" + pct + "%)";
              }
            }
          }
        },
      },
    });
  }

  function renderTimelineChart() {
    const map = {};
    filteredRows.forEach((r) => {
      const d = r.delivery_date_iso || "";
      if (!d) return;
      map[d] = (map[d] || 0) + 1;
    });
    const entries = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
    const labels = entries.map((e) => {
      const parts = e[0].split("-");
      return parts[2] + "/" + parts[1] + "/" + parts[0];
    });
    const data = entries.map((e) => e[1]);

    if (chartTimeline) chartTimeline.destroy();
    chartTimeline = new Chart($("#chart-timeline"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Entregas",
            data,
            backgroundColor: "#1b7a5a",
            borderRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } },
          y: { beginAtZero: true, grid: { color: "#f1f5f9" } },
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
            let text = String(raw ?? "");
            if (col.truncate) text = text.slice(0, col.truncate);
            const titleAttr = col.truncate ? ` title="${esc(String(r[key] ?? ""))}"` : "";
            return `<td${titleAttr}>${highlightMatch(text, q)}</td>`;
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

  // ── Analytics (exec summary, velocity, gaps, urgency, suppliers, progress) ──
  let chartProgress = null;

  async function loadAnalytics() {
    try {
      const [anaRes, progRes] = await Promise.all([
        fetch("/api/analytics"),
        fetch("/api/analytics/progress"),
      ]);
      const ana = await anaRes.json();
      const progress = await progRes.json();
      renderExecSummary(ana);
      renderGapAnalysis(ana.gaps);
      renderUrgencyTable(ana.urgency);
      renderSupplierPerf(ana.supplier_performance);
      renderProgressChart(progress);
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

  function renderProgressChart(progress) {
    if (progress.length === 0) {
      $("#chart-progress").parentElement.innerHTML += '<p style="text-align:center;color:#94a3b8;font-size:.8rem;margin-top:.5rem">Snapshots serao mostrados apos alguns dias de dados</p>';
      return;
    }
    const labels = progress.map((p) => {
      const parts = p.date.split("-");
      return parts[2] + "/" + parts[1];
    });
    if (chartProgress) chartProgress.destroy();
    chartProgress = new Chart($("#chart-progress"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Qtd. Entregue (kg)",
            data: progress.map((p) => p.total_qty),
            borderColor: "#1b7a5a",
            backgroundColor: "rgba(27,122,90,.1)",
            fill: true,
            tension: .3,
            pointRadius: 4,
            pointBackgroundColor: "#1b7a5a",
          },
          {
            label: "Registos",
            data: progress.map((p) => p.total),
            borderColor: "#0f4c75",
            backgroundColor: "rgba(15,76,117,.1)",
            fill: false,
            tension: .3,
            yAxisID: "y1",
            pointRadius: 4,
            pointBackgroundColor: "#0f4c75",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "top", labels: { boxWidth: 12, font: { size: 10 } } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 9 } }, title: { display: true, text: "kg", font: { size: 10 } } },
          y1: { position: "right", grid: { display: false }, ticks: { font: { size: 9 } }, title: { display: true, text: "Registos", font: { size: 10 } } },
        },
      },
    });
  }

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

    // Cards
    $("#pvd-planned").textContent = fmtDec(t.planned_kg);
    $("#pvd-delivered").textContent = fmtDec(t.delivered_kg);
    $("#pvd-pct").textContent = t.pct + "%";
    $("#pvd-progress-bar").style.width = Math.min(t.pct, 100) + "%";

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
    if (isPublic) {
      if (subtitle) subtitle.textContent = "Delivery Monitoring Dashboard";
      // Show "Operations View" link for internal team
      if (opsLink) opsLink.style.display = "inline-block";
    } else {
      if (subtitle) subtitle.textContent = "Operacoes - Monitoria Interna";
      // Hide "Operations View" since we're already there
      if (opsLink) opsLink.style.display = "none";
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
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
