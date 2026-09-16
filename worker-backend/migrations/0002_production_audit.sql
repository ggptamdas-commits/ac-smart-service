PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS webhook_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  phone TEXT,
  payload_summary TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','processed','failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL,
  email TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0 CHECK(success IN (0,1)),
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE service_requests ADD COLUMN source_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_requests_source_message
  ON service_requests(source_message_id) WHERE source_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_open_per_customer
  ON conversations(customer_id) WHERE status IN ('active','human');

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_logs_idempotency
  ON reminder_logs(customer_id, reminder_setting_id, scheduled_date);

CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup
  ON login_attempts(ip_address, email, attempted_at);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created
  ON webhook_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_service_customer_status
  ON service_requests(customer_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_customer_timestamp
  ON messages(customer_id, timestamp);

DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 day');
DELETE FROM sessions WHERE expires_at <= datetime('now');
