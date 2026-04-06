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
