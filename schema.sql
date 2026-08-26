CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ton_address TEXT,
  referrer_id INTEGER,
  referral_balance REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER PRIMARY KEY,
  state TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message TEXT,
  admin_reply TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ton_amount REAL NOT NULL,
  ton_address TEXT NOT NULL,
  price_uah INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  save_address INTEGER NOT NULL DEFAULT 0,
  receipt_file_id TEXT,
  receipt_type TEXT,
  tx_info TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS generic_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  order_type TEXT NOT NULL,
  amount REAL NOT NULL,
  details TEXT,
  price_uah INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  receipt_file_id TEXT,
  receipt_type TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);
