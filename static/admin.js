/* ── AQI Admin UI helpers ─────────────────────────────────── */
window.AdminUI = (function () {
  const NAV = [
    { key: "dashboard",       label: "Dashboard",    icon: "▣",  href: "/admin" },
    { section: "Compras" },
    { key: "purchase-orders", label: "Purchase Orders", icon: "📄", href: "/admin/purchase-orders" },
    { key: "authorizations",  label: "Autorizações", icon: "📝", href: "/admin/authorizations" },
    { key: "entries",         label: "Entradas",     icon: "📥", href: "/admin/entries" },
    { section: "Saídas" },
    { key: "adsn",            label: "ADSNs",        icon: "🎫", href: "/admin/adsn" },
    { key: "exits",           label: "Saídas",       icon: "📤", href: "/admin/exits" },
    { section: "Stock" },
    { key: "stock",           label: "Stock",        icon: "📦", href: "/admin/stock" },
    { key: "products",        label: "Produtos",     icon: "🏷",  href: "/admin/products" },
    { key: "suppliers",       label: "Fornecedores", icon: "🏭", href: "/admin/suppliers" },
    { section: "Legado" },
    { key: "trucks",          label: "Camiões",      icon: "🚛", href: "/admin/trucks" },
    { key: "departures",      label: "Saídas (legado)", icon: "📤", href: "/admin/departures" },
    { key: "warehouses",      label: "Armazéns",     icon: "🏬", href: "/admin/warehouses" },
    { key: "plans",           label: "Planos",       icon: "🗺",  href: "/admin/plans" },
    { key: "requisitions",    label: "Requisições",  icon: "📋", href: "/admin/requisitions" },
    { section: "Admin" },
    { key: "audit",           label: "Auditoria",    icon: "🔍", href: "/admin/audit", roles: ["superadmin", "admin"] },
    { key: "users",           label: "Utilizadores", icon: "👥", href: "/admin/users", roles: ["superadmin"] },
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

  return {
    esc, fmt, fmtDate, statusBadge, fetchJSON, renderLayout, loadMe,
    loadProducts, loadWarehouses, productSelectOptions, clearCache,
  };
})();
