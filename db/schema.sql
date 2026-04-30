CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role ENUM('superadmin','admin','operator','viewer') NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  created_by INT NULL,
  last_login DATETIME NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  token VARCHAR(64) PRIMARY KEY,
  user_id INT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  ip VARCHAR(64),
  user_agent VARCHAR(512),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS suppliers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255),
  contact_phone VARCHAR(64),
  contact_email VARCHAR(255),
  notes TEXT,
  created_at DATETIME NOT NULL,
  created_by INT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS requisitions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ref_number VARCHAR(64),
  supplier_id INT NOT NULL,
  product VARCHAR(255) NOT NULL,
  qty_requested DECIMAL(14,2) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  status ENUM('pending','partial','received','cancelled') NOT NULL,
  requested_at DATETIME NOT NULL,
  expected_at DATETIME,
  notes TEXT,
  created_by INT,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trucks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plate VARCHAR(32) NOT NULL,
  driver_name VARCHAR(255),
  driver_phone VARCHAR(64),
  supplier_id INT,
  requisition_id INT,
  status ENUM('expected','arrived','unloading','unloaded','transferred','cancelled') NOT NULL,
  arrived_at DATETIME,
  unloaded_at DATETIME,
  notes TEXT,
  created_at DATETIME NOT NULL,
  created_by INT,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
  FOREIGN KEY (requisition_id) REFERENCES requisitions(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS truck_cargo (
  id INT AUTO_INCREMENT PRIMARY KEY,
  truck_id INT NOT NULL,
  product VARCHAR(255) NOT NULL,
  qty_initial DECIMAL(14,2) NOT NULL,
  qty_current DECIMAL(14,2) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  notes TEXT,
  FOREIGN KEY (truck_id) REFERENCES trucks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS truck_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  truck_id INT NOT NULL,
  file_path VARCHAR(512) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128),
  size_bytes INT,
  uploaded_at DATETIME NOT NULL,
  uploaded_by INT,
  FOREIGN KEY (truck_id) REFERENCES trucks(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cargo_transfers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  from_truck_id INT NOT NULL,
  to_truck_id INT NOT NULL,
  product VARCHAR(255) NOT NULL,
  qty DECIMAL(14,2) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  transferred_at DATETIME NOT NULL,
  transferred_by INT,
  notes TEXT,
  FOREIGN KEY (from_truck_id) REFERENCES trucks(id),
  FOREIGN KEY (to_truck_id) REFERENCES trucks(id),
  FOREIGN KEY (transferred_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('truck_in','truck_unload','transfer_out','transfer_in','adjustment') NOT NULL,
  product VARCHAR(255) NOT NULL,
  qty DECIMAL(14,2) NOT NULL,
  truck_id INT,
  transfer_id INT,
  created_at DATETIME NOT NULL,
  created_by INT,
  notes TEXT,
  FOREIGN KEY (truck_id) REFERENCES trucks(id) ON DELETE SET NULL,
  FOREIGN KEY (transfer_id) REFERENCES cargo_transfers(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_product (product)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64),
  entity_id INT,
  details TEXT,
  ip VARCHAR(64),
  created_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) UNIQUE,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(64),
  default_unit VARCHAR(32) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT,
  created_at DATETIME NOT NULL,
  created_by INT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS warehouses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) UNIQUE,
  name VARCHAR(255) NOT NULL,
  province VARCHAR(64),
  district VARCHAR(64),
  address VARCHAR(512),
  manager_name VARCHAR(255),
  manager_phone VARCHAR(64),
  active TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT,
  created_at DATETIME NOT NULL,
  created_by INT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS delivery_plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ref_number VARCHAR(64),
  name VARCHAR(255) NOT NULL,
  target_province VARCHAR(64),
  target_district VARCHAR(64),
  target_date DATE,
  status ENUM('draft','reserved','executing','completed','cancelled') NOT NULL DEFAULT 'draft',
  notes TEXT,
  created_at DATETIME NOT NULL,
  created_by INT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS plan_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plan_id INT NOT NULL,
  product_id INT NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  qty DECIMAL(14,2) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  source_warehouse_id INT NULL,
  beneficiary VARCHAR(255),
  status ENUM('draft','reserved','consumed','cancelled') NOT NULL DEFAULT 'draft',
  notes TEXT,
  FOREIGN KEY (plan_id) REFERENCES delivery_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS truck_departures (
  id INT AUTO_INCREMENT PRIMARY KEY,
  truck_id INT NOT NULL,
  source_type ENUM('truck','warehouse') NOT NULL,
  source_warehouse_id INT NULL,
  destination_province VARCHAR(64),
  destination_district VARCHAR(64),
  destination_name VARCHAR(255),
  destination_contact VARCHAR(64),
  plan_id INT NULL,
  status ENUM('planned','in_transit','delivered','cancelled') NOT NULL DEFAULT 'in_transit',
  departed_at DATETIME NOT NULL,
  delivered_at DATETIME,
  notes TEXT,
  created_at DATETIME NOT NULL,
  created_by INT,
  FOREIGN KEY (truck_id) REFERENCES trucks(id),
  FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL,
  FOREIGN KEY (plan_id) REFERENCES delivery_plans(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS departure_cargo (
  id INT AUTO_INCREMENT PRIMARY KEY,
  departure_id INT NOT NULL,
  product_id INT NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  qty DECIMAL(14,2) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  notes TEXT,
  FOREIGN KEY (departure_id) REFERENCES truck_departures(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Purchase Orders (PO → Autorização → Entrada → ADSN → Saída flow) ──
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  po_number VARCHAR(64) NOT NULL UNIQUE,
  supplier_id INT NOT NULL,
  supplier_nuit VARCHAR(32),
  po_date DATE,
  projecto VARCHAR(128),
  notes TEXT,
  status ENUM('draft','issued','in_pickup','received','partial','closed','cancelled') NOT NULL DEFAULT 'issued',
  imported_from VARCHAR(255),
  created_at DATETIME NOT NULL,
  created_by INT,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_po_supplier (supplier_id),
  INDEX idx_po_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS po_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  po_id INT NOT NULL,
  product_id INT,
  product_code VARCHAR(64),
  product_name VARCHAR(255) NOT NULL,
  qty DECIMAL(14,2) NOT NULL,
  unit VARCHAR(32) NOT NULL DEFAULT 'kg',
  qty_authorized DECIMAL(14,2) NOT NULL DEFAULT 0,
  qty_received DECIMAL(14,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pickup_authorizations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  auth_number VARCHAR(64) NOT NULL UNIQUE,
  po_id INT NOT NULL,
  transporter_name VARCHAR(255),
  truck_plate VARCHAR(32) NOT NULL,
  driver_name VARCHAR(255) NOT NULL,
  driver_phone VARCHAR(64),
  driver_id_doc VARCHAR(64),
  pickup_date DATE,
  status ENUM('issued','in_transit','received','partial','cancelled') NOT NULL DEFAULT 'issued',
  notes TEXT,
  issued_at DATETIME NOT NULL,
  issued_by INT,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_auth_plate (truck_plate),
  INDEX idx_auth_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pickup_auth_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  auth_id INT NOT NULL,
  po_item_id INT NOT NULL,
  product_id INT,
  product_name VARCHAR(255) NOT NULL,
  qty_to_pickup DECIMAL(14,2) NOT NULL,
  unit VARCHAR(32) NOT NULL DEFAULT 'kg',
  FOREIGN KEY (auth_id) REFERENCES pickup_authorizations(id) ON DELETE CASCADE,
  FOREIGN KEY (po_item_id) REFERENCES po_items(id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_number VARCHAR(64) NOT NULL UNIQUE,
  auth_id INT NOT NULL,
  received_at DATETIME NOT NULL,
  received_by INT,
  notes TEXT,
  FOREIGN KEY (auth_id) REFERENCES pickup_authorizations(id),
  FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_entry_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_id INT NOT NULL,
  auth_item_id INT NOT NULL,
  product_id INT,
  product_name VARCHAR(255) NOT NULL,
  qty_received DECIMAL(14,2) NOT NULL,
  unit VARCHAR(32) NOT NULL DEFAULT 'kg',
  FOREIGN KEY (entry_id) REFERENCES stock_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (auth_item_id) REFERENCES pickup_auth_items(id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_entry_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_id INT NOT NULL,
  kind ENUM('supplier_guide','signed_authorization','other') NOT NULL,
  file_path VARCHAR(512) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128),
  size_bytes INT,
  uploaded_at DATETIME NOT NULL,
  uploaded_by INT,
  FOREIGN KEY (entry_id) REFERENCES stock_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS adsn_services (
  id INT AUTO_INCREMENT PRIMARY KEY,
  adsn_code VARCHAR(64) NOT NULL UNIQUE,
  gtu VARCHAR(64),
  tipo VARCHAR(64),
  projecto VARCHAR(128),
  origem VARCHAR(128),
  destinatario VARCHAR(255),
  destinatario_contact VARCHAR(128),
  provincia VARCHAR(64),
  distrito VARCHAR(64),
  sku VARCHAR(64),
  product_name VARCHAR(255),
  peso_kg DECIMAL(14,2) NOT NULL,
  volumes INT,
  status ENUM('pending','dispatched','cancelled') NOT NULL DEFAULT 'pending',
  imported_at DATETIME NOT NULL,
  imported_by INT,
  imported_from VARCHAR(255),
  FOREIGN KEY (imported_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_adsn_status (status),
  INDEX idx_adsn_gtu (gtu)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_exits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  exit_number VARCHAR(64) NOT NULL UNIQUE,
  adsn_id INT NOT NULL UNIQUE,
  truck_plate VARCHAR(32),
  driver_name VARCHAR(255),
  driver_phone VARCHAR(64),
  transporter_name VARCHAR(255),
  dispatched_at DATETIME NOT NULL,
  dispatched_by INT,
  notes TEXT,
  FOREIGN KEY (adsn_id) REFERENCES adsn_services(id),
  FOREIGN KEY (dispatched_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_exit_plate (truck_plate)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Distribuição (entrega ao beneficiário final) ──────────────────────
-- Fluxo: Plano (Excel) → Saldo por benef×produto → Serviço (= camião) → Itens
-- Constraint atómica (saldo nunca < 0) feita via UPDATE...WHERE em transação.

CREATE TABLE IF NOT EXISTS beneficiaries (
  extensionist_id  VARCHAR(16) NOT NULL PRIMARY KEY,    -- '0601-0001'
  nuit             VARCHAR(16) NULL,                     -- '2601050' (Cod Destino)
  name             VARCHAR(255) NOT NULL,
  province         VARCHAR(64),
  district         VARCHAR(64),
  posto            VARCHAR(64),
  contact          VARCHAR(64),
  supervisor_name  VARCHAR(255),
  supervisor_phone VARCHAR(64),
  imported_at      DATETIME NOT NULL,
  UNIQUE KEY u_benef_nuit (nuit),
  INDEX idx_benef_district (province, district),
  INDEX idx_benef_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS delivery_balances (
  extensionist_id  VARCHAR(16) NOT NULL,
  sku              VARCHAR(32) NOT NULL,
  product_name     VARCHAR(128) NOT NULL,
  unit             VARCHAR(8)  NOT NULL DEFAULT 'kg',
  province         VARCHAR(64),
  district         VARCHAR(64),
  beneficiary_name VARCHAR(255) NOT NULL,
  -- planned_qty já tem Realocado Recebido subtraído (Qtd Pós Realocação).
  -- Guardamos planned_original e realocado_recebido para o operador ver "porquê".
  planned_original DECIMAL(14,2) NOT NULL DEFAULT 0,   -- NQAE original
  realocado_recebido DECIMAL(14,2) NOT NULL DEFAULT 0, -- realocado vindo de outro benef
  planned_qty      DECIMAL(14,2) NOT NULL,             -- = planned_original - realocado_recebido
  -- committed = planned bloqueado em qualquer serviço não-cancelado
  -- (draft + in_transit + delivered). Saldo despachável = planned − committed.
  committed_qty    DECIMAL(14,2) NOT NULL DEFAULT 0,
  delivered_qty    DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (extensionist_id, sku),
  FOREIGN KEY (extensionist_id) REFERENCES beneficiaries(extensionist_id) ON DELETE CASCADE,
  INDEX idx_bal_district (province, district),
  INDEX idx_bal_sku (sku)
  -- Guarantee committed_qty <= planned_qty AND delivered_qty <= committed_qty
  -- enforced at application level via atomic UPDATE...WHERE in transactions
  -- (CHECK constraints behave inconsistently across MySQL/MariaDB versions).
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS delivery_services (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  service_number    VARCHAR(32) NOT NULL UNIQUE,        -- 'SRV-2026-0001' (interno) ou 'SRV-IMP-{adsn}' (importado)
  province          VARCHAR(64) NOT NULL,
  district          VARCHAR(64) NOT NULL,
  truck_capacity_kg INT NOT NULL DEFAULT 0,             -- 30000/15000/10000/5000/2000/1000 (0 se importado sem info)
  truck_plate       VARCHAR(32),
  truck_plate_2     VARCHAR(32),
  driver_name       VARCHAR(255),
  driver_phone      VARCHAR(64),
  origem_supplier   VARCHAR(128),
  status            ENUM('draft','in_transit','delivered','cancelled') NOT NULL DEFAULT 'draft',
  total_kg          DECIMAL(14,2) NOT NULL DEFAULT 0,
  source            ENUM('manual','imported') NOT NULL DEFAULT 'manual',
  created_at        DATETIME NOT NULL,
  created_by        INT NULL,
  dispatched_at     DATETIME NULL,
  delivered_at      DATETIME NULL,
  cancelled_at      DATETIME NULL,
  imported_from     VARCHAR(255) NULL,
  notes             TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_svc_status (status),
  INDEX idx_svc_district (province, district),
  INDEX idx_svc_plate (truck_plate),
  INDEX idx_svc_created (created_at),
  INDEX idx_svc_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS delivery_service_items (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  service_id       INT NOT NULL,
  extensionist_id  VARCHAR(16) NOT NULL,
  sku              VARCHAR(32) NOT NULL,
  qty              DECIMAL(14,2) NOT NULL,
  unit             VARCHAR(8) NOT NULL DEFAULT 'kg',
  beneficiary_name VARCHAR(255) NOT NULL,
  product_name     VARCHAR(128) NOT NULL,
  province         VARCHAR(64),
  district         VARCHAR(64),
  external_adsn    VARCHAR(64) NULL,                  -- ADSN do sistema externo (1 por item)
  external_gtu     VARCHAR(64) NULL,
  FOREIGN KEY (service_id) REFERENCES delivery_services(id) ON DELETE CASCADE,
  FOREIGN KEY (extensionist_id, sku) REFERENCES delivery_balances(extensionist_id, sku),
  -- (service_id, extensionist_id, sku) NÃO é UNIQUE: o sistema externo pode
  -- emitir múltiplos ADSNs para o mesmo beneficiário/produto no mesmo camião.
  -- A UI manual previne duplicados; aqui apenas asseguramos idempotência por ADSN.
  UNIQUE KEY u_dsi_external_adsn (external_adsn),
  INDEX idx_dsi_svc_benef (service_id, extensionist_id, sku),
  INDEX idx_dsi_benef (extensionist_id, sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
