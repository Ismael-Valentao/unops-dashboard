/* ── /admin/audit-entregas ──────────────────────────────────
 *  Versão "pro": KPIs com WoW, sparklines, avatares, sem-data,
 *  removidas, anomalias, top distritos/produtos, plano-vs-real,
 *  mapa de MZ, export CSV/Excel, URL state, pagination, print.
 */
(function () {
  const { fetchJSON, fmt, esc, sortRows, bindSortable, toast } = window.AdminUI;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // ── State ──────────────────────────────────────────────────
  let rankRows = [];
  let chartTimeline = null, chartStatus = null, chartSubmitters = null;
  let chartTopDist = null, chartTopProd = null;
  let leafletMap = null;
  const sortState = { sortKey: "total", sortAsc: false };
  let currentPage = 1;
  let pageSize = 50;

  // Avatar colors derivados do hash do email
  const AVATAR_COLORS = [
    "#0f4c75", "#0c3a5c", "#16a34a", "#15803d", "#7c3aed", "#5b21b6",
    "#dc2626", "#991b1b", "#d97706", "#92400e", "#0891b2", "#155e75",
    "#db2777", "#9d174d", "#ca8a04", "#ea580c",
  ];
  function avatarColor(email) {
    let h = 0;
    for (let i = 0; i < (email || "").length; i++) h = (h * 31 + email.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }
  function avatarInitials(email) {
    const e = String(email || "?").split("@")[0];
    const parts = e.split(/[._-]/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return e.slice(0, 2).toUpperCase();
  }

  // ── Utils ──────────────────────────────────────────────────
  function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("pt-MZ", {
      day: "2-digit", month: "2-digit", year: "numeric",
    });
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("pt-MZ", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function statusPill(status) {
    const v = String(status || "").toLowerCase();
    let cls = "pill-other"; let text = status || "—";
    if (v === "verified")             { cls = "pill-verified" }
    else if (v.includes("pending"))   { cls = "pill-pending"; text = "Pending" }
    else if (v === "rejected")        { cls = "pill-rejected" }
    else if (v.includes("not reach")) { cls = "pill-notreach"; text = "N/Reach" }
    else if (v.includes("partial"))   { cls = "pill-partial"; text = "Partial" }
    return `<span class="pill ${cls}">${esc(text)}</span>`;
  }

  // Sparkline bars renderer (canvas)
  function renderSparkline(canvas, values) {
    if (!canvas || !values) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width = canvas.offsetWidth * 2;  // retina
    const h = canvas.height = canvas.offsetHeight * 2;
    ctx.scale(2, 2);
    const cw = canvas.offsetWidth, ch = canvas.offsetHeight;
    ctx.clearRect(0, 0, cw, ch);
    const max = Math.max(1, ...values);
    const barW = cw / values.length - 1;
    values.forEach((v, i) => {
      const barH = (v / max) * (ch - 2);
      const x = i * (barW + 1);
      const y = ch - barH;
      ctx.fillStyle = v > 0 ? "#0f4c75" : "#e2e8f0";
      ctx.fillRect(x, y, barW, barH || 1);
    });
  }

  // ── URL state ──────────────────────────────────────────────
  function readUrlState() {
    const p = new URLSearchParams(location.search);
    if (p.get("tab")) activateTab(p.get("tab"));
    if (p.get("q"))         $("#f-q").value = p.get("q");
    if (p.get("status"))    $("#f-status").value = p.get("status");
    if (p.get("submitter")) $("#f-submitter").value = p.get("submitter");
    if (p.get("district"))  $("#f-district").value = p.get("district");
    if (p.get("from"))      $("#f-from").value = p.get("from");
    if (p.get("to"))        $("#f-to").value = p.get("to");
    if (p.get("page"))      currentPage = Number(p.get("page")) || 1;
  }
  function writeUrlState() {
    const p = new URLSearchParams();
    const activeTab = document.querySelector(".tab.active")?.dataset.tab;
    if (activeTab && activeTab !== "ranking") p.set("tab", activeTab);
    if ($("#f-q")?.value)         p.set("q", $("#f-q").value);
    if ($("#f-status")?.value)    p.set("status", $("#f-status").value);
    if ($("#f-submitter")?.value) p.set("submitter", $("#f-submitter").value);
    if ($("#f-district")?.value)  p.set("district", $("#f-district").value);
    if ($("#f-from")?.value)      p.set("from", $("#f-from").value);
    if ($("#f-to")?.value)        p.set("to", $("#f-to").value);
    if (currentPage > 1)          p.set("page", currentPage);
    const qs = p.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
  }

  // ── KPIs ───────────────────────────────────────────────────
  async function loadCounts() {
    try {
      const c = await fetchJSON("/admin/api/audit/counts");
      // WoW arrow
      const wowArrow = c.wow_delta_pct > 5 ? "📈" : c.wow_delta_pct < -5 ? "📉" : "➡";
      const wowCls = c.wow_delta_pct > 5 ? "up" : c.wow_delta_pct < -5 ? "down" : "flat";
      const wowSign = c.wow_delta_pct > 0 ? "+" : "";
      $("#kpi-cards").innerHTML = `
        <div class="kpi-card total">
          <div class="lbl">Total Capturado</div>
          <div class="val">${fmt(c.total)}</div>
          <div class="wow ${wowCls}">${wowArrow} ${wowSign}${c.wow_delta_pct}% vs sem. anterior</div>
        </div>
        <div class="kpi-card today">
          <div class="lbl">Hoje</div>
          <div class="val">${fmt(c.today)}</div>
          <div class="wow flat">Esta semana: <strong>${fmt(c.this_week)}</strong></div>
        </div>
        <div class="kpi-card verified">
          <div class="lbl">Verificadas</div>
          <div class="val">${fmt(c.verified)}</div>
          <div class="wow flat">${c.total > 0 ? Math.round(100 * c.verified / c.total) : 0}% do total</div>
        </div>
        <div class="kpi-card pending">
          <div class="lbl">Pendentes</div>
          <div class="val">${fmt(c.pending)}</div>
          <div class="wow flat">${c.total > 0 ? Math.round(100 * c.pending / c.total) : 0}% do total</div>
        </div>
        <div class="kpi-card rejected">
          <div class="lbl">Rejeitadas</div>
          <div class="val">${fmt(c.rejected)}</div>
          <div class="wow flat">${c.total > 0 ? Math.round(100 * c.rejected / c.total) : 0}% do total</div>
        </div>
        <div class="kpi-card lost">
          <div class="lbl">Submetedores</div>
          <div class="val">${fmt(c.submitters)}</div>
          <div class="wow flat">${fmt(c.districts)} distritos</div>
        </div>
      `;
      // Badges nas tabs
      const badgeLost = $("#badge-lost");
      if (c.lost > 0) { badgeLost.textContent = c.lost; badgeLost.style.display = ""; }
      else badgeLost.style.display = "none";
      const badgeMissing = $("#badge-missing");
      if (c.no_date > 0) { badgeMissing.textContent = c.no_date; badgeMissing.style.display = ""; }
      else badgeMissing.style.display = "none";

      // Banners
      renderAlerts(c);
    } catch (e) { /* ignore */ }
  }

  function renderAlerts(c) {
    const alerts = [];
    if (c.lost > 0) {
      alerts.push(`
        <div class="alert-bar danger">
          <span style="font-size:1.5rem">🔒</span>
          <div style="flex:1">
            <strong>${fmt(c.lost)} submissões removidas/perdidas</strong> do Google Sheet há mais de 2 dias.
            Estão preservadas aqui na auditoria.
          </div>
          <a href="?tab=lost" data-go-tab="lost">Ver perdidas →</a>
        </div>
      `);
    }
    if (c.no_date > 0) {
      alerts.push(`
        <div class="alert-bar warn">
          <span style="font-size:1.5rem">⚠</span>
          <div style="flex:1">
            <strong>${fmt(c.no_date)} submissões sem <code>delivery_date</code></strong> no sheet original.
            <code>detected_at</code> serve de salvaguarda.
          </div>
          <a href="?tab=missing" data-go-tab="missing">Ver →</a>
        </div>
      `);
    }
    $("#alerts").innerHTML = alerts.join("");
    // bind go-tab links
    $$("[data-go-tab]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        activateTab(a.dataset.goTab);
      });
    });
  }

  // ── Ranking (com sparkline + avatar) ───────────────────────
  async function loadRanking() {
    $("#rank-body").innerHTML = `<tr><td colspan="11"><span class="skel full"></span></td></tr>`;
    try {
      const data = await fetchJSON("/admin/api/audit/submitters?limit=200");
      rankRows = data.rows || [];
      renderRanking();
    } catch (e) {
      $("#rank-body").innerHTML = `<tr><td colspan="11" class="empty" style="color:#dc2626">${esc(e.message)}</td></tr>`;
    }
  }
  function renderRanking() {
    const sortKey = sortState.sortKey;
    const numKeys = ["total", "verified", "pending", "rejected", "not_reachable", "today", "qty_total", "no_date", "avg_verif_hours"];
    const dateKeys = ["last_seen", "first_seen"];
    const type = numKeys.includes(sortKey) ? "number"
               : dateKeys.includes(sortKey) ? "date" : "string";
    const sorted = sortRows(rankRows, sortKey, sortState.sortAsc, type);
    if (!sorted.length) {
      $("#rank-body").innerHTML = `<tr><td colspan="11" class="empty">Sem submissões capturadas ainda.</td></tr>`;
      return;
    }
    $("#rank-body").innerHTML = sorted.map((r) => {
      const total    = Number(r.total)    || 0;
      const verified = Number(r.verified) || 0;
      const pct      = total > 0 ? Math.round((verified / total) * 100) : 0;
      const pctCls   = pct >= 80 ? "" : (pct >= 50 ? "warn" : "bad");
      const email    = r.email || "(sem email)";
      const avgVerif = r.avg_verif_hours ? Math.round(Number(r.avg_verif_hours)) + "h" : "—";
      return `
        <tr class="sub-row" data-email="${esc(email)}">
          <td>
            <div class="avatar-cell">
              <div class="avatar" style="background:${avatarColor(email)}">${avatarInitials(email)}</div>
              <div class="info"><strong>${esc(email)}</strong><small>${fmtDate(r.first_seen)} → ${fmtDate(r.last_seen)}</small></div>
            </div>
          </td>
          <td><canvas class="sparkline" data-spark='${JSON.stringify(r.sparkline || [])}'></canvas></td>
          <td class="num"><strong>${fmt(total)}</strong></td>
          <td class="num" style="color:#7c3aed;font-weight:700">${fmt(r.today)}</td>
          <td class="num" style="color:#16a34a;font-weight:700">${fmt(verified)}</td>
          <td class="num" style="color:#d97706">${fmt(r.pending)}</td>
          <td class="num" style="color:#dc2626">${fmt(r.rejected)}</td>
          <td class="num" style="color:${Number(r.no_date)>0?'#92400e':'#94a3b8'}">${fmt(r.no_date)}</td>
          <td class="num" style="color:#475569">${avgVerif}</td>
          <td class="num" style="font-size:.74rem;color:#64748b">${fmtDate(r.last_seen)}</td>
          <td class="num">
            <strong>${pct}%</strong>
            <span class="pct-bar"><span class="pct-bar-fill ${pctCls}" style="width:${pct}%"></span></span>
          </td>
        </tr>
        <tr class="sub-detail-row" data-email="${esc(email)}">
          <td colspan="11"><div class="sub-detail" data-email-content="${esc(email)}"></div></td>
        </tr>
      `;
    }).join("");
    // Render sparklines (canvas)
    $$("#rank-body .sparkline").forEach((cv) => {
      try { renderSparkline(cv, JSON.parse(cv.dataset.spark)); }
      catch (_) { /* ignore */ }
    });
    // Click handlers para expandir detalhe
    $$("#rank-body .sub-row").forEach((tr) => {
      tr.addEventListener("click", () => toggleDetail(tr.dataset.email));
    });
  }

  async function toggleDetail(email) {
    const row = $("#rank-body").querySelector(`.sub-row[data-email="${CSS.escape(email)}"]`);
    const detailRow = $("#rank-body").querySelector(`.sub-detail-row[data-email="${CSS.escape(email)}"]`);
    const detailDiv = detailRow.querySelector(".sub-detail");
    if (detailDiv.classList.contains("show")) {
      detailDiv.classList.remove("show");
      row.classList.remove("expanded");
      return;
    }
    $$("#rank-body .sub-detail.show").forEach((d) => d.classList.remove("show"));
    $$("#rank-body .sub-row.expanded").forEach((r) => r.classList.remove("expanded"));
    detailDiv.innerHTML = '<div class="empty"><span class="skel" style="width:120px"></span></div>';
    detailDiv.classList.add("show");
    row.classList.add("expanded");
    try {
      const data = await fetchJSON("/admin/api/audit/list?submitter=" + encodeURIComponent(email) + "&pageSize=200");
      const rows = data.rows || [];
      if (!rows.length) { detailDiv.innerHTML = '<div class="empty">Sem submissões.</div>'; return; }
      detailDiv.innerHTML = `
        <h4>Submissões de ${esc(email)} — últimas ${rows.length}</h4>
        <table class="sub-detail-tbl">
          <thead><tr>
            <th>Detected</th><th>GTU</th><th>Beneficiário</th><th>Distrito</th>
            <th>Produto</th><th>Qty</th><th>Status</th>
          </tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${fmtDateTime(r.detected_at)}</td>
                <td><code style="font-size:.72rem">${esc(r.gtu || r.adsn || "—")}</code></td>
                <td>${esc(r.beneficiary_name || "—")}</td>
                <td>${esc(r.district || "—")}</td>
                <td>${esc(r.product || "—")}</td>
                <td>${fmt(r.delivered_qty || 0)} ${esc(r.unit || "")}</td>
                <td>${statusPill(r.verification_status)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    } catch (e) {
      detailDiv.innerHTML = `<div class="empty" style="color:#dc2626">${esc(e.message)}</div>`;
    }
  }

  // ── Timeline (3 charts) ────────────────────────────────────
  async function loadTimeline() {
    const days = $("#tl-days").value;
    try {
      const data = await fetchJSON("/admin/api/audit/timeline?days=" + days);
      const rows = data.rows || [];
      renderTimelineChart(rows);
      renderStatusDoughnut(rows);
      renderSubmittersChart(rows);
    } catch (_) { /* ignore */ }
  }
  function renderTimelineChart(rows) {
    const labels = rows.map((r) => new Date(r.date).toLocaleDateString("pt-MZ", { day: "2-digit", month: "2-digit" }));
    if (chartTimeline) chartTimeline.destroy();
    chartTimeline = new Chart($("#chart-timeline"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Verified", data: rows.map((r) => Number(r.verified) || 0), backgroundColor: "#86efac", stack: "x" },
          { label: "Pending",  data: rows.map((r) => Number(r.pending) || 0), backgroundColor: "#fcd34d", stack: "x" },
          { label: "Rejected", data: rows.map((r) => Number(r.rejected) || 0), backgroundColor: "#fca5a5", stack: "x" },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
          title: { display: true, text: "Submissões por dia (empilhado por status)", font: { size: 12 } },
        },
        scales: {
          x: { stacked: true, ticks: { font: { size: 10 } } },
          y: { stacked: true, beginAtZero: true,
            title: { display: true, text: "Submissões/dia", font: { size: 11 } } },
        },
      },
    });
  }
  function renderStatusDoughnut(rows) {
    const totals = rows.reduce((acc, r) => {
      acc.verified += Number(r.verified) || 0;
      acc.pending  += Number(r.pending) || 0;
      acc.rejected += Number(r.rejected) || 0;
      return acc;
    }, { verified: 0, pending: 0, rejected: 0 });
    if (chartStatus) chartStatus.destroy();
    chartStatus = new Chart($("#chart-status"), {
      type: "doughnut",
      data: {
        labels: ["Verified", "Pending", "Rejected"],
        datasets: [{ data: [totals.verified, totals.pending, totals.rejected],
          backgroundColor: ["#16a34a", "#d97706", "#dc2626"] }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
          title: { display: true, text: "Distribuição por status (período)" },
        },
      },
    });
  }
  function renderSubmittersChart(rows) {
    const labels = rows.map((r) => new Date(r.date).toLocaleDateString("pt-MZ", { day: "2-digit", month: "2-digit" }));
    if (chartSubmitters) chartSubmitters.destroy();
    chartSubmitters = new Chart($("#chart-submitters"), {
      type: "line",
      data: {
        labels,
        datasets: [{ label: "Submetedores únicos/dia", data: rows.map((r) => Number(r.submitters) || 0),
          borderColor: "#0f4c75", backgroundColor: "rgba(15,76,117,.15)", fill: true, tension: 0.25 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, title: { display: true, text: "Utilizadores activos por dia" } },
        scales: { y: { beginAtZero: true } },
      },
    });
  }

  // ── Lista todas (com pagination) ───────────────────────────
  async function loadAll() {
    const params = new URLSearchParams();
    if ($("#f-q").value) params.set("q", $("#f-q").value);
    if ($("#f-status").value) params.set("status", $("#f-status").value);
    if ($("#f-submitter").value) params.set("submitter", $("#f-submitter").value);
    if ($("#f-district").value) params.set("district", $("#f-district").value);
    if ($("#f-from").value) params.set("from", $("#f-from").value);
    if ($("#f-to").value)   params.set("to",   $("#f-to").value);
    params.set("page", currentPage);
    params.set("pageSize", pageSize);
    writeUrlState();
    $("#all-body").innerHTML = `<tr><td colspan="8"><span class="skel full"></span></td></tr>`;
    try {
      const data = await fetchJSON("/admin/api/audit/list?" + params);
      const rows = data.rows || [];
      if (!rows.length) {
        $("#all-body").innerHTML = `<tr><td colspan="8" class="empty">Sem resultados.</td></tr>`;
        $("#all-pagination").innerHTML = "";
        return;
      }
      $("#all-body").innerHTML = rows.map((r) => `
        <tr>
          <td>${fmtDateTime(r.detected_at)}</td>
          <td><code style="font-size:.72rem">${esc(r.gtu || r.adsn || "—")}</code></td>
          <td>${esc(r.beneficiary_name || "—")}</td>
          <td>${esc(r.district || "—")}</td>
          <td>${esc(r.product || "—")}</td>
          <td class="num">${fmt(r.delivered_qty || 0)} ${esc(r.unit || "")}</td>
          <td><div class="avatar-cell">
            <div class="avatar" style="background:${avatarColor(r.submitted_by)};width:22px;height:22px;font-size:.62rem">${avatarInitials(r.submitted_by)}</div>
            <span style="font-size:.78rem">${esc((r.submitted_by || "—").split("@")[0])}</span>
          </div></td>
          <td>${statusPill(r.verification_status)}</td>
        </tr>
      `).join("");
      renderPagination(data);
    } catch (e) {
      $("#all-body").innerHTML = `<tr><td colspan="8" class="empty" style="color:#dc2626">${esc(e.message)}</td></tr>`;
    }
  }
  function renderPagination(data) {
    const { total, page, pageSize, totalPages } = data;
    if (totalPages <= 1) { $("#all-pagination").innerHTML = `<span class="info">${fmt(total)} resultados</span>`; return; }
    const buttons = [];
    buttons.push(`<button ${page === 1 ? "disabled" : ""} data-page="1">«</button>`);
    buttons.push(`<button ${page === 1 ? "disabled" : ""} data-page="${page - 1}">‹</button>`);
    // Mostra páginas perto da actual
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, page + 2);
    if (start > 1) buttons.push(`<span style="color:#94a3b8">…</span>`);
    for (let i = start; i <= end; i++) {
      buttons.push(`<button class="${i === page ? "active" : ""}" data-page="${i}">${i}</button>`);
    }
    if (end < totalPages) buttons.push(`<span style="color:#94a3b8">…</span>`);
    buttons.push(`<button ${page === totalPages ? "disabled" : ""} data-page="${page + 1}">›</button>`);
    buttons.push(`<button ${page === totalPages ? "disabled" : ""} data-page="${totalPages}">»</button>`);
    buttons.push(`<span class="info">Pág. ${page}/${totalPages} · ${fmt(total)} resultados</span>`);
    $("#all-pagination").innerHTML = buttons.join("");
    $$("#all-pagination button[data-page]").forEach((b) => {
      b.addEventListener("click", () => {
        currentPage = Number(b.dataset.page);
        loadAll();
      });
    });
  }

  // ── Lost rows ─────────────────────────────────────────────
  async function loadLost() {
    const days = $("#lost-days").value;
    $("#lost-body").innerHTML = `<tr><td colspan="9"><span class="skel full"></span></td></tr>`;
    try {
      const data = await fetchJSON("/admin/api/audit/lost?days_gap=" + days);
      const rows = data.rows || [];
      if (!rows.length) {
        $("#lost-body").innerHTML = `<tr><td colspan="9" class="empty">🎉 Nenhuma linha perdida no critério escolhido.</td></tr>`;
        return;
      }
      $("#lost-body").innerHTML = rows.map((r) => `
        <tr style="background:#fffbfb">
          <td>${fmtDateTime(r.detected_at)}</td>
          <td class="num"><strong style="color:#dc2626">${r.days_lost} dias</strong></td>
          <td><code style="font-size:.72rem">${esc(r.gtu || r.adsn || "—")}</code></td>
          <td>${esc(r.beneficiary_name || "—")}</td>
          <td>${esc(r.district || "—")}</td>
          <td>${esc(r.product || "—")}</td>
          <td class="num">${fmt(r.delivered_qty || 0)} ${esc(r.unit || "")}</td>
          <td style="font-size:.78rem">${esc(r.submitted_by || "—")}</td>
          <td style="font-size:.74rem;color:#64748b">${fmtDateTime(r.last_seen_at)}</td>
        </tr>
      `).join("");
    } catch (e) {
      $("#lost-body").innerHTML = `<tr><td colspan="9" class="empty" style="color:#dc2626">${esc(e.message)}</td></tr>`;
    }
  }

  // ── Missing date ─────────────────────────────────────────
  async function loadMissing() {
    $("#missing-by-sub-body").innerHTML = `<tr><td colspan="4"><span class="skel full"></span></td></tr>`;
    $("#missing-body").innerHTML = `<tr><td colspan="8"><span class="skel full"></span></td></tr>`;
    try {
      const [bySub, list] = await Promise.all([
        fetchJSON("/admin/api/audit/missing-date/by-submitter"),
        fetchJSON("/admin/api/audit/missing-date?limit=500"),
      ]);
      // Por submetedor
      const sb = bySub.rows || [];
      $("#missing-by-sub-body").innerHTML = sb.length ? sb.map((r) => {
        const cls = r.pct_no_date >= 50 ? "bad" : (r.pct_no_date >= 20 ? "warn" : "");
        return `
          <tr>
            <td><div class="avatar-cell">
              <div class="avatar" style="background:${avatarColor(r.email)}">${avatarInitials(r.email)}</div>
              <strong>${esc(r.email)}</strong>
            </div></td>
            <td class="num">${fmt(r.total)}</td>
            <td class="num" style="color:#92400e;font-weight:700">${fmt(r.no_date)}</td>
            <td class="num">
              <strong>${r.pct_no_date}%</strong>
              <span class="pct-bar"><span class="pct-bar-fill ${cls}" style="width:${r.pct_no_date}%"></span></span>
            </td>
          </tr>
        `;
      }).join("") : `<tr><td colspan="4" class="empty">🎉 Ninguém com submissões sem data.</td></tr>`;
      // Lista detalhada
      const rows = list.rows || [];
      $("#missing-body").innerHTML = rows.length ? rows.map((r) => `
        <tr style="background:#fffef0">
          <td>${fmtDateTime(r.detected_at)}</td>
          <td><code style="font-size:.72rem">${esc(r.gtu || r.adsn || "—")}</code></td>
          <td>${esc(r.beneficiary_name || "—")}</td>
          <td>${esc(r.district || "—")}</td>
          <td>${esc(r.product || "—")}</td>
          <td class="num">${fmt(r.delivered_qty || 0)} ${esc(r.unit || "")}</td>
          <td style="font-size:.78rem">${esc(r.submitted_by || "—")}</td>
          <td>${statusPill(r.verification_status)}</td>
        </tr>
      `).join("") : `<tr><td colspan="8" class="empty">Sem linhas sem data.</td></tr>`;
    } catch (e) { /* ignore */ }
  }

  // ── Anomalias ────────────────────────────────────────────
  async function loadAnomalies() {
    $("#anomalies-grid").innerHTML = `<div class="skel lg" style="height:120px;width:100%"></div>`;
    try {
      const data = await fetchJSON("/admin/api/audit/anomalies");
      const rows = data.rows || [];
      if (!rows.length) {
        $("#anomalies-grid").innerHTML = `<div class="empty">🎉 Tudo dentro do normal — sem anomalias detectadas.</div>`;
        return;
      }
      $("#anomalies-grid").innerHTML = rows.map((r) => {
        const isHB = r.flag === "high_burst";
        const title = isHB ? "🔥 Burst de submissões" : "💤 Inactivo";
        const reason = isHB
          ? `Hoje submeteu <strong>${fmt(r.today_n)}</strong> — média diária habitual: ${Math.round(Number(r.avg_per_day) * 10) / 10}/dia`
          : `Sem actividade há <strong>${r.days_inactive} dias</strong> (era activo em ${r.active_days_14d} dos últimos 14)`;
        return `
          <div class="anomaly ${r.flag}">
            <h5>${title}</h5>
            <div class="reason">${reason}</div>
            <div class="stats">
              <div class="avatar-cell">
                <div class="avatar" style="background:${avatarColor(r.email)};width:22px;height:22px;font-size:.62rem">${avatarInitials(r.email)}</div>
                <strong>${esc(r.email)}</strong>
              </div>
              <div style="margin-top:.3rem">Última actividade: ${fmtDate(r.last_active)}</div>
            </div>
          </div>
        `;
      }).join("");
    } catch (e) { /* ignore */ }
  }

  // ── Top distritos / produtos ─────────────────────────────
  async function loadTopDistricts() {
    try {
      const data = await fetchJSON("/admin/api/audit/top-districts?limit=15");
      const rows = data.rows || [];
      if (chartTopDist) chartTopDist.destroy();
      chartTopDist = new Chart($("#chart-topdist"), {
        type: "bar",
        data: {
          labels: rows.map((r) => `${r.district} (${r.province})`),
          datasets: [
            { label: "Submissões", data: rows.map((r) => Number(r.total) || 0), backgroundColor: "#0f4c75" },
          ],
        },
        options: {
          indexAxis: "y", responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, title: { display: true, text: "Top 15 distritos por submissões" } },
        },
      });
    } catch (e) { /* ignore */ }
  }
  async function loadTopProducts() {
    try {
      const data = await fetchJSON("/admin/api/audit/top-products?limit=10");
      const rows = data.rows || [];
      if (chartTopProd) chartTopProd.destroy();
      chartTopProd = new Chart($("#chart-topprod"), {
        type: "bar",
        data: {
          labels: rows.map((r) => `${r.product} (${r.unit || ""})`),
          datasets: [
            { label: "Submissões", data: rows.map((r) => Number(r.total) || 0), backgroundColor: "#16a34a" },
          ],
        },
        options: {
          indexAxis: "y", responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, title: { display: true, text: "Top 10 produtos" } },
        },
      });
    } catch (e) { /* ignore */ }
  }

  // ── Plano vs Real ────────────────────────────────────────
  async function loadPlanActual() {
    $("#planactual-body").innerHTML = `<tr><td colspan="8"><span class="skel full"></span></td></tr>`;
    try {
      const data = await fetchJSON("/admin/api/audit/plan-vs-actual");
      const rows = data.rows || [];
      if (!rows.length) {
        $("#planactual-body").innerHTML = `<tr><td colspan="8" class="empty">Sem dados de plano vs real.</td></tr>`;
        return;
      }
      $("#planactual-body").innerHTML = rows.map((r) => {
        const planeado = Number(r.planeado) || 0;
        const submetido = Number(r.submetido) || 0;
        const pct = planeado > 0 ? Math.round((submetido / planeado) * 100) : 0;
        const cls = pct >= 80 ? "" : (pct >= 50 ? "warn" : "bad");
        return `
          <tr>
            <td><strong>${esc(r.district || "—")}</strong></td>
            <td>${esc(r.province || "—")}</td>
            <td>${esc(r.produto)}</td>
            <td class="num">${fmt(planeado)}</td>
            <td class="num" style="color:#0f4c75">${fmt(submetido)}</td>
            <td class="num" style="color:${pct >= 80 ? '#16a34a' : '#dc2626'};font-weight:700">${fmt(Math.max(0, planeado - submetido))}</td>
            <td class="num"><strong>${pct}%</strong>
              <span class="pct-bar"><span class="pct-bar-fill ${cls}" style="width:${Math.min(100, pct)}%"></span></span>
            </td>
            <td class="num" style="font-size:.78rem">${fmt(r.n_submetidos)}/${fmt(r.n_planeados)}</td>
          </tr>
        `;
      }).join("");
    } catch (e) { /* ignore */ }
  }

  // ── Mapa MZ ──────────────────────────────────────────────
  async function loadMap() {
    if (!leafletMap) {
      leafletMap = L.map("mz-map").setView([-18.5, 35.5], 6);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap", maxZoom: 18,
      }).addTo(leafletMap);
    }
    try {
      const data = await fetchJSON("/admin/api/audit/district-heat");
      const rows = data.rows || [];
      // Coordenadas aproximadas dos distritos principais
      const COORDS = {
        // Maputo
        "Maputo": [-25.965, 32.582], "Matola": [-25.962, 32.458], "Manhiça": [-25.4, 32.8],
        "Marracuene": [-25.74, 32.67], "Magude": [-25.03, 32.65], "Moamba": [-25.6, 32.23],
        "Boane": [-26.04, 32.32], "Namaacha": [-26.0, 32.0], "Matutuíne": [-26.5, 32.6],
        // Gaza
        "Xai-Xai": [-25.05, 33.65], "Chibuto": [-24.69, 33.53], "Chókwè": [-24.53, 32.99],
        "Limpopo": [-25.07, 33.65], "Chonguene": [-25.05, 34.0], "Guija": [-24.5, 33.0],
        "Mabalane": [-23.5, 32.55], "Massingir": [-23.92, 32.16], "Mapai": [-22.8, 31.95],
        "Mandlakazi": [-24.85, 33.83],
        // Sofala
        "Beira": [-19.84, 34.86], "Buzi": [-19.99, 34.13], "Caia": [-17.83, 35.34],
        "Dondo": [-19.61, 34.74], "Gorongosa": [-18.7, 34.07], "Machanga": [-20.95, 35.0],
        "Maringué": [-17.8, 34.4], "Marromeu": [-18.3, 35.93], "Muanza": [-18.9, 34.78],
        "Nhamatanda": [-19.3, 34.27],
        // Manica
        "Chimoio": [-19.12, 33.48], "Gondola": [-19.16, 33.65], "Manica": [-18.93, 32.87],
        "Sussundenga": [-19.38, 33.27], "Vanduzi": [-18.92, 33.4], "Barue": [-18.07, 33.18],
        "Mossurize": [-20.5, 33.28], "Tambara": [-16.85, 33.6], "Macate": [-19.4, 33.55],
        "Macossa": [-17.83, 33.75], "Machaze": [-21.42, 33.63], "Guro": [-17.5, 33.27],
        // Tete
        "Tete": [-16.16, 33.59], "Angonia": [-14.78, 34.45], "Cahora-Bassa": [-15.65, 32.75],
        "Changara": [-16.92, 33.25], "Chifunde": [-14.0, 33.38], "Chiuta": [-15.07, 34.1],
        "Doa": [-16.7, 35.0], "Macanga": [-15.0, 33.8], "Magoe": [-15.85, 31.83],
        "Marávia": [-15.0, 33.0], "Maravia": [-15.0, 33.0], "Moatize": [-16.1, 33.73],
        "Mutarara": [-17.42, 35.3], "Tsangano": [-14.92, 34.6], "Zumbo": [-15.6, 30.43],
        // Zambezia
        "Quelimane": [-17.88, 36.88], "Alto Molocue": [-15.63, 37.65], "Chinde": [-18.6, 36.45],
        "Gile": [-16.16, 38.17], "Gurue": [-15.46, 36.98], "Ile": [-16.1, 37.7],
        "Inhassunge": [-18.0, 36.78], "Lugela": [-16.43, 36.88], "Maganja da costa": [-17.3, 37.47],
        "Maganja da Costa": [-17.3, 37.47], "Milange": [-16.05, 35.78], "Mocuba": [-16.83, 36.97],
        "Mopeia": [-17.97, 35.72], "Morrumbala": [-17.5, 35.58], "Namacurra": [-17.5, 36.88],
        "Namarroi": [-15.92, 36.85], "Nicoadala": [-17.62, 36.83], "Pebane": [-17.27, 38.15],
      };
      // Limpa marcadores anteriores
      leafletMap.eachLayer((layer) => {
        if (layer instanceof L.CircleMarker || layer instanceof L.Marker) leafletMap.removeLayer(layer);
      });
      const maxTotal = Math.max(...rows.map((r) => Number(r.total) || 0), 1);
      let placed = 0;
      for (const r of rows) {
        const c = COORDS[r.district];
        if (!c) continue;
        placed++;
        const total = Number(r.total) || 0;
        const radius = 6 + (total / maxTotal) * 30;
        const verifiedPct = total > 0 ? (Number(r.verified) / total) * 100 : 0;
        const color = verifiedPct >= 70 ? "#16a34a" : verifiedPct >= 40 ? "#d97706" : "#dc2626";
        L.circleMarker(c, {
          radius, color: "#fff", weight: 2, fillColor: color, fillOpacity: 0.7,
        })
          .bindPopup(`
            <strong>${esc(r.district)}</strong> (${esc(r.province || "")})<br>
            Total: <strong>${fmt(total)}</strong><br>
            Verified: ${fmt(r.verified)} (${Math.round(verifiedPct)}%)<br>
            Pending: ${fmt(r.pending)}<br>
            ${fmt(r.submitters)} submetedores
          `)
          .addTo(leafletMap);
      }
      if (!placed) {
        toast(`${rows.length} distritos no audit, mas nenhum tem coordenadas conhecidas`, { kind: "warn" });
      }
    } catch (e) { /* ignore */ }
  }

  // ── Por Batedor / Dia ──────────────────────────────────
  // Cor de heatmap: branco→azul escuro consoante intensidade [0..1]
  function heatColor(intensity) {
    if (intensity <= 0) return "transparent";
    // Lerp entre #f0f9ff (claro) e #0f4c75 (escuro)
    const r0 = 240, g0 = 249, b0 = 255;
    const r1 = 15,  g1 = 76,  b1 = 117;
    const t = Math.min(1, Math.max(0, intensity));
    const r = Math.round(r0 + (r1 - r0) * t);
    const g = Math.round(g0 + (g1 - g0) * t);
    const b = Math.round(b0 + (b1 - b0) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
  function heatTextColor(intensity) {
    return intensity > 0.55 ? "#fff" : "#0f172a";
  }

  // Date string em componentes locais (evita o bug de UTC do toISOString())
  function localYmd(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // Formata kg com K/M para evitar overflow nas células estreitas
  function fmtKg(n) {
    const v = Math.round(Number(n) || 0);
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
    if (v >= 10_000)    return Math.round(v / 1000) + "k";
    if (v >= 1000)      return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(v);
  }

  async function loadByDay() {
    const days = $("#bd-days").value;
    $("#byday-info").textContent = "A carregar…";
    $("#byday-body").innerHTML = `<tr><td colspan="20"><span class="skel full"></span></td></tr>`;
    try {
      const data = await fetchJSON("/admin/api/audit/by-day?days=" + days);
      renderByDay(data);
    } catch (e) {
      $("#byday-body").innerHTML = `<tr><td colspan="20" class="empty" style="color:#dc2626">${esc(e.message)}</td></tr>`;
    }
  }
  function renderByDay(data) {
    const days = data.days || [];
    const subs = data.submitters || [];
    const todayIso = localYmd(new Date());

    // Info linha — agora em kg
    const totalSubs = subs.length;
    const totalKg = subs.reduce((s, r) => s + (Number(r.total_kg) || 0), 0);
    const totalSubmissions = subs.reduce((s, r) => s + r.total, 0);
    $("#byday-info").innerHTML = `
      <strong>${fmt(totalSubs)}</strong> batedores ·
      <strong>${fmt(Math.round(totalKg))} kg</strong> entregues
      (<strong>${fmt(totalSubmissions)}</strong> submissões) nos últimos
      <strong>${days.length}</strong> dias
    `;

    if (!subs.length) {
      $("#byday-head").innerHTML = "";
      $("#byday-body").innerHTML = `<tr><td colspan="20" class="empty">Sem entregas neste período.</td></tr>`;
      $("#byday-foot").innerHTML = "";
      return;
    }

    // Calcula max para normalização do heatmap (em kg)
    let maxCell = 1;
    for (const s of subs) {
      for (const day of days) {
        const cell = s.by_day[day];
        if (cell && cell.kg > maxCell) maxCell = cell.kg;
      }
    }

    // Header
    const headHtml = ["<tr>"];
    headHtml.push(`<th class="col-email">Batedor</th>`);
    for (const d of days) {
      const dt = new Date(d + "T00:00:00");
      const isToday = d === todayIso;
      const wd = dt.toLocaleDateString("pt-MZ", { weekday: "short" }).slice(0, 3);
      const dm = dt.toLocaleDateString("pt-MZ", { day: "2-digit", month: "2-digit" });
      headHtml.push(`<th class="col-day ${isToday ? "today" : ""}" title="${d}${isToday ? " (hoje)" : ""}">
        <div style="font-size:.62rem;text-transform:lowercase;color:#94a3b8">${esc(wd)}</div>
        <div>${esc(dm)}</div>
      </th>`);
    }
    headHtml.push(`<th class="col-total">Total kg</th>`);
    headHtml.push("</tr>");
    $("#byday-head").innerHTML = headHtml.join("");

    // Body — célula mostra kg, tooltip mostra detalhe (kg verified/pending/rejected + nº submissões)
    const bodyHtml = [];
    for (const s of subs) {
      bodyHtml.push("<tr>");
      bodyHtml.push(`
        <td class="col-email">
          <div class="avatar-cell">
            <div class="avatar" style="background:${avatarColor(s.email)}">${avatarInitials(s.email)}</div>
            <span style="font-size:.78rem;font-weight:600">${esc(s.email)}</span>
          </div>
        </td>
      `);
      for (const day of days) {
        const cell = s.by_day[day];
        const isToday = day === todayIso;
        if (!cell || cell.kg <= 0) {
          bodyHtml.push(`<td class="col-day zero ${isToday ? "today" : ""}">—</td>`);
        } else {
          const intensity = cell.kg / maxCell;
          const tip =
            `${Math.round(cell.kg)} kg em ${cell.n} submissão(ões)` +
            ` · ✓ ${Math.round(cell.kg_verified)} kg` +
            ` · ⏳ ${Math.round(cell.kg_pending)} kg` +
            ` · ✗ ${Math.round(cell.kg_rejected)} kg`;
          bodyHtml.push(`
            <td class="col-day has-data ${isToday ? "today" : ""}"
                style="background:${heatColor(intensity)};color:${heatTextColor(intensity)};font-weight:700"
                data-email="${esc(s.email)}" data-day="${day}"
                title="${esc(tip)}">${fmtKg(cell.kg)}</td>
          `);
        }
      }
      bodyHtml.push(`<td class="col-total">${fmt(Math.round(s.total_kg))}</td>`);
      bodyHtml.push("</tr>");
    }
    $("#byday-body").innerHTML = bodyHtml.join("");

    // Footer com totais por dia (em kg)
    const totalsByDay = data.day_totals || {};
    const grandTotalKg = Object.values(totalsByDay).reduce((s, v) => s + (Number(v.kg) || 0), 0);
    const footHtml = ["<tr>"];
    footHtml.push(`<td class="col-email">TOTAL DIÁRIO (kg)</td>`);
    for (const d of days) {
      const t = totalsByDay[d] || { kg: 0 };
      footHtml.push(`<td title="${Math.round(t.kg)} kg">${fmtKg(t.kg)}</td>`);
    }
    footHtml.push(`<td>${fmt(Math.round(grandTotalKg))}</td></tr>`);
    $("#byday-foot").innerHTML = footHtml.join("");

    // Click handlers para drill-down
    $$("#byday-body td.col-day.has-data").forEach((td) => {
      td.addEventListener("click", () => openDrilldown(td.dataset.email, td.dataset.day));
    });
  }

  // Modal drill-down: lista as entregas de 1 batedor num dia específico
  async function openDrilldown(email, day) {
    const overlay = $("#drill-overlay");
    const titleDate = new Date(day).toLocaleDateString("pt-MZ", {
      weekday: "long", day: "2-digit", month: "long", year: "numeric",
    });
    $("#drill-title").innerHTML = `Entregas de ${esc(email)}<br><small>${titleDate}</small>`;
    $("#drill-body").innerHTML = `<div class="empty"><span class="skel" style="width:120px"></span></div>`;
    overlay.classList.add("show");
    try {
      const params = new URLSearchParams();
      params.set("submitter", email);
      params.set("from", day);
      params.set("to", day);
      params.set("pageSize", "200");
      const data = await fetchJSON("/admin/api/audit/list?" + params);
      const rows = data.rows || [];
      if (!rows.length) {
        $("#drill-body").innerHTML = `<div class="empty">Sem entregas neste dia (estranho — recarrega).</div>`;
        return;
      }
      const totalKg = rows.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);
      const verified = rows.filter((r) => r.verification_status === "Verified").length;
      const pending  = rows.filter((r) => /pending/i.test(r.verification_status || "")).length;
      const rejected = rows.filter((r) => r.verification_status === "Rejected").length;
      $("#drill-body").innerHTML = `
        <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1rem;font-size:.85rem">
          <div><strong>${rows.length}</strong> submissões</div>
          <div><strong>${fmt(Math.round(totalKg))}</strong> kg total</div>
          <div style="color:#16a34a"><strong>${verified}</strong> verified</div>
          <div style="color:#d97706"><strong>${pending}</strong> pending</div>
          <div style="color:#dc2626"><strong>${rejected}</strong> rejected</div>
        </div>
        <table class="sub-detail-tbl" style="width:100%">
          <thead><tr>
            <th>Hora</th><th>GTU/ADSN</th><th>Beneficiário</th><th>Distrito</th>
            <th>Produto</th><th>Qty</th><th>Status</th>
          </tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td style="font-size:.74rem">${esc(new Date(r.detected_at).toLocaleTimeString("pt-MZ"))}</td>
                <td><code style="font-size:.72rem">${esc(r.gtu || r.adsn || "—")}</code></td>
                <td>${esc(r.beneficiary_name || "—")}</td>
                <td>${esc(r.district || "—")}</td>
                <td>${esc(r.product || "—")}</td>
                <td>${fmt(r.delivered_qty || 0)} ${esc(r.unit || "")}</td>
                <td>${statusPill(r.verification_status)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    } catch (e) {
      $("#drill-body").innerHTML = `<div class="empty" style="color:#dc2626">${esc(e.message)}</div>`;
    }
  }
  function closeDrilldown() { $("#drill-overlay").classList.remove("show"); }

  // Wire-up drill-down
  $("#drill-close")?.addEventListener("click", closeDrilldown);
  $("#drill-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "drill-overlay") closeDrilldown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrilldown();
  });
  $("#bd-days")?.addEventListener("change", loadByDay);

  // Export CSV/Excel da vista byday
  $$("[data-export-byday]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const fmt = a.dataset.exportByday;
      const days = $("#bd-days").value;
      window.open(`/admin/api/audit/by-day/export.${fmt}?days=${days}`, "_blank");
    });
  });

  // ── Tabs navigation (com dropdown "Mais") ────────────────
  // Tabs principais (sempre visíveis) — as restantes vivem no menu
  const PRIMARY_TABS = new Set(["byday", "ranking", "timeline", "all"]);

  function activateTab(name) {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".tab-more-item").forEach((m) => m.classList.remove("active"));
    $$(".tab-panel").forEach((p) => p.classList.remove("active"));

    const moreBtn = $("#tab-more-btn");
    if (moreBtn) moreBtn.classList.remove("active", "active-child");

    const isPrimary = PRIMARY_TABS.has(name);
    const tab = isPrimary
      ? document.querySelector(`.tab[data-tab="${name}"]`)
      : document.querySelector(`.tab-more-item[data-tab="${name}"]`);
    const panel = $("#tab-" + name);
    if (!tab || !panel) return;

    if (isPrimary) {
      tab.classList.add("active");
    } else {
      // Item dentro do dropdown — destaca o item + indica visualmente no botão "Mais"
      tab.classList.add("active");
      if (moreBtn) moreBtn.classList.add("active-child");
    }
    panel.classList.add("active");
    closeMoreMenu();
    writeUrlState();

    // Lazy-load conteúdo da tab
    switch (name) {
      case "byday":      loadByDay(); break;
      case "timeline":   loadTimeline(); break;
      case "all":        loadAll(); break;
      case "lost":       loadLost(); break;
      case "missing":    loadMissing(); break;
      case "anomalies":  loadAnomalies(); break;
      case "topdist":    loadTopDistricts(); break;
      case "topprod":    loadTopProducts(); break;
      case "planactual": loadPlanActual(); break;
      case "map":        setTimeout(loadMap, 50); break; // delay para o div ser visível
      default: break;
    }
  }

  // Tabs principais (header)
  $$(".tab[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });
  // Items do dropdown
  $$(".tab-more-item[data-tab]").forEach((item) => {
    item.addEventListener("click", () => activateTab(item.dataset.tab));
  });

  // Dropdown "Mais" — abrir/fechar
  function openMoreMenu() {
    const menu = $("#tab-more-menu");
    const btn = $("#tab-more-btn");
    if (menu) menu.hidden = false;
    if (btn) btn.setAttribute("aria-expanded", "true");
  }
  function closeMoreMenu() {
    const menu = $("#tab-more-menu");
    const btn = $("#tab-more-btn");
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
  $("#tab-more-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#tab-more-menu");
    if (!menu) return;
    if (menu.hidden) openMoreMenu();
    else closeMoreMenu();
  });
  // Fecha o menu ao clicar fora ou premir Escape
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".tab-more-wrap")) closeMoreMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMoreMenu();
  });

  // ── Sortable ranking ─────────────────────────────────────
  bindSortable($("#rank-tbl"), {
    get sortKey() { return sortState.sortKey; },
    set sortKey(v) { sortState.sortKey = v; },
    get sortAsc() { return sortState.sortAsc; },
    set sortAsc(v) { sortState.sortAsc = v; },
    render: renderRanking,
  });

  // ── Wire-up filtros ───────────────────────────────────────
  $("#tl-days")?.addEventListener("change", loadTimeline);
  $("#lost-days")?.addEventListener("change", loadLost);
  $("#btn-filter")?.addEventListener("click", () => { currentPage = 1; loadAll(); });
  $("#f-q")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { currentPage = 1; loadAll(); } });
  $("#btn-refresh")?.addEventListener("click", () => {
    loadCounts(); loadRanking();
    toast("Refrescado", { kind: "ok" });
  });

  // ── Export buttons ───────────────────────────────────────
  $$("[data-export]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const kind = a.dataset.export;
      const format = a.dataset.format;
      const params = new URLSearchParams();
      params.set("kind", kind);
      // Para "list" inclui filtros activos
      if (kind === "list") {
        if ($("#f-q")?.value)         params.set("q", $("#f-q").value);
        if ($("#f-status")?.value)    params.set("status", $("#f-status").value);
        if ($("#f-submitter")?.value) params.set("submitter", $("#f-submitter").value);
        if ($("#f-district")?.value)  params.set("district", $("#f-district").value);
        if ($("#f-from")?.value)      params.set("from", $("#f-from").value);
        if ($("#f-to")?.value)        params.set("to", $("#f-to").value);
      }
      if (kind === "lost" && $("#lost-days")) params.set("days_gap", $("#lost-days").value);
      const url = `/admin/api/audit/export.${format}?${params}`;
      window.open(url, "_blank");
    });
  });

  // ── Init ─────────────────────────────────────────────────
  readUrlState();
  loadCounts();
  // Tab default = "byday" (matriz kg). Se URL pede outra, activa-a.
  const urlTab = new URLSearchParams(location.search).get("tab");
  if (urlTab) activateTab(urlTab);
  else        activateTab("byday");
  // Pré-carrega o ranking em background (é barato e fica pronto se o user trocar de tab)
  setTimeout(() => loadRanking(), 200);
  AdminUI.renderLayout("audit-entregas");
})();
