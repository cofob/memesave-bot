-- Paid role, subscriptions, balance, describe quality tier.
-- SQLite cannot change a CHECK constraint, so users and grants are rebuilt with the 'paid' role.
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  username TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user', 'paid')),
  lang TEXT,
  search_mode TEXT NOT NULL DEFAULT 'advanced' CHECK (search_mode IN ('advanced', 'fast')),
  describe_tier TEXT NOT NULL DEFAULT 'max' CHECK (describe_tier IN ('max', 'medium')),
  total_cost REAL NOT NULL DEFAULT 0,
  openrouter_key TEXT,
  plan TEXT CHECK (plan IN ('monthly', 'yearly')),
  plan_byok INTEGER NOT NULL DEFAULT 0,    -- bought at the own-key price: no included AI spend
  paid_until INTEGER,                      -- access while paid_until > now
  plan_started INTEGER,                    -- start of the paid stretch: 30-day allowance months count from here
  balance REAL NOT NULL DEFAULT 0,         -- USD credit from top-ups
  sub_charge_id TEXT,                      -- Telegram Stars subscription (to cancel or resume it)
  sub_state TEXT,                          -- active | canceled | failed
  added_by INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO users_new (id, username, role, lang, search_mode, total_cost, openrouter_key, added_by, created_at)
  SELECT id, username, role, lang, search_mode, total_cost, openrouter_key, added_by, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX users_username ON users(username);

CREATE TABLE grants_new (
  username TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user', 'paid')),
  added_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO grants_new SELECT username, role, added_by, created_at FROM grants;
DROP TABLE grants;
ALTER TABLE grants_new RENAME TO grants;

-- How each AI cost of a paid user was covered.
ALTER TABLE transactions ADD COLUMN from_allowance REAL NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN from_balance REAL NOT NULL DEFAULT 0;

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('stars', 'btcpay', 'shkeeper')),
  kind TEXT NOT NULL CHECK (kind IN ('monthly', 'yearly', 'topup')),
  byok INTEGER NOT NULL DEFAULT 0,
  stars INTEGER,
  usd REAL NOT NULL,
  charge_id TEXT NOT NULL UNIQUE,          -- idempotency: Telegram charge id or "<provider>:<invoice id>"
  recurring INTEGER NOT NULL DEFAULT 0,
  refunded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX payments_user ON payments(user_id, created_at);

CREATE TABLE crypto_invoices (
  id TEXT PRIMARY KEY,                     -- our id: BTCPay orderId / SHKeeper external_id
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('btcpay', 'shkeeper')),
  kind TEXT NOT NULL CHECK (kind IN ('monthly', 'yearly', 'topup')),
  byok INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL,
  provider_ref TEXT,                       -- BTCPay invoice id
  crypto TEXT,                             -- SHKeeper crypto name, e.g. ETH-USDT
  address TEXT,
  crypto_amount TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid', 'expired', 'invalid')),
  credited_usd REAL NOT NULL DEFAULT 0,    -- USD applied so far (product + overpayment to balance)
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  paid_at INTEGER
);
CREATE INDEX crypto_invoices_user ON crypto_invoices(user_id, created_at);

-- Billing notices sent once per key (the key includes the period).
CREATE TABLE notices (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  sent_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, key)
);

-- Model of a batch import (describe tier at submit), for spend records.
ALTER TABLE imports ADD COLUMN model TEXT;
