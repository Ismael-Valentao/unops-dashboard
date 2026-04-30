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
  };

  const NAV = [
    { key: "dashboard",       label: "Dashboard",         icon: ICO.dashboard,  href: "/admin" },
    { section: "Distribuição" },
    { key: "distribuicao",    label: "Saldo & Despachar", icon: ICO.target,     href: "/admin/distribuicao" },
    { key: "beneficiarios",   label: "Beneficiários",     icon: ICO.users,      href: "/admin/beneficiarios" },
    { key: "servicos",        label: "Serviços",          icon: ICO.list,       href: "/admin/servicos" },
    { key: "camioes",         label: "Camiões",           icon: ICO.truck,      href: "/admin/camioes" },
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
      return `<a href="${n.href}" class="sb-link ${n.key === activeKey ? "active" : ""}">
        <span class="sb-icon">${n.icon}</span>${n.label}
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

  return {
    esc, fmt, fmtDate, statusBadge, fetchJSON, renderLayout, loadMe,
    loadProducts, loadWarehouses, productSelectOptions, clearCache,
    sortRows, sortArrow, bindSortable,
  };
})();
