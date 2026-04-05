/* ── AQI CEO Dashboard – Frontend ──────────────────────────── */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  let data = null;
  let pvdData = null;

  function fmt(n) { return Number(n).toLocaleString("pt-PT"); }
  function fmtDec(n) { return Number(n).toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function esc(s) { if (!s) return ""; const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  // ── Filters ─────────────────────────────────────────────────
  const cfProvince = $("#cf-province");
  const cfDistrict = $("#cf-district");
  const cfProduct = $("#cf-product");

  function getFilters() {
    return { province: cfProvince.value, district: cfDistrict.value, product: cfProduct.value };
  }

  function buildQS() {
    const f = getFilters();
    const p = new URLSearchParams();
    if (f.province) p.set("province", f.province);
    if (f.district) p.set("district", f.district);
    if (f.product) p.set("product", f.product);
    return p.toString();
  }

  function populateFilters() {
    if (!data) return;
    // Provinces from overview
    const provs = data.provinces.map((p) => p.province).sort();
    fillSelect(cfProvince, provs, "Todas Provincias");

    // Districts from PvD data
    if (pvdData) {
      let dists = pvdData.by_district.map((d) => d.district);
      const prov = cfProvince.value;
      if (prov) dists = pvdData.by_district.filter((d) => d.province === prov).map((d) => d.district);
      fillSelect(cfDistrict, [...new Set(dists)].sort(), "Todos Distritos");
    }

    // Products from PvD data
    if (pvdData) {
      const prods = pvdData.by_product.map((p) => p.product);
      fillSelect(cfProduct, prods.sort(), "Todos Produtos");
    }
  }

  function fillSelect(el, values, placeholder) {
    const cur = el.value;
    el.innerHTML = `<option value="">${placeholder}</option>` +
      values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    if (values.includes(cur)) el.value = cur;
  }

  // ── Data Loading ────────────────────────────────────────────
  async function load() {
    try {
      const [ovRes, pvdRes] = await Promise.all([
        fetch("/api/ceo-overview"),
        fetch("/api/planned-vs-delivered?" + buildQS()),
      ]);
      data = await ovRes.json();
      pvdData = await pvdRes.json();

      $("#hdr-updated").textContent = "Actualizado: " + new Date().toLocaleString("pt-PT");
      populateFilters();
      renderAll();
    } catch (e) {
      console.error("Load error:", e);
    }
  }

  async function reloadPvD() {
    try {
      const res = await fetch("/api/planned-vs-delivered?" + buildQS());
      pvdData = await res.json();
      renderPvD();
    } catch (e) {
      console.error("PvD reload error:", e);
    }
  }

  function renderAll() {
    renderKPI();
    renderTimeline();
    renderScorecard();
    renderPvD();
    renderAlerts();
    renderGaps();
    renderSupervisors();
  }

  function renderPvD() {
    renderDistrictTable();
  }

  // ── KPI Strip ───────────────────────────────────────────────
  function renderKPI() {
    const k = data.kpi;
    const deliveredT = Math.round(k.total_delivered / 1000);
    const remainingT = Math.round(k.remaining / 1000);
    const velocityT = (k.avg_kg_per_day / 1000).toFixed(1);

    $("#kpi-pct").textContent = k.global_pct + "%";
    $("#kpi-bar").style.width = Math.min(k.global_pct, 100) + "%";
    $("#kpi-sub").textContent = fmt(deliveredT) + "t de " + fmt(Math.round(k.total_planned / 1000)) + "t planeadas | " + k.total_deliveries + " registos";
    $("#kpi-delivered").textContent = fmt(deliveredT);
    $("#kpi-remaining").textContent = fmt(remainingT);
    $("#kpi-velocity").textContent = velocityT;
    $("#kpi-days").textContent = k.est_days_left ? fmt(k.est_days_left) : "N/A";
  }

  // ── Timeline ────────────────────────────────────────────────
  function renderTimeline() {
    const k = data.kpi;
    if (!k.first_date) return;
    const start = new Date(k.first_date);
    const today = new Date();
    const estEnd = k.est_days_left ? new Date(today.getTime() + k.est_days_left * 86400000) : new Date(today.getTime() + 90 * 86400000);
    const totalSpan = estEnd - start;
    const elapsed = today - start;
    const pctElapsed = Math.min(100, Math.max(0, (elapsed / totalSpan) * 100));

    $("#timeline-fill").style.width = k.global_pct + "%";
    $("#timeline-today").style.left = pctElapsed + "%";

    const pad = (n) => String(n).padStart(2, "0");
    const fmtDate = (d) => pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear();
    $("#tl-start").textContent = "Inicio: " + fmtDate(start);
    $("#tl-today").textContent = "Hoje: " + fmtDate(today);
    $("#tl-end").textContent = "Est. conclusao: " + fmtDate(estEnd);
  }

  // ── Province Scorecard ──────────────────────────────────────
  function renderScorecard() {
    const grid = $("#score-grid");
    grid.innerHTML = data.provinces.map((p) => {
      const cls = p.pct >= 95 ? "green" : p.pct > 0 ? "amber" : "red";
      const c = cls === "green" ? "g" : cls === "amber" ? "a" : "r";
      return `<div class="score-card sc-${cls}">
        <div class="sc-name">${esc(p.province)}</div>
        <div class="sc-pct sc-${c}">${p.pct}%</div>
        <div class="sc-bar"><div class="sc-bar-fill sc-${c}" style="width:${Math.min(p.pct, 100)}%"></div></div>
        <div class="sc-stats">
          ${fmtDec(p.delivered_kg / 1000)}t / ${fmtDec(p.planned_kg / 1000)}t
          &bull; ${p.districts_active}/${p.districts_total} distritos activos
        </div>
      </div>`;
    }).join("");
  }

  // ── PvD District Chart ──────────────────────────────────────
  // ── District Summary Table ──────────────────────────────────
  function renderDistrictTable() {
    if (!pvdData) return;
    const rows = pvdData.by_district.filter((d) => d.planned_kg > 0);
    const statusBadge = (s) => {
      if (s === "Completo") return '<span style="color:#4ade80;font-weight:700">Completo</span>';
      if (s === "Em progresso") return '<span style="color:#fbbf24;font-weight:700">Em progresso</span>';
      return '<span style="color:#f87171;font-weight:700">Sem entregas</span>';
    };
    $("#ceo-district-body").innerHTML = rows.map((d) => `<tr>
      <td style="font-weight:600;color:#fff">${esc(d.district)}</td>
      <td>${esc(d.province)}</td>
      <td style="text-align:right">${fmtDec(d.planned_kg / 1000)}</td>
      <td style="text-align:right">${fmtDec(d.delivered_kg / 1000)}</td>
      <td style="text-align:right;color:${d.diff < 0 ? "#f87171" : "#4ade80"}">${fmtDec(Math.abs(d.planned_kg - d.delivered_kg) / 1000)}</td>
      <td style="text-align:right;font-weight:700;color:${d.pct >= 95 ? "#4ade80" : d.pct > 0 ? "#fbbf24" : "#f87171"}">${d.pct}%</td>
      <td>${statusBadge(d.status)}</td>
    </tr>`).join("");
  }

  // ── Attention Points ────────────────────────────────────────
  function renderAlerts() {
    const list = $("#alerts-list");
    const items = [];
    const noDeliveryProv = data.provinces.filter((p) => p.pct === 0 && p.planned_kg > 0);
    noDeliveryProv.forEach((p) => {
      items.push({ icon: "&#128308;", msg: `${p.province}: ${fmtDec(p.planned_kg / 1000)}t planeadas, nenhuma entrega iniciada (${p.districts_total} distritos)`, severity: "critical" });
    });
    const slowProv = data.provinces.filter((p) => p.pct > 0 && p.pct < 20);
    slowProv.forEach((p) => {
      items.push({ icon: "&#128992;", msg: `${p.province}: apenas ${p.pct}% de execucao (${p.districts_active}/${p.districts_total} distritos activos)`, severity: "high" });
    });
    if (data.kpi.est_days_left && data.kpi.est_days_left > 120) {
      items.push({ icon: "&#128993;", msg: `Ao ritmo actual, o projecto levara ~${data.kpi.est_days_left} dias para concluir. Considerar acelerar entregas.`, severity: "medium" });
    }
    const noProd = data.gaps.filter((g) => g.pct === 0 && g.planned_kg > 0);
    noProd.forEach((g) => {
      items.push({ icon: "&#128992;", msg: `Produto "${g.product}": ${fmtDec(g.planned_kg / 1000)}t planeadas, sem qualquer entrega`, severity: "high" });
    });
    if (items.length === 0) {
      list.innerHTML = '<div class="alert-item" style="border-left-color:#16a34a"><span class="alert-icon">&#10003;</span><span class="alert-msg" style="color:#4ade80">Sem pontos de atencao</span></div>';
      return;
    }
    list.innerHTML = items.map((a) => `<div class="alert-item al-${a.severity}">
      <span class="alert-icon">${a.icon}</span>
      <span class="alert-msg">${esc(a.msg)}</span>
      <span class="alert-sev sv-${a.severity}">${a.severity === "critical" ? "critico" : a.severity === "high" ? "alto" : "medio"}</span>
    </div>`).join("");
  }

  // ── Gap Analysis ────────────────────────────────────────────
  function renderGaps() {
    const maxGap = Math.max(...data.gaps.map((g) => g.planned_kg), 1);
    $("#ceo-gaps").innerHTML = data.gaps.map((g) => {
      const pctW = (g.planned_kg / maxGap) * 100;
      const fillW = g.planned_kg > 0 ? (g.delivered_kg / g.planned_kg) * 100 : 0;
      const cls = fillW >= 95 ? "gf-ok" : fillW > 0 ? "gf-warn" : "gf-bad";
      const gapT = Math.round(g.gap_kg / 1000);
      return `<div class="ceo-gap-row">
        <div class="ceo-gap-lbl">${esc(g.product)}</div>
        <div class="ceo-gap-bar" style="width:${pctW}%">
          <div class="ceo-gap-fill ${cls}" style="width:${Math.min(fillW, 100)}%"></div>
          <span class="ceo-gap-text">${g.pct}%</span>
        </div>
        <div class="ceo-gap-val">-${fmt(gapT)}t</div>
      </div>`;
    }).join("");
  }

  // ── Supervisors ─────────────────────────────────────────────
  function renderSupervisors() {
    $("#sup-body").innerHTML = data.supervisors.map((s, i) => `<tr>
      <td style="font-weight:700;color:${i < 3 ? "#4ade80" : "#64748b"}">${i + 1}</td>
      <td style="font-weight:600;color:#fff">${esc(s.name)}</td>
      <td style="text-align:right">${fmt(s.deliveries)}</td>
      <td style="text-align:right">${fmtDec(s.total_kg / 1000)}</td>
      <td style="text-align:right">${fmt(s.districts)}</td>
    </tr>`).join("");
  }

  // ── Briefing Generator ──────────────────────────────────────
  function generateBriefing() {
    const k = data.kpi;
    const pad = (n) => String(n).padStart(2, "0");
    const today = new Date();
    const dateStr = pad(today.getDate()) + "/" + pad(today.getMonth() + 1) + "/" + today.getFullYear();
    const deliveredT = Math.round(k.total_delivered / 1000);
    const plannedT = Math.round(k.total_planned / 1000);
    const remainingT = plannedT - deliveredT;

    const statusLines = [
      `Execucao global a ${k.global_pct}%: ${fmt(deliveredT)}t entregues de ${fmt(plannedT)}t planeadas.`,
      `Ritmo actual: ${(k.avg_kg_per_day / 1000).toFixed(1)}t/dia. Estimativa de conclusao: ${k.est_days_left ? k.est_days_left + " dias" : "indeterminado"}.`,
      `${k.total_deliveries} entregas registadas em ${k.day_span} dias de operacao.`,
    ];
    const risks = [];
    const noProv = data.provinces.filter((p) => p.pct === 0 && p.planned_kg > 0);
    if (noProv.length > 0) risks.push(`${noProv.length} provincia(s) sem entregas: ${noProv.map((p) => p.province).join(", ")}`);
    const noProd = data.gaps.filter((g) => g.pct === 0 && g.planned_kg > 0);
    if (noProd.length > 0) risks.push(`${noProd.length} produto(s) sem entregas: ${noProd.map((g) => g.product).join(", ")}`);
    if (k.est_days_left && k.est_days_left > 120) risks.push("Projeccao de conclusao excede 120 dias");
    if (risks.length === 0) risks.push("Sem riscos significativos");

    const progressItems = [];
    data.provinces.filter((p) => p.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 5)
      .forEach((p) => progressItems.push(`${p.province}: ${p.pct}% (${p.districts_active} distritos activos)`));
    if (data.weekly.kg > 0) progressItems.push(`Ultimos 7 dias: ${fmtDec(data.weekly.kg / 1000)}t em ${data.weekly.deliveries} entregas`);

    const decisions = [];
    if (noProv.length > 0) decisions.push(`Priorizar inicio de entregas em: ${noProv.map((p) => p.province).join(", ")}`);
    if (noProd.length > 0) decisions.push(`Activar entregas de: ${noProd.map((g) => g.product).join(", ")}`);
    decisions.push(`Manter ritmo minimo de ${Math.round(remainingT / 90)}t/dia para concluir em 90 dias`);

    $("#briefing-content").innerHTML = `
      <div class="brief-section"><div class="brief-title">Briefing Semanal — ${dateStr}</div></div>
      <div class="brief-section"><div class="brief-title">Estado Actual</div>
        ${statusLines.map((s) => `<div class="brief-item">${esc(s)}</div>`).join("")}</div>
      <div class="brief-section"><div class="brief-title">Riscos (${risks.length})</div>
        ${risks.map((r) => `<div class="brief-item bi-risk">${esc(r)}</div>`).join("")}</div>
      <div class="brief-section"><div class="brief-title">Progressos</div>
        ${progressItems.map((p) => `<div class="brief-item bi-progress">${esc(p)}</div>`).join("")}</div>
      <div class="brief-section"><div class="brief-title">Decisoes Necessarias</div>
        ${decisions.map((d) => `<div class="brief-item bi-decision">${esc(d)}</div>`).join("")}</div>
    `;
    $("#briefing-modal").style.display = "flex";
  }

  // ── Init ────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    load();
    setInterval(load, 5 * 60 * 1000);

    // Filter events
    cfProvince.addEventListener("change", () => {
      // Cascade district options
      if (pvdData) {
        let dists = pvdData.by_district.map((d) => d.district);
        if (cfProvince.value) dists = pvdData.by_district.filter((d) => d.province === cfProvince.value).map((d) => d.district);
        fillSelect(cfDistrict, [...new Set(dists)].sort(), "Todos Distritos");
      }
      reloadPvD();
    });
    cfDistrict.addEventListener("change", reloadPvD);
    cfProduct.addEventListener("change", reloadPvD);
    $("#cf-clear").addEventListener("click", () => {
      cfProvince.value = "";
      cfDistrict.value = "";
      cfProduct.value = "";
      reloadPvD();
    });

    // Briefing
    $("#btn-briefing").addEventListener("click", generateBriefing);
    $("#briefing-close").addEventListener("click", () => { $("#briefing-modal").style.display = "none"; });
    $("#briefing-modal").addEventListener("click", (e) => {
      if (e.target === $("#briefing-modal")) $("#briefing-modal").style.display = "none";
    });
  });
})();
