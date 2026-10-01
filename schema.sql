-- abot-data v1. Safe to re-run. Does not touch the mail archive.
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  org TEXT,
  title TEXT,
  email TEXT,
  phone TEXT,
  relation TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_updated ON contacts(updated_at);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_email);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  all_day INTEGER NOT NULL DEFAULT 0,
  repeat TEXT NOT NULL DEFAULT '{"freq":"none"}',
  source TEXT NOT NULL DEFAULT 'bot',
  attendee_ids TEXT NOT NULL DEFAULT '[]',
  reminder_minutes TEXT NOT NULL DEFAULT '[]',
  location TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  google_event_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_start ON calendar_events(start_utc);
CREATE INDEX IF NOT EXISTS idx_events_status ON calendar_events(status);
CREATE INDEX IF NOT EXISTS idx_calendar_events_owner ON calendar_events(owner_email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_google ON calendar_events(google_event_id)
  WHERE google_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_email TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes(owner_email);

-- Phase 2 bus. Append-only. Does not ALTER Phase 1 tables.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  not_before TEXT NOT NULL,
  acked_at TEXT,
  leased_until TEXT,
  lease_token TEXT,
  poll_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'bot' CHECK(audience IN ('bot','user'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_open
  ON events(dedupe_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_events_poll
  ON events(status, not_before, created_at, id);
CREATE INDEX IF NOT EXISTS idx_events_type_created
  ON events(type, created_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  url TEXT,
  event_types TEXT NOT NULL DEFAULT '["watchdog.*","calendar.*"]',
  secret_sealed TEXT,
  webhook_auth TEXT NOT NULL DEFAULT 'hmac',
  watch_heartbeat INTEGER NOT NULL DEFAULT 1,
  agent_id TEXT NOT NULL DEFAULT 'bot:main',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_status_mode
  ON subscriptions(status, mode);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  queued_at TEXT,
  inflight_at TEXT,
  last_error TEXT,
  dead_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due
  ON deliveries(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS heartbeats (
  agent_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- Agent accounts. One email, one account. Codes and tokens are stored as
-- SHA-256 hex. owner_email above is nullable so existing rows stay NULL.
CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_token_hash ON accounts(token_hash);

CREATE TABLE IF NOT EXISTS verification_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL
);

-- Sliding window for verification requests: 3 per email and 10 per IP in 60 minutes.
CREATE TABLE IF NOT EXISTS verification_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  requested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_requests_email
  ON verification_requests(email, requested_at);
CREATE INDEX IF NOT EXISTS idx_verification_requests_ip
  ON verification_requests(ip, requested_at);

-- OAuth 2.0 authorization-code clients. client_secret_hash is SHA-256 hex.
-- redirect_uris is a JSON array of exact callback URLs.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One-time authorization codes. code_hash is SHA-256 hex of the 32-byte code.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
