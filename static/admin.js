/* ── AQI Admin UI helpers ─────────────────────────────────── */
window.AdminUI = (function () {
  // SVG icons (Lucide-style, monochrome 16×16 strokes). Inline so the
  // sidebar renders without external requests and stays consistent.
  const ICO = {
    dashboard:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
    target:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>',
    truck:        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 17h2a2 2 0 0 0 4 0h6a2 2 0 0 0 4 0h2v-5l-3-4h-3V5H1z"/><circle cx="5" cy="17" r="2"/><circle cx="15" cy="17" r="2"/></svg>',
    list:         '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    file:         '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    inbox:        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    outbox:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="12" y1="2" x2="12" y2="9"/><polyline points="9 5 12 2 15 5"/></svg>',
    ticket:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a3 3 0 0 0 0 6v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a3 3 0 0 0 0-6z"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
    package:      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    tag:          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    factory:      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20V10l-6 4V10l-6 4V10l-6 4z"/><path d="M6 20V8a2 2 0 0 1 2-2h2"/></svg>',
    warehouse:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><polyline points="3 9 12 15 21 9"/></svg>',
    map:          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
    clipboard:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>',
    shield:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    users:        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    bell:         '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    phone:        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  };

  const NAV = [
    { key: "dashboard",       label: "Dashboard",         icon: ICO.dashboard,  href: "/admin" },
    { key: "lembretes",       label: "Lembretes",         icon: ICO.bell,       href: "/admin/lembretes", badge: "reminders" },
    { key: "sms",             label: "SMS",               icon: ICO.phone,      href: "/admin/sms" },
    { section: "Distribuição" },
    { key: "distribuicao",    label: "Saldo & Despachar", icon: ICO.target,     href: "/admin/distribuicao" },
    { key: "beneficiarios",   label: "Beneficiários",     icon: ICO.users,      href: "/admin/beneficiarios" },
    { key: "servicos",        label: "Serviços",          icon: ICO.list,       href: "/admin/servicos" },
    { key: "camioes",         label: "Camiões",           icon: ICO.truck,      href: "/admin/camioes" },
    { key: "aprovacoes",      label: "Aprovações",        icon: ICO.shield,     href: "/admin/aprovacoes", roles: ["admin", "superadmin"] },
    { key: "anexar-guias",    label: "Anexar Guias",      icon: ICO.file,       href: "/admin/anexar-guias" },
    { key: "guias-pdf",       label: "PDF → Excel",       icon: ICO.file,       href: "/admin/guias-pdf" },
    { key: "audit-entregas",  label: "Auditoria Entregas",icon: ICO.shield,     href: "/admin/audit-entregas" },
    { key: "reconciliacao",   label: "Reconciliação",     icon: ICO.clipboard,  href: "/admin/reconciliacao" },
    { key: "relatorio-provincias", label: "Relatório por Província", icon: ICO.map, href: "/admin/relatorio-provincias" },
    { key: "origens",         label: "Origens (API DMS)", icon: ICO.factory, href: "/admin/origens" },
    { key: "fornecido",       label: "Fornecido (TRA+FIN)", icon: ICO.factory, href: "/admin/fornecido" },
    { key: "supplier-metas",  label: "Metas de Contratação", icon: ICO.clipboard, href: "/admin/supplier-metas", roles: ["admin","superadmin"] },
    { key: "entregas",        label: "Entregas (Live)",   icon: ICO.list,    href: "/admin/entregas" },
    { key: "viagens",         label: "Viagens (Mapa)",    icon: ICO.truck,   href: "/admin/viagens" },
    { section: "Compras" },
    { key: "purchase-orders", label: "Purchase Orders",   icon: ICO.file,       href: "/admin/purchase-orders" },
    { key: "authorizations",  label: "Autorizações",      icon: ICO.clipboard,  href: "/admin/authorizations" },
    { key: "entries",         label: "Entradas",          icon: ICO.inbox,      href: "/admin/entries" },
    { section: "Saídas" },
    { key: "adsn",            label: "ADSNs",             icon: ICO.ticket,     href: "/admin/adsn" },
    { key: "exits",           label: "Saídas",            icon: ICO.outbox,     href: "/admin/exits" },
    { section: "Stock" },
    { key: "stock",           label: "Stock",             icon: ICO.package,    href: "/admin/stock" },
    { key: "products",        label: "Produtos",          icon: ICO.tag,        href: "/admin/products" },
    { key: "suppliers",       label: "Fornecedores",      icon: ICO.factory,    href: "/admin/suppliers" },
    { section: "Legado" },
    { key: "trucks",          label: "Camiões",           icon: ICO.truck,      href: "/admin/trucks" },
    { key: "departures",      label: "Saídas (legado)",   icon: ICO.outbox,     href: "/admin/departures" },
    { key: "warehouses",      label: "Armazéns",          icon: ICO.warehouse,  href: "/admin/warehouses" },
    { key: "plans",           label: "Planos",            icon: ICO.map,        href: "/admin/plans" },
    { key: "requisitions",    label: "Requisições",       icon: ICO.clipboard,  href: "/admin/requisitions" },
    { section: "Admin" },
    { key: "audit",           label: "Auditoria",         icon: ICO.shield,     href: "/admin/audit", roles: ["superadmin", "admin"] },
    { key: "users",           label: "Utilizadores",      icon: ICO.users,      href: "/admin/users", roles: ["superadmin"] },
  ];

  function esc(s) {
    if (s == null) return "";
    const d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  function fmt(n) {
    if (n == null || n === "") return "—";
    return Number(n).toLocaleString("pt-PT", { maximumFractionDigits: 2 });
  }

  function fmtDate(s) {
    if (!s) return "—";
    const d = new Date(s.replace ? s.replace(" ", "T") : s);
    if (isNaN(d)) return esc(s);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function statusBadge(status) {
    const labels = {
      expected: "Esperado", arrived: "Chegou", unloading: "A descarregar",
      unloaded: "Descarregado", transferred: "Transferido", cancelled: "Cancelado",
      pending: "Pendente", partial: "Parcial", received: "Recebida",
      planned: "Planeada", in_transit: "Em transito", delivered: "Entregue",
      draft: "Rascunho", reserved: "Reservado", executing: "Em execucao", completed: "Completo",
      issued: "Emitida", in_pickup: "Em levantamento", closed: "Fechada",
      dispatched: "Despachado",
    };
    return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
  }

  // ── Product/Warehouse loaders cached ────────────────────────
  let _productsCache = null;
  let _warehousesCache = null;
  async function loadProducts() {
    if (!_productsCache) _productsCache = await fetchJSON("/admin/api/products");
    return _productsCache;
  }
  async function loadWarehouses() {
    if (!_warehousesCache) _warehousesCache = await fetchJSON("/admin/api/warehouses");
    return _warehousesCache;
  }
  function clearCache() { _productsCache = null; _warehousesCache = null; }
  function productSelectOptions(products, selectedId) {
    return '<option value="">— Seleccionar produto —</option>' +
      products.map((p) => `<option value="${p.id}" data-unit="${p.default_unit}" ${p.id == selectedId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  }

  async function fetchJSON(url, opts) {
    const o = opts || {};
    if (o.body && typeof o.body === "object" && !(o.body instanceof FormData)) {
      o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
      o.body = JSON.stringify(o.body);
    }
    const res = await fetch(url, o);
    if (res.status === 401) { location.href = "/admin/login"; return; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || res.statusText);
    return json;
  }

  let currentUser = null;
  async function loadMe() {
    if (currentUser) return currentUser;
    try {
      currentUser = await fetchJSON("/admin/api/me");
    } catch (e) { currentUser = null; }
    return currentUser;
  }

  async function renderLayout(activeKey) {
    const me = await loadMe();
    if (!me) { location.href = "/admin/login"; return; }

    const links = NAV.filter((n) => !n.roles || n.roles.includes(me.role)).map((n) => {
      if (n.section) return `<div class="sb-section">${esc(n.section)}</div>`;
      // Suporta badge dinâmica (ex: lembretes pendentes/vencidos)
      const badgeId = n.badge ? `id="sb-badge-${n.badge}"` : "";
      const badge = n.badge
        ? `<span class="sb-badge" ${badgeId} style="display:none"></span>`
        : "";
      return `<a href="${n.href}" class="sb-link ${n.key === activeKey ? "active" : ""}">
        <span class="sb-icon">${n.icon}</span>${n.label}${badge}
      </a>`;
    }).join("");

    document.getElementById("layout").innerHTML = `
      <aside class="sidebar">
        <div class="sb-logo">
          <div class="sb-logo-title">AQI Operacoes</div>
          <div class="sb-logo-sub">Sistema interno</div>
        </div>
        <nav class="sb-nav">${links}</nav>
        <div class="sb-foot">
          <div class="sb-user">${esc(me.name)}</div>
          <div class="sb-role">${esc(me.role)}</div>
          <form method="POST" action="/admin/logout" style="margin:0">
            <button type="submit" class="sb-logout">Sair &rarr;</button>
          </form>
        </div>
      </aside>
    `;

    // Carrega contagens de lembretes e (a) actualiza badge na sidebar,
    // (b) injecta banner global de aviso se há vencidos. Falha silenciosamente
    // se utilizador não tem permissão (eg. sem login).
    refreshReminderBadge().catch(() => { /* ignore */ });
    // Re-fetch periódico (a cada 60s) para manter badge actualizado
    if (!window._remindersInterval) {
      window._remindersInterval = setInterval(() => {
        refreshReminderBadge().catch(() => { /* ignore */ });
      }, 60000);
    }
  }

  // Pede contagens de lembretes ao backend e actualiza:
  //  • Badge na sidebar (vermelho se há vencidos, azul se só pendentes)
  //  • Banner global no topo do main quando há vencidos (1ª vez ou sumiu)
  async function refreshReminderBadge() {
    let counts = null;
    try {
      counts = await fetchJSON("/admin/api/reminders/counts");
    } catch (_) { return; }
    const badge = document.getElementById("sb-badge-reminders");
    if (badge) {
      if (counts.due > 0) {
        badge.textContent = counts.due;
        badge.style.display = "";
        badge.classList.add("sb-badge-due");
        badge.title = counts.due + " lembrete(s) vencido(s) — atenção!";
      } else if (counts.active > 0) {
        badge.textContent = counts.active;
        badge.style.display = "";
        badge.classList.remove("sb-badge-due");
        badge.title = counts.active + " lembrete(s) activo(s)";
      } else {
        badge.style.display = "none";
      }
    }
    // Banner global de vencidos — só na home /admin (evita duplicação)
    renderRemindersBanner(counts);
  }

  // Injecta/remove banner laranja no topo do <main> quando há lembretes
  // vencidos. É idempotente — chama-se sempre que counts muda.
  function renderRemindersBanner(counts) {
    const existing = document.getElementById("rem-banner");
    if (!counts || !counts.due) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      // Actualiza contagem se já existir
      const numEl = existing.querySelector(".rem-banner-num");
      if (numEl) numEl.textContent = counts.due;
      return;
    }
    const main = document.querySelector("main.admin-main");
    if (!main) return;
    const banner = document.createElement("div");
    banner.id = "rem-banner";
    banner.className = "rem-banner";
    banner.innerHTML = `
      <span class="rem-banner-ico">⚠</span>
      <span class="rem-banner-text">
        <strong><span class="rem-banner-num">${counts.due}</span> lembrete(s) vencido(s)</strong> — precisam da tua atenção
      </span>
      <a href="/admin/lembretes" class="rem-banner-btn">Ver lembretes →</a>
      <button class="rem-banner-close" title="Fechar">×</button>
    `;
    main.insertBefore(banner, main.firstChild);
    banner.querySelector(".rem-banner-close").addEventListener("click", () => banner.remove());
  }

  // ── Sortable tables ─────────────────────────────────────────
  // Helper genérico: ordena um array de rows por uma chave + direção,
  // com tipos string/number/date. Usado por todas as tabelas admin para
  // permitir clicar em <th data-sort="key" data-sort-type="number">.
  function sortRows(rows, key, asc, type) {
    if (!key) return rows;
    const sign = asc ? 1 : -1;
    return [...rows].sort((a, b) => {
      let va = a[key], vb = b[key];
      if (type === "number") {
        va = Number(va) || 0; vb = Number(vb) || 0;
      } else if (type === "date") {
        const pa = va ? new Date(String(va).replace(" ", "T")).getTime() : 0;
        const pb = vb ? new Date(String(vb).replace(" ", "T")).getTime() : 0;
        va = isNaN(pa) ? 0 : pa;
        vb = isNaN(pb) ? 0 : pb;
      } else {
        va = String(va || "").toLowerCase();
        vb = String(vb || "").toLowerCase();
      }
      if (va < vb) return -sign;
      if (va > vb) return sign;
      return 0;
    });
  }

  // Devolve o HTML do indicador de ordenação para o <th> activo.
  function sortArrow(key, sortKey, asc) {
    if (key !== sortKey) return '<span class="sort-arrow">↕</span>';
    return asc ? '<span class="sort-arrow active">↑</span>'
               : '<span class="sort-arrow active">↓</span>';
  }

  // Liga os clicks em <th data-sort> de uma tabela a um state holder.
  // state = { sortKey, sortAsc, render }. Chamado uma vez após renderizar
  // os headers com data-sort attributes.
  function bindSortable(tableEl, state) {
    if (!tableEl) return;
    tableEl.querySelectorAll("th[data-sort]").forEach((th) => {
      th.classList.add("sortable");
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortAsc = !state.sortAsc;
        else { state.sortKey = k; state.sortAsc = true; }
        if (typeof state.render === "function") state.render();
      });
    });
  }

  // ── Global search (Cmd+K / Ctrl+K) ──────────────────────────
  // Mounts a floating overlay that searches services, beneficiaries
  // and plates simultaneously. Triggered by ⌘K / Ctrl+K from any page.
  function mountGlobalSearch() {
    if (document.getElementById("gsearch-modal")) return; // already mounted
    const STATUS_LABEL = { draft: "Rascunho", in_transit: "Em Trânsito", delivered: "Entregue", cancelled: "Cancelado" };
    const wrap = document.createElement("div");
    wrap.id = "gsearch-modal";
    wrap.innerHTML = `
      <div class="gs-overlay"></div>
      <div class="gs-box">
        <div class="gs-input-wrap">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#94a3b8">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input id="gs-input" type="text" placeholder="Pesquisar serviços, beneficiários, matrículas… (mínimo 2 caracteres)" autocomplete="off">
          <kbd class="gs-esc">Esc</kbd>
        </div>
        <div id="gs-results" class="gs-results">
          <div class="gs-hint">
            Comece a escrever para procurar.
            <div style="margin-top:.5rem;font-size:.72rem;color:#94a3b8">
              Ex: nome de beneficiário, NUIT, número de serviço (SRV-…), ADSN, GTU, matrícula.
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    const input = document.getElementById("gs-input");
    const results = document.getElementById("gs-results");
    let lastQuery = "";
    let timer = null;

    function open() { wrap.classList.add("show"); setTimeout(() => input.focus(), 50); }
    function close() { wrap.classList.remove("show"); input.value = ""; lastQuery = ""; results.innerHTML = ""; }

    const ICO_USER = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    const ICO_PKG  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
    const ICO_TRK  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 17h2a2 2 0 0 0 4 0h6a2 2 0 0 0 4 0h2v-5l-3-4h-3V5H1z"/><circle cx="5" cy="17" r="2"/><circle cx="15" cy="17" r="2"/></svg>';

    async function doSearch(q) {
      if (q.length < 2) {
        results.innerHTML = '<div class="gs-hint">Mínimo 2 caracteres.</div>';
        return;
      }
      try {
        const data = await fetchJSON("/admin/api/distribution/search?q=" + encodeURIComponent(q));
        const sections = [];
        if (data.beneficiaries?.length) {
          sections.push(`<div class="gs-section-title">Beneficiários (${data.beneficiaries.length})</div>` +
            data.beneficiaries.map((b) => `<a class="gs-item" href="/admin/beneficiarios/${encodeURIComponent(b.extensionist_id)}">
              <span class="gs-item-icon">${ICO_USER}</span>
              <div class="gs-item-body">
                <div><strong>${esc(b.name)}</strong>${b.is_extra ? '<span class="gs-tag">Extra</span>' : ''}</div>
                <div class="gs-item-meta"><code>${esc(b.extensionist_id)}</code> · NUIT <code>${esc(b.nuit || "—")}</code> · ${esc(b.province || "")}/${esc(b.district || "")}</div>
              </div>
            </a>`).join(""));
        }
        if (data.services?.length) {
          sections.push(`<div class="gs-section-title">Serviços (${data.services.length})</div>` +
            data.services.map((s) => `<a class="gs-item" href="/admin/servicos/${s.id}">
              <span class="gs-item-icon">${ICO_PKG}</span>
              <div class="gs-item-body">
                <div><strong>${esc(s.service_number)}</strong> <span class="gs-tag gs-tag-${esc(s.status)}">${STATUS_LABEL[s.status] || s.status}</span></div>
                <div class="gs-item-meta">${esc(s.province || "")}/${esc(s.district || "")} · <code>${esc(s.truck_plate || "—")}</code> · ${fmt(s.total_kg)} kg</div>
              </div>
            </a>`).join(""));
        }
        if (data.plates?.length) {
          sections.push(`<div class="gs-section-title">Matrículas (${data.plates.length})</div>` +
            data.plates.map((p) => `<a class="gs-item" href="/admin/camioes#plate=${encodeURIComponent(p.truck_plate || '')}" data-plate="${esc(p.truck_plate || '')}">
              <span class="gs-item-icon">${ICO_TRK}</span>
              <div class="gs-item-body">
                <div><strong><code>${esc(p.truck_plate)}</code></strong></div>
                <div class="gs-item-meta">${fmt(p.n_services)} serviços · último uso ${fmtDate(p.last_used)}</div>
              </div>
            </a>`).join(""));
        }
        if (!sections.length) {
          results.innerHTML = `<div class="gs-hint">Nenhum resultado para "${esc(q)}".</div>`;
        } else {
          results.innerHTML = sections.join("");
        }
      } catch (e) {
        results.innerHTML = `<div class="gs-hint" style="color:#dc2626">Erro: ${esc(e.message)}</div>`;
      }
    }

    input.addEventListener("input", (e) => {
      const q = e.target.value.trim();
      if (q === lastQuery) return;
      lastQuery = q;
      clearTimeout(timer);
      timer = setTimeout(() => doSearch(q), 200);
    });
    wrap.addEventListener("click", (e) => {
      if (e.target.classList.contains("gs-overlay")) close();
    });
    document.addEventListener("keydown", (e) => {
      const isTyping = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (wrap.classList.contains("show")) close();
        else open();
      } else if (e.key === "Escape" && wrap.classList.contains("show")) {
        close();
      } else if (e.key === "/" && !isTyping && !wrap.classList.contains("show")) {
        e.preventDefault();
        open();
      }
    });
  }

  // ── CSV/Excel export ────────────────────────────────────────
  // Exporta um array de objectos para CSV. Aceita opções:
  //   columns: [{key, label, format(value, row)?}]  // se omitido, usa keys do 1º obj
  //   filename: nome do download (auto sufixo de timestamp)
  function exportCSV(rows, opts = {}) {
    if (!rows || !rows.length) return alert("Nada para exportar.");
    const columns = opts.columns || Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
    const escape = (v) => {
      if (v == null) return "";
      const s = typeof v === "string" ? v : String(v);
      if (/[",\n;\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const header = columns.map((c) => escape(c.label)).join(";");
    const body = rows.map((r) => columns.map((c) => {
      const raw = c.format ? c.format(r[c.key], r) : r[c.key];
      return escape(raw);
    }).join(";")).join("\r\n");
    // BOM utf-8 + ; separator (compatível Excel PT-PT)
    const csv = "﻿" + header + "\r\n" + body;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0, 10);
    a.download = (opts.filename || "export") + "_" + ts + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  // ── URL state sync ──────────────────────────────────────────
  // Sincroniza um conjunto de inputs de filtro com URLSearchParams.
  // Permite que o utilizador faça bookmark/share de "/admin/servicos?status=in_transit&province=Gaza"
  // e que recarregar a página preserve os filtros.
  //
  //   syncFiltersToUrl({
  //     "f-status":   "status",
  //     "f-province": "province",
  //     ...
  //   }, onChange)  // chamado quando URL muda (back/forward)
  //
  // Devolve { read(), write() } — write actualiza URL com valores actuais.
  function urlState(elementToParam, opts = {}) {
    const ids = Object.keys(elementToParam);
    function read() {
      const params = new URLSearchParams(location.search);
      ids.forEach((id) => {
        const param = elementToParam[id];
        const v = params.get(param);
        const el = document.getElementById(id);
        if (el && v != null) el.value = v;
      });
    }
    function write() {
      const params = new URLSearchParams();
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.value && el.value.trim()) params.set(elementToParam[id], el.value.trim());
      });
      const qs = params.toString();
      const newUrl = location.pathname + (qs ? "?" + qs : "") + location.hash;
      if (newUrl !== location.pathname + location.search + location.hash) {
        history.replaceState(null, "", newUrl);
      }
    }
    if (opts.onPopState) {
      window.addEventListener("popstate", () => { read(); opts.onPopState(); });
    }
    return { read, write };
  }

  // ── Filter chips ────────────────────────────────────────────
  // Renderiza chips removíveis para os filtros activos numa página.
  //   renderFilterChips(containerEl, filters, onRemove)
  //   filters = [{ key, label, value }]   só renderiza os com value
  function renderFilterChips(container, filters, onRemove) {
    if (!container) return;
    const active = filters.filter((f) => f.value && String(f.value).trim());
    if (!active.length) { container.innerHTML = ""; return; }
    container.innerHTML = active.map((f) => `<span class="filter-chip">
      <span class="filter-chip-label">${esc(f.label)}:</span>
      <span class="filter-chip-value">${esc(f.value)}</span>
      <button class="filter-chip-x" data-key="${esc(f.key)}" title="Remover">×</button>
    </span>`).join("") +
      `<button class="filter-chip-clear" id="chip-clear-all">Limpar todos</button>`;
    container.querySelectorAll(".filter-chip-x").forEach((b) => {
      b.addEventListener("click", () => onRemove(b.dataset.key));
    });
    const clearAll = container.querySelector("#chip-clear-all");
    if (clearAll) clearAll.addEventListener("click", () => onRemove("__all__"));
  }

  // ── Toast notifications ─────────────────────────────────────
  // AdminUI.toast(message, opts?) — opts: { kind:"ok"|"warn"|"err"|"info", duration?, action? }
  // action: { label, onClick }   adiciona um botão clicável
  function ensureToastContainer() {
    let c = document.getElementById("toast-container");
    if (!c) {
      c = document.createElement("div");
      c.id = "toast-container";
      document.body.appendChild(c);
    }
    return c;
  }
  function toast(message, opts = {}) {
    const c = ensureToastContainer();
    const kind = opts.kind || "info";
    const el = document.createElement("div");
    el.className = "toast toast-" + kind;
    const actionHtml = opts.action
      ? `<button class="toast-action">${esc(opts.action.label)}</button>`
      : "";
    el.innerHTML = `<div class="toast-msg">${esc(message)}</div>${actionHtml}<button class="toast-close" title="Fechar">×</button>`;
    c.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const close = () => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".toast-close").addEventListener("click", close);
    if (opts.action) {
      el.querySelector(".toast-action").addEventListener("click", () => {
        try { opts.action.onClick(); } catch (_) {}
        close();
      });
    }
    const dur = opts.duration != null ? opts.duration : (kind === "err" ? 8000 : 4000);
    if (dur > 0) setTimeout(close, dur);
    return { close };
  }

  // ── Confirm modal estilizado (substitui confirm() nativo) ───
  // AdminUI.confirm(message, opts?) → Promise<boolean>
  // opts: { title?, confirmLabel?, cancelLabel?, dangerous?, details? }
  function confirmDialog(message, opts = {}) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "confirm-overlay";
      const isDanger = !!opts.dangerous;
      wrap.innerHTML = `
        <div class="confirm-box ${isDanger ? "danger" : ""}">
          <h3 class="confirm-title">${esc(opts.title || (isDanger ? "Confirmar acção" : "Confirmar"))}</h3>
          <div class="confirm-msg">${esc(message)}</div>
          ${opts.details ? `<div class="confirm-details">${opts.details}</div>` : ""}
          <div class="confirm-actions">
            <button class="btn confirm-cancel">${esc(opts.cancelLabel || "Cancelar")}</button>
            <button class="btn ${isDanger ? "btn-danger" : "btn-primary"} confirm-ok">${esc(opts.confirmLabel || "Confirmar")}</button>
          </div>
        </div>
      `;
      document.body.appendChild(wrap);
      requestAnimationFrame(() => wrap.classList.add("show"));
      const finish = (val) => {
        wrap.classList.remove("show");
        setTimeout(() => wrap.remove(), 150);
        document.removeEventListener("keydown", onKey);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === "Escape") finish(false);
        else if (e.key === "Enter") finish(true);
      };
      document.addEventListener("keydown", onKey);
      wrap.querySelector(".confirm-ok").addEventListener("click", () => finish(true));
      wrap.querySelector(".confirm-cancel").addEventListener("click", () => finish(false));
      wrap.addEventListener("click", (e) => { if (e.target === wrap) finish(false); });
      // Auto-focus no botão OK
      setTimeout(() => wrap.querySelector(".confirm-ok").focus(), 50);
    });
  }

  // ── Paginator ───────────────────────────────────────────────
  // AdminUI.renderPaginator(container, { page, pageSize, total, totalPages }, onChange)
  // onChange recebe { page, pageSize }
  function renderPaginator(container, state, onChange) {
    if (!container) return;
    const { page = 1, pageSize = 50, total = 0, totalPages = 1 } = state || {};
    if (total <= pageSize && page === 1) { container.innerHTML = ""; return; }
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(total, page * pageSize);
    const canPrev = page > 1;
    const canNext = page < totalPages;
    container.innerHTML = `
      <div class="paginator">
        <div class="paginator-info">${start}–${end} de ${total.toLocaleString("pt-PT")}</div>
        <div class="paginator-controls">
          <button class="btn btn-sm" data-page="1" ${!canPrev ? "disabled" : ""}>«</button>
          <button class="btn btn-sm" data-page="${page - 1}" ${!canPrev ? "disabled" : ""}>‹</button>
          <span class="paginator-current">Pág. ${page} / ${totalPages}</span>
          <button class="btn btn-sm" data-page="${page + 1}" ${!canNext ? "disabled" : ""}>›</button>
          <button class="btn btn-sm" data-page="${totalPages}" ${!canNext ? "disabled" : ""}>»</button>
          <select class="paginator-size">
            ${[20, 50, 100, 200].map((n) => `<option value="${n}" ${n === pageSize ? "selected" : ""}>${n} / pág</option>`).join("")}
          </select>
        </div>
      </div>
    `;
    container.querySelectorAll("button[data-page]").forEach((b) => {
      b.addEventListener("click", () => {
        if (b.disabled) return;
        const newPage = Math.max(1, Math.min(totalPages, Number(b.dataset.page)));
        onChange({ page: newPage, pageSize });
      });
    });
    container.querySelector(".paginator-size").addEventListener("change", (e) => {
      onChange({ page: 1, pageSize: Number(e.target.value) });
    });
  }

  // ── Keyboard shortcuts ─────────────────────────────────────
  // AdminUI.bindRowShortcuts({ tableSelector, rowSelector, onSelect })
  // J/K para navegar linhas, Enter para abrir o link da linha activa.
  // ? para mostrar overlay de ajuda.
  function bindRowShortcuts(opts) {
    const { tableSelector, rowSelector = "tr[data-link]", onSelect } = opts || {};
    let activeIdx = -1;
    function rows() { return Array.from(document.querySelectorAll(`${tableSelector} ${rowSelector}`)); }
    function highlight(idx) {
      const all = rows();
      all.forEach((r, i) => r.classList.toggle("kbd-active", i === idx));
      if (all[idx]) all[idx].scrollIntoView({ block: "nearest" });
    }
    document.addEventListener("keydown", (e) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      if (e.key === "?") { showShortcutsHelp(); e.preventDefault(); return; }
      const all = rows();
      if (!all.length) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        activeIdx = Math.min(all.length - 1, activeIdx + 1);
        highlight(activeIdx); e.preventDefault();
      } else if (e.key === "k" || e.key === "ArrowUp") {
        activeIdx = Math.max(0, activeIdx - 1);
        highlight(activeIdx); e.preventDefault();
      } else if (e.key === "Enter" && activeIdx >= 0 && all[activeIdx]) {
        const link = all[activeIdx].dataset.link;
        if (link) {
          if (onSelect) onSelect(all[activeIdx], link);
          else location.href = link;
          e.preventDefault();
        }
      }
    });
  }

  // Overlay de ajuda dos atalhos
  function showShortcutsHelp() {
    if (document.getElementById("kbd-help")) {
      document.getElementById("kbd-help").classList.add("show");
      return;
    }
    const wrap = document.createElement("div");
    wrap.id = "kbd-help";
    wrap.className = "kbd-help-overlay";
    wrap.innerHTML = `
      <div class="kbd-help-box">
        <h3>Atalhos de teclado</h3>
        <table class="kbd-help-table">
          <tr><td><kbd>⌘</kbd>+<kbd>K</kbd> ou <kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>Pesquisa global</td></tr>
          <tr><td><kbd>/</kbd></td><td>Pesquisa global (sem foco em input)</td></tr>
          <tr><td><kbd>J</kbd> ou <kbd>↓</kbd></td><td>Próxima linha</td></tr>
          <tr><td><kbd>K</kbd> ou <kbd>↑</kbd></td><td>Linha anterior</td></tr>
          <tr><td><kbd>Enter</kbd></td><td>Abrir linha activa</td></tr>
          <tr><td><kbd>?</kbd></td><td>Esta ajuda</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Fechar overlay</td></tr>
        </table>
        <p style="font-size:.78rem;color:#64748b;margin-top:.85rem">Em <code>/admin/distribuicao</code>: <kbd>1</kbd>–<kbd>6</kbd> escolhem capacidade do camião, <kbd>A</kbd> auto-preenche, <kbd>C</kbd> limpa selecção.</p>
        <div style="text-align:right;margin-top:1rem"><button class="btn" id="kbd-help-close">Fechar</button></div>
      </div>
    `;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("show"));
    const close = () => wrap.classList.remove("show");
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
    wrap.querySelector("#kbd-help-close").addEventListener("click", close);
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
    });
  }

  return {
    esc, fmt, fmtDate, statusBadge, fetchJSON, renderLayout, loadMe,
    loadProducts, loadWarehouses, productSelectOptions, clearCache,
    sortRows, sortArrow, bindSortable, mountGlobalSearch,
    exportCSV, urlState, renderFilterChips,
    toast, confirm: confirmDialog,
    renderPaginator, bindRowShortcuts, showShortcutsHelp,
  };
})();

// Auto-mount the global search on every admin page
document.addEventListener("DOMContentLoaded", () => {
  if (window.AdminUI && window.AdminUI.mountGlobalSearch) window.AdminUI.mountGlobalSearch();
});
