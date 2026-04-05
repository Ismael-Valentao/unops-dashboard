/* ── AQI CEO Dashboard – Frontend ──────────────────────────── */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  let data = null;
  let chartProgress = null;

  function fmt(n) { return Number(n).toLocaleString("pt-PT"); }
  function fmtDec(n) { return Number(n).toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  function esc(s) { if (!s) return ""; const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  async function load() {
    try {
      const res = await fetch("/api/ceo-overview");
      data = await res.json();
      $("#hdr-updated").textContent = "Actualizado: " + new Date().toLocaleString("pt-PT");
      renderKPI();
      renderTimeline();
      renderScorecard();
      renderAlerts();
      renderGaps();
      renderProgress();
      renderProvinceChart();
      renderSupervisors();
    } catch (e) {
      console.error("Load error:", e);
    }
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

  // ── Attention Points (strategic only, no technical errors) ──
  function renderAlerts() {
    const list = $("#alerts-list");

    // Only show strategic items: provinces/districts without deliveries
    const items = [];
    const noDeliveryProv = data.provinces.filter((p) => p.pct === 0 && p.planned_kg > 0);
    noDeliveryProv.forEach((p) => {
      items.push({ icon: "🔴", msg: `${p.province}: ${fmtDec(p.planned_kg / 1000)}t planeadas, nenhuma entrega iniciada (${p.districts_total} distritos)`, severity: "critical" });
    });

    const slowProv = data.provinces.filter((p) => p.pct > 0 && p.pct < 20);
    slowProv.forEach((p) => {
      items.push({ icon: "🟠", msg: `${p.province}: apenas ${p.pct}% de execucao (${p.districts_active}/${p.districts_total} distritos activos)`, severity: "high" });
    });

    const weeklyKg = data.weekly.kg;
    const k = data.kpi;
    if (k.est_days_left && k.est_days_left > 120) {
      items.push({ icon: "🟡", msg: `Ao ritmo actual, o projecto levara ~${k.est_days_left} dias para concluir. Considerar acelerar entregas.`, severity: "medium" });
    }

    const noProductDelivery = data.gaps.filter((g) => g.pct === 0 && g.planned_kg > 0);
    noProductDelivery.forEach((g) => {
      items.push({ icon: "🟠", msg: `Produto "${g.product}": ${fmtDec(g.planned_kg / 1000)}t planeadas, sem qualquer entrega`, severity: "high" });
    });

    if (items.length === 0) {
      list.innerHTML = '<div class="alert-item" style="border-left-color:#16a34a"><span class="alert-icon">&#10003;</span><span class="alert-msg" style="color:#4ade80">Sem pontos de atencao — operacao no caminho certo</span></div>';
      return;
    }

    list.innerHTML = items.map((a) => {
      return `<div class="alert-item al-${a.severity}">
        <span class="alert-icon">${a.icon}</span>
        <span class="alert-msg">${esc(a.msg)}</span>
        <span class="alert-sev sv-${a.severity}">${a.severity === "critical" ? "critico" : a.severity === "high" ? "alto" : "medio"}</span>
      </div>`;
    }).join("");
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

  // ── Progress Chart ──────────────────────────────────────────
  function renderProgress() {
    const prog = data.progress;
    if (prog.length === 0) return;
    const labels = prog.map((p) => { const s = p.date.split("-"); return s[2] + "/" + s[1]; });

    if (chartProgress) chartProgress.destroy();
    chartProgress = new Chart($("#ceo-progress"), {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Entregue (t)",
          data: prog.map((p) => +(p.total_qty / 1000).toFixed(1)),
          borderColor: "#4ade80",
          backgroundColor: "rgba(74,222,128,.1)",
          fill: true, tension: .3, pointRadius: 5,
          pointBackgroundColor: "#4ade80",
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: "#1e293b" }, ticks: { color: "#64748b", font: { size: 10 } } },
          y: { grid: { color: "#1e293b" }, ticks: { color: "#64748b", font: { size: 10 } },
            title: { display: true, text: "Toneladas", color: "#64748b", font: { size: 10 } } },
        },
      },
    });
  }

  // ── Supervisors (no error column for CEO view) ──────────────
  function renderSupervisors() {
    const body = $("#sup-body");
    body.innerHTML = data.supervisors.map((s, i) => `<tr>
      <td style="font-weight:700;color:${i < 3 ? "#4ade80" : "#64748b"}">${i + 1}</td>
      <td style="font-weight:600;color:#fff">${esc(s.name)}</td>
      <td style="text-align:right">${fmt(s.deliveries)}</td>
      <td style="text-align:right">${fmtDec(s.total_kg / 1000)}</td>
      <td style="text-align:right">${fmt(s.districts)}</td>
    </tr>`).join("");
  }

  // ── Province Chart ──────────────────────────────────────────
  let chartProvince = null;
  function renderProvinceChart() {
    const provs = data.provinces.filter((p) => p.planned_kg > 0);
    const labels = provs.map((p) => p.province);

    if (chartProvince) chartProvince.destroy();
    chartProvince = new Chart($("#ceo-province-chart"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Planeado (t)", data: provs.map((p) => +(p.planned_kg / 1000).toFixed(1)), backgroundColor: "rgba(148,163,184,.4)", borderRadius: 6 },
          { label: "Entregue (t)", data: provs.map((p) => +(p.delivered_kg / 1000).toFixed(1)), backgroundColor: "#4ade80", borderRadius: 6 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "top", labels: { color: "#94a3b8", boxWidth: 12, font: { size: 10 } } } },
        scales: {
          x: { grid: { color: "#1e293b" }, ticks: { color: "#94a3b8", font: { size: 10 } } },
          y: { grid: { color: "#1e293b" }, ticks: { color: "#94a3b8", font: { size: 9 } },
            title: { display: true, text: "Toneladas", color: "#64748b", font: { size: 10 } } },
        },
      },
    });
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

    // Status
    let statusLines = [];
    statusLines.push(`Execucao global a ${k.global_pct}%: ${fmt(deliveredT)}t entregues de ${fmt(plannedT)}t planeadas.`);
    statusLines.push(`Ritmo actual: ${(k.avg_kg_per_day / 1000).toFixed(1)}t/dia. Estimativa de conclusao: ${k.est_days_left ? k.est_days_left + " dias" : "indeterminado"}.`);
    statusLines.push(`${k.total_deliveries} entregas registadas em ${k.day_span} dias de operacao.`);

    // Risks (strategic only)
    const risks = [];
    const noProv = data.provinces.filter((p) => p.pct === 0 && p.planned_kg > 0);
    if (noProv.length > 0) risks.push(`${noProv.length} provincia(s) sem qualquer entrega: ${noProv.map((p) => p.province).join(", ")}`);
    const noProd = data.gaps.filter((g) => g.pct === 0 && g.planned_kg > 0);
    if (noProd.length > 0) risks.push(`${noProd.length} produto(s) sem entregas: ${noProd.map((g) => g.product).join(", ")}`);
    if (k.est_days_left && k.est_days_left > 120) risks.push(`Projeccao de conclusao excede 120 dias ao ritmo actual`);
    if (risks.length === 0) risks.push("Sem riscos significativos identificados");

    // Progress
    const progressItems = [];
    data.provinces.filter((p) => p.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 5)
      .forEach((p) => progressItems.push(`${p.province}: ${p.pct}% (${p.districts_active} distritos activos)`));
    if (data.weekly.kg > 0) progressItems.push(`Ultimos 7 dias: ${fmtDec(data.weekly.kg / 1000)}t em ${data.weekly.deliveries} entregas`);

    // Decisions
    const decisions = [];
    const noDelivery = data.provinces.filter((p) => p.pct === 0);
    if (noDelivery.length > 0) decisions.push(`Priorizar inicio de entregas em: ${noDelivery.map((p) => p.province).join(", ")}`);
    const worstProducts = data.gaps.filter((g) => g.pct === 0);
    if (worstProducts.length > 0) decisions.push(`Produtos sem qualquer entrega: ${worstProducts.map((g) => g.product).join(", ")}`);
    if (noDelivery.length > 0) decisions.push(`Alocar recursos para iniciar operacoes em ${noDelivery.length} provincia(s) sem entregas`);
    decisions.push(`Manter ritmo minimo de ${Math.round(remainingT / 90)}t/dia para concluir em 90 dias`);

    const content = $("#briefing-content");
    content.innerHTML = `
      <div class="brief-section">
        <div class="brief-title">Briefing Semanal — ${dateStr}</div>
      </div>
      <div class="brief-section">
        <div class="brief-title">Estado Actual</div>
        ${statusLines.map((s) => `<div class="brief-item">${esc(s)}</div>`).join("")}
      </div>
      <div class="brief-section">
        <div class="brief-title">Riscos e Problemas (${risks.length})</div>
        ${risks.length > 0 ? risks.map((r) => `<div class="brief-item bi-risk">${esc(r)}</div>`).join("") : '<div class="brief-item">Sem riscos identificados</div>'}
      </div>
      <div class="brief-section">
        <div class="brief-title">Progressos da Semana</div>
        ${progressItems.map((p) => `<div class="brief-item bi-progress">${esc(p)}</div>`).join("")}
      </div>
      <div class="brief-section">
        <div class="brief-title">Decisoes Necessarias</div>
        ${decisions.map((d) => `<div class="brief-item bi-decision">${esc(d)}</div>`).join("")}
      </div>
    `;

    $("#briefing-modal").style.display = "flex";
  }

  // ── Init ────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    load();
    setInterval(load, 5 * 60 * 1000);
    $("#btn-briefing").addEventListener("click", generateBriefing);
    $("#briefing-close").addEventListener("click", () => { $("#briefing-modal").style.display = "none"; });
    $("#briefing-modal").addEventListener("click", (e) => {
      if (e.target === $("#briefing-modal")) $("#briefing-modal").style.display = "none";
    });
  });
})();
