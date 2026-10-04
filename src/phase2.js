/**
 * Phase 2 bus: events, subscriptions, deliveries, heartbeats.
 * Appended beside Phase 1. Does not change contact / calendar / note behavior.
 */

const DAY_MS = 86_400_000;
const SCAN_LIMIT = 500;
const DETECT_LIMIT = 50;
const PAYLOAD_MAX_BYTES = 4096;
const DEFAULT_EVENT_TYPES = '["watchdog.*","calendar.*"]';
const TYPE_SEGMENT = "[a-z][a-z0-9_]{0,30}";
const EVENT_TYPE_RE = new RegExp(`^${TYPE_SEGMENT}(?:\\.${TYPE_SEGMENT})+$`);
const EVENT_PREFIX_RE = new RegExp(`^${TYPE_SEGMENT}(?:\\.${TYPE_SEGMENT})*\\.\\*$`);
const DEDUPE_RE = /^[A-Za-z0-9:._-]{1,200}$/;
const AGENT_ID_RE = /^bot:[a-z0-9][a-z0-9_-]{0,31}$/;
const LEASE_RE = /^[0-9a-f]{32}$/;
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RETRY_DELAYS = [60, 120, 240];
const DELIVER_QUEUE_NAME = "abot-deliver";
const DLQ_QUEUE_NAME = "abot-deliver-dlq";
/** Pending events whose not_before is older than this become 'expired'. */
export const EVENT_TTL_MS = 7 * DAY_MS;
/** Finished events (acked or expired) and their claims and deliveries are deleted after this. */
export const EVENT_KEEP_MS = 30 * DAY_MS;
const RETENTION_LIMIT = 500;
export const MAX_SUBSCRIPTIONS_PER_ACCOUNT = 20;
export const MAX_LEGACY_SUBSCRIPTIONS = 100;
const QUEUE_BATCH_MAX = 100;
const INFLIGHT_STALE_MS = 180 * 1000;
/**
 * Bus owner for the legacy DATA_MCP_TOKEN. Not an email address, so no account
 * can match it. Events owned by it reach only legacy (NULL-owner) subscriptions,
 * and the legacy caller leases system events through event_claims like an account.
 */
export const LEGACY_OWNER = "legacy";
const SECRET_KEYS = new Set([
  "secret",
  "token",
  "password",
  "authorization",
  "signing_secret",
  "webhook_secret",
  "data_mcp_token",
  "mcp_token",
  "subscription_seal",
]);

function changesOf(result) {
  if (!result || typeof result !== "object") return 0;
  if (result.meta && Number.isInteger(result.meta.changes)) return result.meta.changes;
  if (Number.isInteger(result.changes)) return result.changes;
  return 0;
}

function nowMsOf(deps) {
  if (deps && typeof deps.nowMs === "number" && Number.isFinite(deps.nowMs)) return deps.nowMs;
  return Date.now();
}

let tokenEqual = (left, right) => left === right;

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(text) {
  const clean = String(text).replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new Error("bad base64");
  }
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(text) {
  if (typeof text !== "string" || text.length === 0 || /[^A-Za-z0-9_-]/.test(text)) {
    throw new Error("bad base64url");
  }
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  return base64ToBytes(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

export function stableStringify(value) {
  return encodeStable(value, false);
}

function encodeStable(value, checkSecrets) {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "string") {
    if (checkSecrets && value.includes("whsec_")) {
      const err = new Error("payload contains a secret");
      err.code = -32602;
      err.name = "RpcError";
      throw err;
    }
    return JSON.stringify(value);
  }
  if (kind === "boolean") return JSON.stringify(value);
  if (kind === "number") {
    if (!Number.isFinite(value)) throw payloadInvalid();
    return JSON.stringify(value);
  }
  if (kind !== "object") throw payloadInvalid();
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeStable(item, checkSecrets)).join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw payloadInvalid();
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    if (checkSecrets && SECRET_KEYS.has(key.toLowerCase())) throw payloadSecret();
    if (value[key] === undefined) throw payloadInvalid();
    parts.push(`${JSON.stringify(key)}:${encodeStable(value[key], checkSecrets)}`);
  }
  return `{${parts.join(",")}}`;
}

function payloadInvalid() {
  const err = new Error("payload is invalid");
  err.code = -32602;
  err.name = "RpcError";
  return err;
}

function payloadSecret() {
  const err = new Error("payload contains a secret");
  err.code = -32602;
  err.name = "RpcError";
  return err;
}

function asRpc(err, RpcError) {
  if (err instanceof RpcError) return err;
  if (err && err.name === "RpcError" && Number.isInteger(err.code)) return new RpcError(err.code, err.message);
  return err;
}

export function serializePayload(value) {
  const payload = value == null ? {} : value;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("payload must be an object");
    err.code = -32602;
    err.name = "RpcError";
    throw err;
  }
  const text = encodeStable(payload, true);
  if (new TextEncoder().encode(text).byteLength > PAYLOAD_MAX_BYTES) {
    const err = new Error("payload is too large");
    err.code = -32602;
    err.name = "RpcError";
    throw err;
  }
  return text;
}

export function decodeSealKey(env) {
  const raw = env && env.SUBSCRIPTION_SEAL;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const bytes = base64ToBytes(raw);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function newWebhookSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${bytesToBase64(bytes)}`;
}

function newLeaseToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function importAes(keyBytes, usages) {
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, usages);
}

async function sealSecret(secret, subscriptionId, keyBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAes(keyBytes, ["encrypt"]);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(subscriptionId) },
      key,
      new TextEncoder().encode(secret),
    ),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return bytesToBase64(out);
}

async function openSecret(sealed, subscriptionId, keyBytes) {
  const raw = base64ToBytes(sealed);
  if (raw.length < 28) throw new Error("seal");
  const iv = raw.slice(0, 12);
  const cipher = raw.slice(12);
  const key = await importAes(keyBytes, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(subscriptionId) },
    key,
    cipher,
  );
  return new TextDecoder().decode(plain);
}

export async function signWebhook(secret, timestamp, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildWebhookBody(event) {
  const payload = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
  return stableStringify({
    id: event.id,
    type: event.type,
    dedupe_key: event.dedupe_key,
    created_at: event.created_at,
    not_before: event.not_before,
    payload,
  });
}

export async function verifyWebhookRequest({ secret, timestamp, body, signature, nowMs }) {
  const ts = typeof timestamp === "number" && Number.isFinite(timestamp) ? String(timestamp) : timestamp;
  if (typeof ts !== "string" || !/^\d+$/.test(ts)) return false;
  const nowSec = Math.floor((typeof nowMs === "number" ? nowMs : Date.now()) / 1000);
  if (Math.abs(nowSec - Number(ts)) > 300) return false;
  if (typeof signature !== "string" || typeof body !== "string" || typeof secret !== "string") return false;
  const expected = `v1=${await signWebhook(secret, ts, body)}`;
  return tokenEqual(expected, signature);
}

function encodeCursor(createdAt, id) {
  return `v1.${bytesToBase64Url(new TextEncoder().encode(`${createdAt}\n${id}`))}`;
}

function isIpAddress(host) {
  if (host.startsWith("[") || host.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".localdomain", ".home.arpa", ".test", ".invalid"];

/** Comma-separated WEBHOOK_DENY_DOMAINS; each entry blocks the domain and its subdomains. */
function webhookDenyDomains(env) {
  const raw = env && typeof env.WEBHOOK_DENY_DOMAINS === "string" ? env.WEBHOOK_DENY_DOMAINS : "";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

export function webhookHostBlocked(hostname, env) {
  const host = String(hostname).toLowerCase().replace(/\.+$/, "");
  if (host === "" || isIpAddress(host)) return true;
  if (host === "localhost" || !host.includes(".")) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return webhookDenyDomains(env).some((d) => host === d || host.endsWith(`.${d}`));
}

function eventTypeMatches(type, filters) {
  for (const item of filters) {
    if (item === "*") return true;
    if (typeof item === "string" && item.endsWith(".*")) {
      if (type.startsWith(item.slice(0, -1))) return true;
    } else if (item === type) return true;
  }
  return false;
}

function parseFilters(eventTypes) {
  if (typeof eventTypes !== "string" || eventTypes === "") return ["watchdog.*", "calendar.*"];
  try {
    const parsed = JSON.parse(eventTypes);
    return Array.isArray(parsed) ? parsed : ["watchdog.*", "calendar.*"];
  } catch {
    return ["watchdog.*", "calendar.*"];
  }
}

function httpErrorToken(status) {
  const code = Number(status);
  if (!Number.isInteger(code) || code < 100 || code > 999) return "http_000";
  return `http_${code}`;
}

function fetchFailureToken(err) {
  const name = err && err.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "network";
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function createPhase2(api) {
  const {
    RpcError,
    newId,
    queryAll,
    queryFirst,
    queryRun,
    nowIso,
    canonicalUtc,
    requireArgs,
    assertOnlyKeys,
    has,
    requireId,
    notFound,
    clampLimit,
    timingSafeEqual,
    isUniqueError,
    d1Deps,
  } = api;

  tokenEqual = timingSafeEqual;

  function raise(err) {
    throw asRpc(err, RpcError);
  }

  function serialize(value) {
    try {
      return serializePayload(value);
    } catch (err) {
      raise(err);
    }
  }

  function assertBearerToken(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 500) {
      throw new RpcError(-32602, "bearer_token is invalid");
    }
    if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(value)) {
      throw new RpcError(-32602, "bearer_token is invalid");
    }
    return value;
  }

  function assertWebhookUrl(value, env) {
    if (typeof value !== "string" || value.length < 1 || value.length > 500) {
      throw new RpcError(-32602, "webhook url is invalid");
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new RpcError(-32602, "webhook url is invalid");
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new RpcError(-32602, "webhook url is invalid");
    }
    if (url.port !== "" && url.port !== "443") throw new RpcError(-32602, "webhook url is invalid");
    if (webhookHostBlocked(host, env)) throw new RpcError(-32602, "webhook url is invalid");
    return value;
  }

  function normalizeEventTypes(value, { allowDefault }) {
    if (value == null) {
      if (allowDefault) return DEFAULT_EVENT_TYPES;
      throw new RpcError(-32602, "event_types is invalid");
    }
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
      throw new RpcError(-32602, "event_types is invalid");
    }
    for (const item of value) {
      if (item === "*") continue;
      if (typeof item !== "string" || item.length > 66) throw new RpcError(-32602, "event_types is invalid");
      if (item.endsWith(".*")) {
        if (!EVENT_PREFIX_RE.test(item)) throw new RpcError(-32602, "event_types is invalid");
        continue;
      }
      if (item.length > 64 || !EVENT_TYPE_RE.test(item)) throw new RpcError(-32602, "event_types is invalid");
    }
    return JSON.stringify(value);
  }

  function readAgent(value, fallback) {
    if (value == null) {
      if (fallback == null) throw new RpcError(-32602, "agent_id is invalid");
      return fallback;
    }
    if (typeof value !== "string" || !AGENT_ID_RE.test(value)) throw new RpcError(-32602, "agent_id is invalid");
    return value;
  }

  function readWatch(value, fallback) {
    if (value == null) {
      if (fallback == null) throw new RpcError(-32602, "watch_heartbeat must be a boolean");
      return fallback;
    }
    if (typeof value !== "boolean") throw new RpcError(-32602, "watch_heartbeat must be a boolean");
    return value ? 1 : 0;
  }

  function readVisibility(value) {
    if (value == null) return 120;
    if (!Number.isInteger(value)) throw new RpcError(-32602, "visibility_seconds must be an integer");
    if (value < 30 || value > 900) throw new RpcError(-32602, "visibility_seconds is out of range");
    return value;
  }

  function readTtl(value) {
    if (value == null) return 600;
    if (!Number.isInteger(value)) throw new RpcError(-32602, "ttl_seconds must be an integer");
    if (value < 120 || value > 86400) throw new RpcError(-32602, "ttl_seconds is out of range");
    return value;
  }

  function requireAudience(value) {
    if (value !== "bot" && value !== "user") throw new RpcError(-32602, "audience is invalid");
    return value;
  }

  function readEmitAudience(args) {
    if (!has(args, "audience")) return "bot";
    return requireAudience(args.audience);
  }

  function readPollAudience(args) {
    if (!has(args, "audience")) return null;
    return requireAudience(args.audience);
  }

  async function ensureWebhookAuthColumn(deps) {
    const rows = await queryAll(
      deps,
      "SELECT name FROM pragma_table_info('subscriptions') WHERE name = 'webhook_auth'",
      [],
    );
    if (rows.length > 0) return;
    try {
      await queryRun(
        deps,
        "ALTER TABLE subscriptions ADD COLUMN webhook_auth TEXT NOT NULL DEFAULT 'hmac'",
        [],
      );
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      if (/duplicate column/i.test(message)) return;
      throw err;
    }
  }

  async function ensureAudienceColumn(deps) {
    const rows = await queryAll(
      deps,
      "SELECT name FROM pragma_table_info('events') WHERE name = 'audience'",
      [],
    );
    if (rows.length > 0) return;
    try {
      await queryRun(
        deps,
        "ALTER TABLE events ADD COLUMN audience TEXT NOT NULL DEFAULT 'bot' CHECK(audience IN ('bot','user'))",
        [],
      );
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      if (/duplicate column/i.test(message)) return;
      throw err;
    }
  }

  const DEDUPE_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_open
  ON events(COALESCE(owner_email, ''), dedupe_key) WHERE status = 'pending'`;

  function callerOwner(deps) {
    if (!deps || typeof deps.ownerEmail !== "string" || deps.ownerEmail === "") return null;
    return deps.ownerEmail;
  }

  /** Lease identity on the bus: the account email, or LEGACY_OWNER. */
  function busOwner(deps) {
    return callerOwner(deps) ?? LEGACY_OWNER;
  }

  async function ensureNullableColumn(deps, table, column) {
    const rows = await queryAll(
      deps,
      `SELECT name FROM pragma_table_info('${table}') WHERE name = '${column}'`,
      [],
    );
    if (rows.length > 0) return;
    try {
      await queryRun(deps, `ALTER TABLE ${table} ADD COLUMN ${column} TEXT`, []);
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      if (/duplicate column/i.test(message)) return;
      throw err;
    }
  }

  /** Idempotent: adds owner_email and rebuilds the pending dedupe index once. */
  async function ensureEventOwnerIsolation(deps) {
    await ensureNullableColumn(deps, "events", "owner_email");
    await ensureNullableColumn(deps, "subscriptions", "owner_email");
    const row = await queryFirst(
      deps,
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_dedupe_open'",
      [],
    );
    const sql = row && typeof row.sql === "string" ? row.sql : "";
    if (sql.includes("owner_email")) return;
    await queryRun(deps, "DROP INDEX IF EXISTS idx_events_dedupe_open", []);
    await queryRun(deps, DEDUPE_INDEX_SQL, []);
  }

  function subscriptionAllowed(caller, subOwner) {
    const owned = subOwner == null || subOwner === "" ? null : subOwner;
    // Exact match, including NULL. An ad_ account must not open a legacy
    // subscription: that row is a bus bypass (list, retarget, delete, rotate, poll).
    if (caller == null) return owned == null;
    return owned === caller;
  }

  function ownerBind(caller) {
    if (caller == null) return { clause: "owner_email IS NULL", params: [] };
    return { clause: "owner_email = ?", params: [caller] };
  }

  function readNotBefore(value, nowMs) {
    if (value == null) return new Date(nowMs).toISOString();
    const iso = canonicalUtc(value, "not_before");
    const t = Date.parse(iso);
    if (t < nowMs - 7 * DAY_MS || t > nowMs + 366 * DAY_MS) {
      throw new RpcError(-32602, "not_before is out of range");
    }
    return iso;
  }

  function assertEmitType(type) {
    if (typeof type !== "string" || type.length > 64 || !EVENT_TYPE_RE.test(type)) {
      throw new RpcError(-32602, "type is invalid");
    }
    if (type === "calendar.due" || type.startsWith("watchdog.")) {
      throw new RpcError(-32602, "type is not allowed");
    }
    return type;
  }

  function assertEmitDedupe(key) {
    if (typeof key !== "string" || !DEDUPE_RE.test(key)) throw new RpcError(-32602, "dedupe_key is invalid");
    if (key.startsWith("watchdog.") || key.startsWith("calendar.due:")) {
      throw new RpcError(-32602, "dedupe_key is not allowed");
    }
    return key;
  }

  function decodeCursor(cursor) {
    if (cursor == null) return { value: null, raw: null };
    if (cursor === "") return { value: null, raw: "" };
    if (typeof cursor !== "string" || !cursor.startsWith("v1.")) throw new RpcError(-32602, "cursor is invalid");
    let text;
    try {
      text = new TextDecoder().decode(base64UrlToBytes(cursor.slice(3)));
    } catch {
      throw new RpcError(-32602, "cursor is invalid");
    }
    const nl = text.indexOf("\n");
    if (nl <= 0 || text.indexOf("\n", nl + 1) !== -1) throw new RpcError(-32602, "cursor is invalid");
    const createdAt = text.slice(0, nl);
    const id = text.slice(nl + 1);
    if (!CURSOR_TIME_RE.test(createdAt) || !/^evt_[a-z0-9]{12}$/.test(id)) {
      throw new RpcError(-32602, "cursor is invalid");
    }
    return { value: { created_at: createdAt, id }, raw: cursor };
  }

  function requireSeal(deps) {
    const key = deps && deps.sealKey;
    if (!(key instanceof Uint8Array) || key.length !== 32) {
      throw new RpcError(-32603, "subscription seal is not configured");
    }
    return key;
  }

  async function sendDelivery(deps, deliveryId) {
    if (!deps || typeof deps.sendDelivery !== "function") throw new Error("deliver queue is not configured");
    await deps.sendDelivery(deliveryId);
  }

  async function sendDeliveries(deps, ids, now) {
    if (ids.length === 0) return;
    const batched = deps && typeof deps.sendDeliveries === "function";
    const chunk = batched ? QUEUE_BATCH_MAX : 1;
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      try {
        if (batched) await deps.sendDeliveries(part);
        else await sendDelivery(deps, part[0]);
      } catch (err) {
        console.error(JSON.stringify({ msg: "deliver enqueue failed", delivery_ids: part, error: err && err.message }));
        for (const id of part) {
          await queryRun(deps, "UPDATE deliveries SET queued_at = NULL, updated_at = ? WHERE id = ?", [now, id]);
        }
      }
    }
  }

  async function insertDelivery(deps, eventId, subscriptionId, fields) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId("dlv_");
      try {
        await queryRun(
          deps,
          `INSERT INTO deliveries (
            id, event_id, subscription_id, state, attempts, next_attempt_at, queued_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'due', 0, ?, ?, ?, ?)`,
          [id, eventId, subscriptionId, fields.nextAttemptAt, fields.queuedAt, fields.now, fields.now],
        );
        return id;
      } catch (err) {
        if (!isUniqueError(err)) throw err;
        const existing = await queryFirst(
          deps,
          "SELECT id FROM deliveries WHERE event_id = ? AND subscription_id = ?",
          [eventId, subscriptionId],
        );
        if (existing) return null;
      }
    }
    throw new Error("delivery id entropy exhausted");
  }

  async function fanoutEvent(deps, event) {
    const ownerEmail = event.ownerEmail == null || event.ownerEmail === "" ? null : event.ownerEmail;
    // Owned emits go only to that owner's webhooks; LEGACY_OWNER emits go only
    // to legacy (NULL-owner) webhooks. System emits (NULL owner) still match
    // every active webhook, the same set poll returns for each caller.
    const subs = await queryAll(
      deps,
      `SELECT id, event_types FROM subscriptions
WHERE status = 'active' AND mode = 'webhook'
  AND (? IS NULL OR owner_email = ? OR (? = ? AND (owner_email IS NULL OR owner_email = '')))`,
      [ownerEmail, ownerEmail, ownerEmail, LEGACY_OWNER],
    );
    const nowMs = Date.parse(event.now);
    const visible = Date.parse(event.notBefore) <= nowMs;
    const queued = [];
    for (const sub of subs) {
      if (!eventTypeMatches(event.type, parseFilters(sub.event_types))) continue;
      const queuedAt = visible ? event.now : null;
      const nextAttemptAt = visible ? null : event.notBefore;
      const id = await insertDelivery(deps, event.id, sub.id, {
        nextAttemptAt,
        queuedAt,
        now: event.now,
      });
      if (id && visible) queued.push(id);
    }
    await sendDeliveries(deps, queued, event.now);
  }

  async function insertBusEvent(deps, spec) {
    const now = nowIso(deps);
    const notBefore = spec.notBefore || now;
    const audience = spec.audience == null ? "bot" : spec.audience;
    const ownerEmail = spec.ownerEmail == null || spec.ownerEmail === "" ? null : spec.ownerEmail;
    await ensureAudienceColumn(deps);
    await ensureEventOwnerIsolation(deps);
    if (ownerEmail === LEGACY_OWNER) {
      // Rows stored before legacy emits had an owner still dedupe legacy re-emits.
      const stock = await queryFirst(
        deps,
        "SELECT id FROM events WHERE dedupe_key = ? AND status = 'pending' AND owner_email IS NULL",
        [spec.dedupeKey],
      );
      if (stock) return { id: stock.id, created: false };
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId("evt_");
      try {
        const result = await queryRun(
          deps,
          `INSERT INTO events (
            id, type, payload, status, dedupe_key, created_at, not_before, source, updated_at, audience, owner_email
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(COALESCE(owner_email, ''), dedupe_key) WHERE status = 'pending' DO NOTHING`,
          [id, spec.type, spec.payloadText, spec.dedupeKey, now, notBefore, spec.source, now, audience, ownerEmail],
        );
        if (changesOf(result) === 0) {
          const existing = await queryFirst(
            deps,
            "SELECT id FROM events WHERE dedupe_key = ? AND status = 'pending' AND owner_email IS ?",
            [spec.dedupeKey, ownerEmail],
          );
          if (!existing) throw new Error("dedupe conflict without row");
          return { id: existing.id, created: false };
        }
        if (spec.type !== "watchdog.queue_dlq") {
          await fanoutEvent(deps, { id, type: spec.type, notBefore, now, ownerEmail });
        }
        return { id, created: true };
      } catch (err) {
        if (isUniqueError(err)) continue;
        throw err;
      }
    }
    throw new Error("id entropy exhausted");
  }

  async function ensureEventClaims(deps) {
    await queryRun(
      deps,
      `CREATE TABLE IF NOT EXISTS event_claims (
        event_id TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        lease_token TEXT,
        leased_until TEXT,
        poll_count INTEGER NOT NULL DEFAULT 0,
        acked_at TEXT,
        PRIMARY KEY (event_id, owner_email)
      )`,
      [],
    );
  }

  async function ensureOwnerHeartbeats(deps) {
    await queryRun(
      deps,
      `CREATE TABLE IF NOT EXISTS owner_heartbeats (
        owner_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        ttl_seconds INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_key, agent_id)
      )`,
      [],
    );
    await queryRun(
      deps,
      `INSERT OR IGNORE INTO owner_heartbeats (owner_key, agent_id, seen_at, ttl_seconds, updated_at)
SELECT ?, agent_id, seen_at, ttl_seconds, updated_at FROM heartbeats`,
      [LEGACY_OWNER],
    );
  }

  async function listVisible(deps, now, { after, beforeOrEqual, expiredLeaseOnly, limit, audience, owner }) {
    const where = ["status = 'pending'", "not_before <= ?"];
    const params = [now];
    if (audience) {
      where.push("audience = ?");
      params.push(audience);
    }
    {
      // Own rows use the event lease. System rows use event_claims so one
      // caller cannot consume the lease or the ack for every other caller.
      where.push(`(
        (owner_email = ? AND (leased_until IS NULL OR leased_until <= ?))
        OR (
          owner_email IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM event_claims c
            WHERE c.event_id = events.id
              AND c.owner_email = ?
              AND (
                c.acked_at IS NOT NULL
                OR (c.leased_until IS NOT NULL AND c.leased_until > ?)
              )
          )
        )
      )`);
      params.push(owner, now, owner, now);
    }
    if (expiredLeaseOnly) {
      {
        where.push(`(
          (owner_email = ? AND leased_until IS NOT NULL)
          OR (
            owner_email IS NULL AND EXISTS (
              SELECT 1 FROM event_claims c
              WHERE c.event_id = events.id AND c.owner_email = ?
                AND c.acked_at IS NULL AND c.leased_until IS NOT NULL
            )
          )
        )`);
        params.push(owner, owner);
      }
    }
    if (beforeOrEqual) {
      where.push("(created_at < ? OR (created_at = ? AND id <= ?))");
      params.push(beforeOrEqual.created_at, beforeOrEqual.created_at, beforeOrEqual.id);
    }
    if (after) {
      where.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(after.created_at, after.created_at, after.id);
    }
    params.push(limit);
    return queryAll(
      deps,
      `SELECT id, type, payload, dedupe_key, created_at, not_before, poll_count, owner_email
FROM events
WHERE ${where.join(" AND ")}
ORDER BY created_at ASC, id ASC
LIMIT ?`,
      params,
    );
  }

  async function scanVisible(deps, now, cursor, audience, owner) {
    if (!cursor) {
      const fetched = await listVisible(deps, now, { limit: SCAN_LIMIT + 1, audience, owner });
      return { scanned: fetched.slice(0, SCAN_LIMIT), moreUnseen: fetched.length > SCAN_LIMIT };
    }
    const before = await listVisible(deps, now, {
      beforeOrEqual: cursor,
      expiredLeaseOnly: true,
      limit: SCAN_LIMIT + 1,
      audience,
      owner,
    });
    if (before.length > SCAN_LIMIT) {
      return { scanned: before.slice(0, SCAN_LIMIT), moreUnseen: true };
    }
    if (before.length === SCAN_LIMIT) {
      const peek = await listVisible(deps, now, { after: cursor, limit: 1, audience, owner });
      return { scanned: before, moreUnseen: peek.length > 0 };
    }
    const room = SCAN_LIMIT - before.length;
    const after = await listVisible(deps, now, { after: cursor, limit: room + 1, audience, owner });
    return {
      scanned: before.concat(after.slice(0, room)),
      moreUnseen: after.length > room,
    };
  }

  async function existsMatchingAfter(deps, now, filters, tuple, audience, owner) {
    let after = tuple;
    for (let hop = 0; hop < 20; hop++) {
      const rows = await listVisible(deps, now, { after, limit: SCAN_LIMIT, audience, owner });
      if (!rows.length) return false;
      for (const row of rows) {
        if (eventTypeMatches(row.type, filters)) return true;
      }
      if (rows.length < SCAN_LIMIT) return false;
      const last = rows[rows.length - 1];
      after = { created_at: last.created_at, id: last.id };
    }
    return true;
  }

  async function retryAfterSeconds(deps, now, filters, audience, owner) {
    const rows = [];
    {
      const ownedParams = [now, owner, now];
      let ownedAud = "";
      if (audience) {
        ownedAud = " AND audience = ?";
        ownedParams.push(audience);
      }
      rows.push(
        ...(await queryAll(
          deps,
          `SELECT type, leased_until FROM events
WHERE status = 'pending' AND not_before <= ? AND owner_email = ? AND leased_until IS NOT NULL AND leased_until > ?${ownedAud}`,
          ownedParams,
        )),
      );
      const claimParams = [now, owner, now];
      let claimAud = "";
      if (audience) {
        claimAud = " AND e.audience = ?";
        claimParams.push(audience);
      }
      rows.push(
        ...(await queryAll(
          deps,
          `SELECT e.type AS type, c.leased_until AS leased_until
FROM event_claims c
JOIN events e ON e.id = c.event_id
WHERE e.status = 'pending' AND e.not_before <= ? AND e.owner_email IS NULL
  AND c.owner_email = ? AND c.acked_at IS NULL AND c.leased_until IS NOT NULL AND c.leased_until > ?${claimAud}`,
          claimParams,
        )),
      );
    }
    let best = null;
    for (const row of rows) {
      if (!eventTypeMatches(row.type, filters)) continue;
      const t = Date.parse(row.leased_until);
      if (Number.isNaN(t)) continue;
      if (best == null || t < best) best = t;
    }
    if (best == null) return 0;
    return Math.max(1, Math.ceil((best - Date.parse(now)) / 1000));
  }

  function subscriptionView(row) {
    let eventTypes = [];
    try {
      const parsed = JSON.parse(row.event_types);
      eventTypes = Array.isArray(parsed) ? parsed : [];
    } catch {
      eventTypes = [];
    }
    return {
      id: row.id,
      mode: row.mode,
      status: row.status,
      url: row.url ?? null,
      event_types: eventTypes,
      webhook_auth: row.webhook_auth === "bearer" ? "bearer" : "hmac",
      has_secret: row.has_secret === 1 || row.has_secret === true,
      watch_heartbeat: row.watch_heartbeat === 1 || row.watch_heartbeat === true,
      agent_id: row.agent_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  const SUB_VIEW_SQL = `SELECT id, mode, status, url, event_types, webhook_auth,
  CASE WHEN secret_sealed IS NULL THEN 0 ELSE 1 END AS has_secret,
  watch_heartbeat, agent_id, created_at, updated_at
FROM subscriptions`;

  async function pollEvents(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["subscription_id", "cursor", "limit", "visibility_seconds", "audience"]));
    if (typeof args.subscription_id !== "string" || !/^sub_[a-z0-9]{12}$/.test(args.subscription_id)) {
      throw new RpcError(-32602, "subscription_id is required");
    }
    const limit = clampLimit(args.limit, 20, 100);
    const visibility = readVisibility(args.visibility_seconds);
    const audience = readPollAudience(args);
    const cursor = decodeCursor(has(args, "cursor") ? args.cursor : null);
    await ensureWebhookAuthColumn(deps);
    await ensureEventOwnerIsolation(deps);
    const caller = callerOwner(deps);
    const owner = busOwner(deps);
    await ensureEventClaims(deps);
    const sub = await queryFirst(
      deps,
      "SELECT id, mode, status, event_types, owner_email FROM subscriptions WHERE id = ?",
      [args.subscription_id],
    );
    if (!sub) throw notFound();
    if (!subscriptionAllowed(caller, sub.owner_email)) throw notFound();
    if (sub.status === "paused") throw new RpcError(-32602, "subscription paused");
    if (sub.mode !== "poll" && sub.mode !== "webhook") throw notFound();
    const filters = parseFilters(sub.event_types);
    const now = nowIso(deps);
    if (audience) await ensureAudienceColumn(deps);
    const scanned = await scanVisible(deps, now, cursor.value, audience, owner);
    const matches = [];
    let lastScanned = null;
    for (const row of scanned.scanned) {
      lastScanned = row;
      if (!eventTypeMatches(row.type, filters)) continue;
      matches.push(row);
      if (matches.length === limit) break;
    }
    const hitScanCap = matches.length < limit && scanned.moreUnseen && lastScanned;
    const leasedUntil = new Date(Date.parse(now) + visibility * 1000).toISOString();
    const tokens = matches.map(() => newLeaseToken());
    let won = [];
    if (matches.length) {
      if (!deps || typeof deps.batch !== "function") throw new Error("batch is not configured");
      const results = await deps.batch(
        matches.map((row, i) => {
          const system = row.owner_email == null || row.owner_email === "";
          if (system) {
            return {
              sql: `INSERT INTO event_claims (event_id, owner_email, lease_token, leased_until, poll_count, acked_at)
VALUES (?, ?, ?, ?, 1, NULL)
ON CONFLICT(event_id, owner_email) DO UPDATE SET
  lease_token = excluded.lease_token,
  leased_until = excluded.leased_until,
  poll_count = event_claims.poll_count + 1
WHERE event_claims.acked_at IS NULL
  AND (event_claims.leased_until IS NULL OR event_claims.leased_until <= ?)`,
              params: [row.id, owner, tokens[i], leasedUntil, now],
            };
          }
          return {
            sql: `UPDATE events
SET leased_until = ?, lease_token = ?, poll_count = poll_count + 1, updated_at = ?
WHERE id = ? AND status = 'pending' AND not_before <= ? AND (leased_until IS NULL OR leased_until <= ?)
AND owner_email = ?`,
            params: [leasedUntil, tokens[i], now, row.id, now, now, owner],
          };
        }),
      );
      for (let i = 0; i < matches.length; i++) {
        if (changesOf(results[i]) === 1) won.push({ row: matches[i], token: tokens[i] });
      }
    }
    const events = [];
    for (const { row, token } of won) {
      const system = row.owner_email == null || row.owner_email === "";
      let pollCount = Number(row.poll_count) + 1;
      if (system) {
        const claim = await queryFirst(
          deps,
          "SELECT poll_count FROM event_claims WHERE event_id = ? AND owner_email = ?",
          [row.id, owner],
        );
        if (claim) pollCount = Number(claim.poll_count);
      }
      events.push({
        id: row.id,
        type: row.type,
        payload: JSON.parse(row.payload),
        dedupe_key: row.dedupe_key,
        created_at: row.created_at,
        not_before: row.not_before,
        lease_token: token,
        leased_until: leasedUntil,
        poll_count: pollCount,
      });
    }
    let hasMore = false;
    if (hitScanCap) hasMore = true;
    else if (events.length === limit) {
      const last = events[events.length - 1];
      hasMore = await existsMatchingAfter(
        deps,
        now,
        filters,
        { created_at: last.created_at, id: last.id },
        audience,
        owner,
      );
    }
    let nextCursor = null;
    if (hitScanCap) nextCursor = encodeCursor(lastScanned.created_at, lastScanned.id);
    else if (events.length) nextCursor = encodeCursor(events[events.length - 1].created_at, events[events.length - 1].id);
    else nextCursor = cursor.raw;
    const retry = events.length === 0 && !hasMore ? await retryAfterSeconds(deps, now, filters, audience, owner) : 0;
    return { events, next_cursor: nextCursor, has_more: hasMore, retry_after_seconds: retry };
  }

  async function ackEvent(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id", "lease_token"]));
    const id = requireId(args.id, "evt_");
    if (!has(args, "lease_token") || args.lease_token == null || args.lease_token === "") {
      throw new RpcError(-32602, "lease_token is required");
    }
    if (typeof args.lease_token !== "string") throw new RpcError(-32602, "lease_token is required");
    await ensureEventOwnerIsolation(deps);
    const caller = busOwner(deps);
    const now = nowIso(deps);
    const existing = await queryFirst(
      deps,
      "SELECT id, status, created_at, owner_email FROM events WHERE id = ?",
      [id],
    );
    if (!existing) throw notFound();
    const eventOwner = existing.owner_email == null || existing.owner_email === "" ? null : existing.owner_email;
    if (eventOwner != null && eventOwner !== caller) throw notFound();
    const cursor = encodeCursor(existing.created_at, existing.id);
    if (eventOwner == null) {
      await ensureEventClaims(deps);
      if (LEASE_RE.test(args.lease_token)) {
        const result = await queryRun(
          deps,
          `UPDATE event_claims
SET acked_at = ?, lease_token = NULL, leased_until = NULL
WHERE event_id = ? AND owner_email = ? AND acked_at IS NULL AND lease_token = ?`,
          [now, id, caller, args.lease_token],
        );
        if (changesOf(result) === 1) return { id, status: "acked", idempotent: false, ack_cursor: cursor };
      }
      const claim = await queryFirst(
        deps,
        "SELECT acked_at FROM event_claims WHERE event_id = ? AND owner_email = ?",
        [id, caller],
      );
      if (claim && claim.acked_at) return { id, status: "acked", idempotent: true, ack_cursor: cursor };
      throw new RpcError(-32602, "lease mismatch");
    }
    let changes = 0;
    if (LEASE_RE.test(args.lease_token)) {
      const result = await queryRun(
        deps,
        `UPDATE events
SET status = 'acked', acked_at = ?, leased_until = NULL, lease_token = NULL, updated_at = ?
WHERE id = ? AND status = 'pending' AND lease_token = ? AND owner_email = ?`,
        [now, now, id, args.lease_token, caller],
      );
      changes = changesOf(result);
    }
    if (changes === 1) return { id, status: "acked", idempotent: false, ack_cursor: cursor };
    const row = await queryFirst(deps, "SELECT status FROM events WHERE id = ?", [id]);
    if (row && row.status === "acked") return { id, status: "acked", idempotent: true, ack_cursor: cursor };
    throw new RpcError(-32602, "lease mismatch");
  }

  async function heartbeat(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["agent_id", "ttl_seconds"]));
    const agentId = readAgent(has(args, "agent_id") ? args.agent_id : null, "bot:main");
    const ttl = readTtl(has(args, "ttl_seconds") ? args.ttl_seconds : null);
    const now = nowIso(deps);
    await ensureOwnerHeartbeats(deps);
    await queryRun(
      deps,
      `INSERT INTO owner_heartbeats (owner_key, agent_id, seen_at, ttl_seconds, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(owner_key, agent_id) DO UPDATE SET
  seen_at = excluded.seen_at,
  ttl_seconds = excluded.ttl_seconds,
  updated_at = excluded.updated_at`,
      [busOwner(deps), agentId, now, ttl, now],
    );
    return { agent_id: agentId, seen_at: now, ttl_seconds: ttl };
  }

  async function emitEvent(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["type", "dedupe_key", "payload", "not_before", "audience"]));
    const type = assertEmitType(args.type);
    const dedupeKey = assertEmitDedupe(args.dedupe_key);
    const payloadText = serialize(has(args, "payload") ? args.payload : {});
    const notBefore = readNotBefore(has(args, "not_before") ? args.not_before : null, nowMsOf(deps));
    const audience = readEmitAudience(args);
    return insertBusEvent(deps, {
      type,
      dedupeKey,
      payloadText,
      notBefore,
      source: "emit",
      audience,
      ownerEmail: busOwner(deps),
    });
  }

  async function createSubscription(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["mode", "url", "event_types", "watch_heartbeat", "agent_id", "bearer_token"]));
    if (!has(args, "mode")) throw new RpcError(-32602, "mode is required");
    if (args.mode !== "poll" && args.mode !== "webhook") throw new RpcError(-32602, "mode must be poll or webhook");
    const eventTypes = normalizeEventTypes(has(args, "event_types") ? args.event_types : null, { allowDefault: true });
    const watch = readWatch(has(args, "watch_heartbeat") ? args.watch_heartbeat : null, 1);
    const agentId = readAgent(has(args, "agent_id") ? args.agent_id : null, "bot:main");
    let url = null;
    let bearerToken = null;
    if (args.mode === "poll") {
      if (has(args, "url")) throw new RpcError(-32602, "url is not allowed");
      if (has(args, "bearer_token")) throw new RpcError(-32602, "bearer_token is not allowed");
    } else {
      if (!has(args, "url") || args.url == null || args.url === "") throw new RpcError(-32602, "url is required");
      url = assertWebhookUrl(args.url, deps && deps.env);
      if (has(args, "bearer_token")) bearerToken = assertBearerToken(args.bearer_token);
    }
    const webhookAuth = bearerToken == null ? "hmac" : "bearer";
    await ensureWebhookAuthColumn(deps);
    await ensureEventOwnerIsolation(deps);
    const ownerEmail = callerOwner(deps);
    const now = nowIso(deps);
    const { clause, params } = ownerBind(ownerEmail);
    const count = await queryFirst(deps, `SELECT COUNT(*) AS n FROM subscriptions WHERE ${clause}`, params);
    const cap = ownerEmail == null ? MAX_LEGACY_SUBSCRIPTIONS : MAX_SUBSCRIPTIONS_PER_ACCOUNT;
    if (count && Number(count.n) >= cap) throw new RpcError(-32602, "subscription limit reached");
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId("sub_");
      let secret = null;
      let sealed = null;
      if (args.mode === "webhook") {
        const key = requireSeal(deps);
        secret = bearerToken == null ? newWebhookSecret() : bearerToken;
        sealed = await sealSecret(secret, id, key);
      }
      try {
        await queryRun(
          deps,
          `INSERT INTO subscriptions (
            id, mode, status, url, event_types, secret_sealed, webhook_auth, watch_heartbeat, agent_id, created_at, updated_at, owner_email
          ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, args.mode, url, eventTypes, sealed, webhookAuth, watch, agentId, now, now, ownerEmail],
        );
        const out = { id, mode: args.mode, status: "active" };
        if (webhookAuth === "hmac" && secret) out.secret = secret;
        return out;
      } catch (err) {
        if (!isUniqueError(err)) throw err;
      }
    }
    throw new Error("id entropy exhausted");
  }

  async function getSubscription(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id"]));
    const id = requireId(args.id, "sub_");
    await ensureWebhookAuthColumn(deps);
    await ensureEventOwnerIsolation(deps);
    const ownerRow = await queryFirst(deps, "SELECT owner_email FROM subscriptions WHERE id = ?", [id]);
    if (!ownerRow) throw notFound();
    if (!subscriptionAllowed(callerOwner(deps), ownerRow.owner_email)) throw notFound();
    const row = await queryFirst(deps, `${SUB_VIEW_SQL} WHERE id = ?`, [id]);
    if (!row) throw notFound();
    return subscriptionView(row);
  }

  async function listSubscriptions(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["limit"]));
    const limit = clampLimit(args.limit, 20, 100);
    await ensureWebhookAuthColumn(deps);
    await ensureEventOwnerIsolation(deps);
    // Account callers see only their rows. A NULL-owner subscription is legacy-only.
    const owner = callerOwner(deps);
    const where = [];
    const params = [];
    if (owner != null) {
      where.push("owner_email = ?");
      params.push(owner);
    }
    params.push(limit);
    const rows = await queryAll(
      deps,
      `${SUB_VIEW_SQL}${where.length ? `\nWHERE ${where.join(" AND ")}` : ""}
ORDER BY created_at ASC, id ASC
LIMIT ?`,
      params,
    );
    return rows.map(subscriptionView);
  }

  async function updateSubscription(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id", "url", "event_types", "status", "watch_heartbeat", "agent_id"]));
    const id = requireId(args.id, "sub_");
    const existing = await queryFirst(deps, "SELECT id, mode, status, owner_email FROM subscriptions WHERE id = ?", [id]);
    if (!existing) throw notFound();
    if (!subscriptionAllowed(callerOwner(deps), existing.owner_email)) throw notFound();
    const sets = [];
    const params = [];
    if (has(args, "url")) {
      if (existing.mode !== "webhook") throw new RpcError(-32602, "url is not allowed");
      sets.push("url = ?");
      params.push(assertWebhookUrl(args.url, deps && deps.env));
    }
    if (has(args, "event_types")) {
      sets.push("event_types = ?");
      params.push(normalizeEventTypes(args.event_types, { allowDefault: false }));
    }
    let status = null;
    if (has(args, "status")) {
      if (args.status !== "active" && args.status !== "paused") {
        throw new RpcError(-32602, "status must be active or paused");
      }
      status = args.status;
      sets.push("status = ?");
      params.push(status);
    }
    if (has(args, "watch_heartbeat")) {
      sets.push("watch_heartbeat = ?");
      params.push(readWatch(args.watch_heartbeat, null));
    }
    if (has(args, "agent_id")) {
      sets.push("agent_id = ?");
      params.push(readAgent(args.agent_id, null));
    }
    if (sets.length === 0) throw new RpcError(-32602, "no fields to update");
    await ensureWebhookAuthColumn(deps);
    const now = nowIso(deps);
    const bind = ownerBind(callerOwner(deps));
    sets.push("updated_at = ?");
    params.push(now, id, ...bind.params);
    const updated = await queryRun(
      deps,
      `UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ? AND ${bind.clause}`,
      params,
    );
    if (changesOf(updated) !== 1) throw notFound();
    if (status === "paused") {
      await queryRun(
        deps,
        `UPDATE deliveries SET state = 'paused', updated_at = ?
WHERE subscription_id = ? AND state IN ('due', 'inflight')`,
        [now, id],
      );
    } else if (status === "active") {
      await queryRun(
        deps,
        `UPDATE deliveries SET state = 'due', next_attempt_at = NULL, queued_at = NULL, updated_at = ?
WHERE subscription_id = ? AND state = 'paused'`,
        [now, id],
      );
    }
    const row = await queryFirst(deps, `${SUB_VIEW_SQL} WHERE id = ?`, [id]);
    return subscriptionView(row);
  }

  async function deleteSubscription(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id"]));
    const id = requireId(args.id, "sub_");
    const existing = await queryFirst(deps, "SELECT id, owner_email FROM subscriptions WHERE id = ?", [id]);
    if (!existing) throw notFound();
    if (!subscriptionAllowed(callerOwner(deps), existing.owner_email)) throw notFound();
    const now = nowIso(deps);
    const bind = ownerBind(callerOwner(deps));
    const deleted = await queryRun(
      deps,
      `DELETE FROM subscriptions WHERE id = ? AND ${bind.clause}`,
      [id, ...bind.params],
    );
    if (changesOf(deleted) !== 1) throw notFound();
    await queryRun(
      deps,
      `UPDATE deliveries SET state = 'dead', dead_reason = 'subscription_deleted', updated_at = ?
WHERE subscription_id = ? AND state IN ('due', 'inflight', 'paused')`,
      [now, id],
    );
    return { id, deleted: true };
  }

  async function rotateSubscriptionSecret(args, deps) {
    requireArgs(args);
    assertOnlyKeys(args, new Set(["id", "bearer_token"]));
    const id = requireId(args.id, "sub_");
    await ensureWebhookAuthColumn(deps);
    const existing = await queryFirst(deps, "SELECT id, mode, webhook_auth, owner_email FROM subscriptions WHERE id = ?", [id]);
    if (!existing) throw notFound();
    if (!subscriptionAllowed(callerOwner(deps), existing.owner_email)) throw notFound();
    if (existing.mode !== "webhook") throw new RpcError(-32602, "subscription has no webhook secret");
    const bearer = existing.webhook_auth === "bearer";
    if (bearer) {
      if (!has(args, "bearer_token")) throw new RpcError(-32602, "bearer_token is required");
    } else if (has(args, "bearer_token")) {
      throw new RpcError(-32602, "bearer_token is not allowed");
    }
    const key = requireSeal(deps);
    const secret = bearer ? assertBearerToken(args.bearer_token) : newWebhookSecret();
    const sealed = await sealSecret(secret, id, key);
    const now = nowIso(deps);
    const bind = ownerBind(callerOwner(deps));
    const rotated = await queryRun(
      deps,
      `UPDATE subscriptions SET secret_sealed = ?, updated_at = ? WHERE id = ? AND ${bind.clause}`,
      [sealed, now, id, ...bind.params],
    );
    if (changesOf(rotated) !== 1) throw notFound();
    if (bearer) return { id };
    return { id, secret };
  }

  async function buildCalendarDuePayload(row) {
    return {
      all_day: row.all_day === 1 || row.all_day === true,
      calendar_event_id: row.id,
      end_utc: row.end_utc || "",
      location: row.location ?? null,
      path: `/cal/${row.id}`,
      start_utc: row.start_utc || "",
      timezone: row.timezone || "",
      title: row.title || "",
    };
  }

  // Emit calendar.due for one event if not already emitted (any status).
  // Returns true if emitted, false if skipped.
  async function emitCalendarDueForEvent(deps, eventId, source) {
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    await ensureEventOwnerIsolation(deps);
    const row = await queryFirst(
      deps,
      `SELECT ce.id, ce.title, ce.start_utc, ce.end_utc, ce.timezone, ce.all_day, ce.location, ce.owner_email
FROM calendar_events ce
WHERE ce.id = ?
  AND ce.status = 'confirmed'
  AND ce.start_utc <= ?
  AND NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.dedupe_key = 'calendar.due:' || ce.id || ':' || ce.start_utc
      AND (e.owner_email IS ce.owner_email OR e.owner_email = COALESCE(ce.owner_email, ?))
  )`,
      [eventId, now, LEGACY_OWNER],
    );
    if (!row) return false;
    // A row without owner is legacy data: only the legacy caller may see it.
    const ownerEmail = row.owner_email == null || row.owner_email === "" ? LEGACY_OWNER : row.owner_email;
    await insertBusEvent(deps, {
      type: "calendar.due",
      dedupeKey: `calendar.due:${row.id}:${row.start_utc}`,
      payloadText: stableStringify(await buildCalendarDuePayload(row)),
      notBefore: now,
      source: source || "detector",
      ownerEmail,
    });
    return true;
  }

  async function detectCalendarDue(deps) {
    await ensureEventOwnerIsolation(deps);
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    const left = new Date(nowMs - 7 * DAY_MS).toISOString();
    const rows = await queryAll(
      deps,
      `SELECT ce.id
FROM calendar_events ce
WHERE ce.status = 'confirmed'
  AND ce.start_utc <= ?
  AND ce.start_utc >= ?
  AND NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.dedupe_key = 'calendar.due:' || ce.id || ':' || ce.start_utc
      AND (e.owner_email IS ce.owner_email OR e.owner_email = COALESCE(ce.owner_email, ?))
  )
ORDER BY ce.start_utc ASC, ce.id ASC
LIMIT ?`,
      [now, left, LEGACY_OWNER, DETECT_LIMIT],
    );
    for (const row of rows) {
      await emitCalendarDueForEvent(deps, row.id);
    }
  }

  async function detectStaleHeartbeats(deps) {
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    await ensureEventOwnerIsolation(deps);
    await ensureOwnerHeartbeats(deps);
    const beats = await queryAll(
      deps,
      `SELECT h.owner_key, h.agent_id, h.seen_at, h.ttl_seconds
FROM (
  SELECT COALESCE(NULLIF(owner_email, ''), ?) AS owner_key, agent_id
  FROM subscriptions
  WHERE status = 'active' AND watch_heartbeat = 1
  GROUP BY 1, 2
) s
JOIN owner_heartbeats h ON h.owner_key = s.owner_key AND h.agent_id = s.agent_id
ORDER BY h.owner_key ASC, h.agent_id ASC
LIMIT ?`,
      [LEGACY_OWNER, DETECT_LIMIT],
    );
    for (const beat of beats) {
      const seenMs = Date.parse(beat.seen_at);
      const ttl = Number(beat.ttl_seconds);
      if (Number.isNaN(seenMs) || !Number.isFinite(ttl)) continue;
      if (seenMs + ttl * 1000 >= nowMs) continue;
      const staleFor = Math.max(0, Math.floor((nowMs - seenMs) / 1000) - ttl);
      const payload = {
        agent_id: beat.agent_id,
        observed_at: now,
        seen_at: beat.seen_at,
        stale_for_seconds: staleFor,
        ttl_seconds: ttl,
      };
      await insertBusEvent(deps, {
        type: "watchdog.heartbeat_stale",
        dedupeKey: `watchdog.heartbeat_stale:${beat.agent_id}`,
        payloadText: stableStringify(payload),
        notBefore: now,
        source: "detector",
        ownerEmail: beat.owner_key,
      });
    }
  }

  async function detectDeadDeliveries(deps) {
    const now = nowIso(deps);
    await ensureEventOwnerIsolation(deps);
    await ensureNullableColumn(deps, "deliveries", "reported_at");
    const rows = await queryAll(
      deps,
      `SELECT d.id, d.event_id, d.subscription_id, d.attempts, d.dead_reason, d.last_error,
  e.type AS event_type, s.id AS sub_id, s.owner_email AS sub_owner
FROM deliveries d
LEFT JOIN events e ON e.id = d.event_id
LEFT JOIN subscriptions s ON s.id = d.subscription_id
WHERE d.state = 'dead' AND d.reported_at IS NULL
  AND COALESCE(d.dead_reason, '') != 'subscription_deleted'
ORDER BY d.updated_at ASC, d.id ASC
LIMIT ?`,
      [DETECT_LIMIT],
    );
    for (const row of rows) {
      // Without the subscription there is no owner to tell; never broadcast it.
      if (row.event_type != null && row.sub_id != null) {
        const payload = {
          attempts: Number(row.attempts) || 0,
          dead_reason: row.dead_reason || "",
          delivery_id: row.id,
          event_id: row.event_id,
          event_type: row.event_type || "",
          last_error: row.last_error || "",
          queue: DLQ_QUEUE_NAME,
          subscription_id: row.subscription_id,
        };
        await insertBusEvent(deps, {
          type: "watchdog.queue_dlq",
          dedupeKey: `watchdog.queue_dlq:${row.id}`,
          payloadText: stableStringify(payload),
          notBefore: now,
          source: "detector",
          ownerEmail: row.sub_owner == null || row.sub_owner === "" ? LEGACY_OWNER : row.sub_owner,
        });
      }
      await queryRun(deps, "UPDATE deliveries SET reported_at = ? WHERE id = ?", [now, row.id]);
    }
  }

  async function requeueDueDeliveries(deps) {
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    const cutoff = new Date(nowMs - 900 * 1000).toISOString();
    const rows = await queryAll(
      deps,
      `SELECT id FROM deliveries
WHERE state = 'due'
  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
  AND (queued_at IS NULL OR queued_at <= ?)
LIMIT ?`,
      [now, cutoff, DETECT_LIMIT],
    );
    for (const row of rows) {
      await queryRun(
        deps,
        "UPDATE deliveries SET queued_at = ?, updated_at = ? WHERE id = ? AND state = 'due'",
        [now, now, row.id],
      );
      try {
        await sendDelivery(deps, row.id);
      } catch (err) {
        console.error(JSON.stringify({ msg: "deliver requeue failed", delivery_id: row.id, error: err && err.message }));
        await queryRun(deps, "UPDATE deliveries SET queued_at = NULL, updated_at = ? WHERE id = ?", [now, row.id]);
      }
    }
  }

  async function reclaimStuckInflight(deps) {
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    const stuckBefore = new Date(nowMs - INFLIGHT_STALE_MS).toISOString();
    await queryRun(
      deps,
      `UPDATE deliveries
SET state = 'due', queued_at = NULL, updated_at = ?
WHERE state = 'inflight' AND inflight_at IS NOT NULL AND inflight_at <= ?`,
      [now, stuckBefore],
    );
  }

  async function loadDeliveryContext(env, deliveryId) {
    const db = d1Deps(env);
    const delivery = await db.queryFirst("SELECT * FROM deliveries WHERE id = ?", [deliveryId]);
    if (!delivery) return { db, delivery: null, event: null, subscription: null };
    const event = await db.queryFirst(
      "SELECT id, type, payload, dedupe_key, created_at, not_before, status FROM events WHERE id = ?",
      [delivery.event_id],
    );
    await ensureWebhookAuthColumn(db);
    const subscription = await db.queryFirst(
      "SELECT id, mode, status, url, secret_sealed, webhook_auth FROM subscriptions WHERE id = ?",
      [delivery.subscription_id],
    );
    return { db, delivery, event, subscription };
  }

  async function markDead(db, id, deadReason, lastError, attempts, now) {
    await db.queryRun(
      `UPDATE deliveries
SET state = 'dead', dead_reason = ?, last_error = ?, attempts = ?, updated_at = ?
WHERE id = ?`,
      [deadReason, lastError, attempts, now, id],
    );
  }

  async function failDelivery(db, delivery, lastError, nowMs) {
    const attempts = Number(delivery.attempts) + 1;
    const now = new Date(nowMs).toISOString();
    if (attempts >= 4) {
      await markDead(db, delivery.id, "retries_exhausted", lastError, attempts, now);
      console.log(
        JSON.stringify({
          msg: "deliver",
          delivery_id: delivery.id,
          event_id: delivery.event_id,
          state: "dead",
          last_error: lastError,
        }),
      );
      return { action: "ack" };
    }
    const delay = RETRY_DELAYS[attempts - 1];
    const next = new Date(nowMs + delay * 1000).toISOString();
    await db.queryRun(
      `UPDATE deliveries
SET state = 'due', attempts = ?, next_attempt_at = ?, last_error = ?, queued_at = ?, updated_at = ?
WHERE id = ?`,
      [attempts, next, lastError, now, now, delivery.id],
    );
    console.log(
      JSON.stringify({
        msg: "deliver",
        delivery_id: delivery.id,
        event_id: delivery.event_id,
        state: "due",
        last_error: lastError,
      }),
    );
    return { action: "retry", delaySeconds: delay };
  }

  async function consumeDelivery(message, env, deps = {}) {
    const body = message && message.body;
    const deliveryId = body && typeof body === "object" && !Array.isArray(body) ? body.delivery_id : null;
    if (typeof deliveryId !== "string" || !/^dlv_[a-z0-9]{12}$/.test(deliveryId)) return { action: "ack" };
    const ctx = await loadDeliveryContext(env, deliveryId);
    const { db, delivery } = ctx;
    if (!delivery || delivery.state === "succeeded" || delivery.state === "dead") return { action: "ack" };
    const sub = ctx.subscription;
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    if (!sub || sub.mode !== "webhook" || sub.status !== "active") {
      if (sub && sub.status === "paused" && delivery.state === "inflight") {
        await db.queryRun(
          "UPDATE deliveries SET state = 'paused', updated_at = ? WHERE id = ? AND state = 'inflight'",
          [now, delivery.id],
        );
      }
      return { action: "ack" };
    }
    // Another consumer may hold this row; take it over only once that attempt is stale.
    const staleBefore = new Date(nowMs - INFLIGHT_STALE_MS).toISOString();
    const cas = await db.queryRun(
      `UPDATE deliveries SET state = 'inflight', inflight_at = ?, updated_at = ?
WHERE id = ? AND (
  state = 'due'
  OR (state = 'inflight' AND (inflight_at IS NULL OR inflight_at <= ?))
)`,
      [now, now, delivery.id, staleBefore],
    );
    if (changesOf(cas) !== 1) return { action: "ack" };
    if (!ctx.event) {
      await markDead(db, delivery.id, "retries_exhausted", delivery.last_error || "handler_crash", Number(delivery.attempts), now);
      return { action: "ack" };
    }
    // The denylist may have grown since the subscription was created.
    let target = null;
    try {
      target = new URL(sub.url);
    } catch {
      target = null;
    }
    if (!target || target.protocol !== "https:" || webhookHostBlocked(target.hostname, env)) {
      await markDead(db, delivery.id, "url_blocked", "url_blocked", Number(delivery.attempts), now);
      console.log(JSON.stringify({ msg: "deliver", delivery_id: delivery.id, state: "dead", last_error: "url_blocked" }));
      return { action: "ack" };
    }
    let secret;
    try {
      const key = decodeSealKey(env);
      if (!key || typeof sub.secret_sealed !== "string" || sub.secret_sealed === "") throw new Error("seal");
      secret = await openSecret(sub.secret_sealed, sub.id, key);
    } catch (err) {
      console.error(JSON.stringify({ msg: "deliver", delivery_id: delivery.id, state: "dead", last_error: "seal_error" }));
      await db.queryRun(
        `UPDATE deliveries
SET state = 'dead', dead_reason = 'seal_error', last_error = 'seal_error', updated_at = ?
WHERE id = ?`,
        [now, delivery.id],
      );
      return { action: "ack" };
    }
    const bodyText = buildWebhookBody(ctx.event);
    const timestamp = String(Math.floor(nowMs / 1000));
    const bearer = sub.webhook_auth === "bearer";
    const signature = bearer ? null : await signWebhook(secret, timestamp, bodyText);
    const headers = bearer
      ? {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${secret}`,
          "user-agent": "abot-data-webhook/1",
          "x-abot-timestamp": timestamp,
          "x-abot-event-id": ctx.event.id,
          "x-abot-subscription-id": sub.id,
        }
      : {
          "content-type": "application/json; charset=utf-8",
          "user-agent": "abot-data-webhook/1",
          "x-abot-timestamp": timestamp,
          "x-abot-event-id": ctx.event.id,
          "x-abot-subscription-id": sub.id,
          "x-abot-signature": `v1=${signature}`,
        };
    const fetchImpl = deps.fetch || fetch;
    let response;
    try {
      response = await fetchImpl(sub.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers,
        body: bodyText,
      });
    } catch (err) {
      return failDelivery(db, delivery, fetchFailureToken(err), nowMs);
    }
    const status = response && Number(response.status);
    if (status >= 200 && status < 300) {
      await db.queryRun("UPDATE deliveries SET state = 'succeeded', updated_at = ? WHERE id = ?", [now, delivery.id]);
      console.log(
        JSON.stringify({
          msg: "deliver",
          delivery_id: delivery.id,
          event_id: ctx.event.id,
          type: ctx.event.type,
          state: "succeeded",
        }),
      );
      return { action: "ack" };
    }
    if (isRetryableStatus(status)) return failDelivery(db, delivery, httpErrorToken(status), nowMs);
    const token = httpErrorToken(status);
    await markDead(db, delivery.id, "http_status", token, Number(delivery.attempts) + 1, now);
    console.log(
      JSON.stringify({
        msg: "deliver",
        delivery_id: delivery.id,
        event_id: ctx.event.id,
        type: ctx.event.type,
        state: "dead",
        last_error: token,
      }),
    );
    return { action: "ack" };
  }

  async function consumeDeadDelivery(message, env, deps = {}) {
    const body = message && message.body;
    const deliveryId = body && typeof body === "object" && !Array.isArray(body) ? body.delivery_id : null;
    if (typeof deliveryId !== "string") return { action: "ack" };
    const db = d1Deps(env);
    const delivery = await db.queryFirst("SELECT id, state, last_error FROM deliveries WHERE id = ?", [deliveryId]);
    if (!delivery || delivery.state === "succeeded" || delivery.state === "dead") return { action: "ack" };
    const now = new Date(nowMsOf(deps)).toISOString();
    const lastError = delivery.last_error || "handler_crash";
    await db.queryRun(
      `UPDATE deliveries
SET state = 'dead', dead_reason = 'retries_exhausted', last_error = ?, updated_at = ?
WHERE id = ? AND state NOT IN ('succeeded', 'dead')`,
      [lastError, now, delivery.id],
    );
    console.log(
      JSON.stringify({
        msg: "deliver",
        delivery_id: delivery.id,
        state: "dead",
        last_error: lastError,
      }),
    );
    return { action: "ack" };
  }

  async function runIgnoringMissingTable(deps, sql, params) {
    try {
      await queryRun(deps, sql, params);
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      if (/no such table/i.test(message)) return;
      throw err;
    }
  }

  async function applyRetention(deps) {
    const nowMs = nowMsOf(deps);
    const now = new Date(nowMs).toISOString();
    const expireBefore = new Date(nowMs - EVENT_TTL_MS).toISOString();
    const deleteBefore = new Date(nowMs - EVENT_KEEP_MS).toISOString();
    await ensureNullableColumn(deps, "deliveries", "reported_at");
    await ensureEventClaims(deps);
    await queryRun(
      deps,
      `UPDATE events
SET status = 'expired', leased_until = NULL, lease_token = NULL, updated_at = ?
WHERE id IN (
  SELECT id FROM events WHERE status = 'pending' AND not_before < ?
  ORDER BY not_before ASC, id ASC LIMIT ?
)`,
      [now, expireBefore, RETENTION_LIMIT],
    );
    await queryRun(
      deps,
      `UPDATE deliveries
SET state = 'dead', dead_reason = 'event_expired', last_error = 'event_expired', reported_at = ?, updated_at = ?
WHERE state NOT IN ('succeeded', 'dead')
  AND event_id IN (SELECT id FROM events WHERE status = 'expired' AND updated_at = ?)`,
      [now, now, now],
    );
    const finished = `SELECT id FROM events
WHERE status != 'pending' AND updated_at < ?
  AND NOT EXISTS (
    SELECT 1 FROM deliveries d WHERE d.event_id = events.id AND d.state NOT IN ('succeeded', 'dead')
  )
ORDER BY updated_at ASC, id ASC LIMIT ?`;
    const finishedParams = [deleteBefore, RETENTION_LIMIT];
    await queryRun(deps, `DELETE FROM deliveries WHERE event_id IN (${finished})`, finishedParams);
    await queryRun(deps, `DELETE FROM event_claims WHERE event_id IN (${finished})`, finishedParams);
    await queryRun(deps, `DELETE FROM events WHERE id IN (${finished})`, finishedParams);
    const dayAgo = new Date(nowMs - DAY_MS).toISOString();
    await runIgnoringMissingTable(deps, "DELETE FROM oauth_codes WHERE expires_at < ?", [dayAgo]);
    await runIgnoringMissingTable(deps, "DELETE FROM verification_codes WHERE expires_at < ?", [dayAgo]);
    await runIgnoringMissingTable(deps, "DELETE FROM verification_requests WHERE requested_at < ?", [dayAgo]);
  }

  async function handleScheduled(_event, env, deps = {}) {
    const ctx = bindRuntime(env, deps);
    await detectCalendarDue(ctx);
    await detectStaleHeartbeats(ctx);
    await detectDeadDeliveries(ctx);
    await requeueDueDeliveries(ctx);
    await reclaimStuckInflight(ctx);
    await applyRetention(ctx);
  }

  async function handleQueue(batch, env, deps = {}) {
    const dead = batch && batch.queue === DLQ_QUEUE_NAME;
    for (const message of (batch && batch.messages) || []) {
      try {
        const decision = dead
          ? await consumeDeadDelivery(message, env, deps)
          : await consumeDelivery(message, env, deps);
        if (decision.action === "retry") message.retry({ delaySeconds: decision.delaySeconds });
        else message.ack();
      } catch (err) {
        console.error(JSON.stringify({ msg: "deliver failed", error: err && err.message }));
        throw err;
      }
    }
  }

  function bindRuntime(env, deps) {
    const db = d1Deps(env);
    return {
      queryAll: (sql, params) => db.queryAll(sql, params),
      queryFirst: (sql, params) => db.queryFirst(sql, params),
      queryRun: (sql, params) => db.queryRun(sql, params),
      batch: (statements) => db.batch(statements),
      nowMs: deps && deps.nowMs,
      origin: deps && deps.origin,
      sealKey: decodeSealKey(env),
      async sendDelivery(deliveryId) {
        const queue = env && env.DELIVER_QUEUE;
        if (!queue || typeof queue.send !== "function") throw new Error("deliver queue is not configured");
        await queue.send({ delivery_id: deliveryId });
      },
      async sendDeliveries(deliveryIds) {
        const queue = env && env.DELIVER_QUEUE;
        if (queue && typeof queue.sendBatch === "function") {
          await queue.sendBatch(deliveryIds.map((id) => ({ body: { delivery_id: id } })));
          return;
        }
        if (!queue || typeof queue.send !== "function") throw new Error("deliver queue is not configured");
        for (const id of deliveryIds) await queue.send({ delivery_id: id });
      },
    };
  }

  const tools = [
    {
      name: "poll_events",
      description:
        "按订阅认领可见的 pending 事件。cursor 只翻页，不表示完成。返回 events、next_cursor、has_more、retry_after_seconds。传入 audience 时只返回该受众，不传则返回全部。账户 token 只返回自己的事件，外加还没被该账户认领的系统事件；系统事件按账户单独租约，不会被别人的 poll 抢走。别人的订阅、以及没有 owner 的系统订阅，与不存在一样，返回 not found。legacy token 只能 poll 系统订阅，看到 legacy 写入的事件和系统事件。",
      inputSchema: {
        type: "object",
        properties: {
          subscription_id: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          visibility_seconds: { type: "integer", minimum: 30, maximum: 900, default: 120 },
          audience: { type: "string", enum: ["bot", "user"] },
        },
        required: ["subscription_id"],
        additionalProperties: false,
      },
    },
    {
      name: "ack_event",
      description: "用 poll 返回的 lease_token 完成一条事件。重复 ack 返回 idempotent true。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          lease_token: { type: "string" },
        },
        required: ["id", "lease_token"],
        additionalProperties: false,
      },
    },
    {
      name: "heartbeat",
      description: "agent 报到。默认 agent_id 为 bot:main，ttl_seconds 默认 600。不修改事件。",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          ttl_seconds: { type: "integer", minimum: 120, maximum: 86400, default: 600 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "emit_event",
      description: "写入一条总线事件。拒绝 watchdog.* 和 calendar.due。新插入成功才扇出 webhook。audience 可选，只能是 bot 或 user，默认 bot。账户 token 写入的事件属于该邮箱；legacy token 写入的事件属于 legacy，只有 legacy 订阅看得到。",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          dedupe_key: { type: "string" },
          payload: { type: "object" },
          not_before: { type: "string" },
          audience: { type: "string", enum: ["bot", "user"], default: "bot" },
        },
        required: ["type", "dedupe_key"],
        additionalProperties: false,
      },
    },
    {
      name: "create_subscription",
      description:
        "创建 poll 或 webhook 订阅。不传 bearer_token 时 webhook 用 HMAC：服务端生成 secret，只在这次响应里出现。传入 bearer_token 时投递带 Authorization: Bearer，token 不回显。bearer_token 仅 webhook 可用，1 到 500 字符，不能含控制字符或换行。订阅记下调用方邮箱；legacy token 创建的订阅没有 owner，视为系统订阅。每个账户最多 20 个订阅，legacy 最多 100 个，超出返回 subscription limit reached。",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["poll", "webhook"] },
          url: { type: "string" },
          event_types: { type: "array", items: { type: "string" } },
          watch_heartbeat: { type: "boolean" },
          agent_id: { type: "string" },
          bearer_token: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    },
    {
      name: "get_subscription",
      description: "读取一条订阅。返回 webhook_auth，不含密钥。只能读自己的订阅；别人的订阅和没有 owner 的系统订阅都是 not found。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "list_subscriptions",
      description: "按 created_at、id 升序列出订阅。limit 默认 20，最大 100。返回 webhook_auth，不含密钥。账户 token 只列出自己的订阅，看不到别人的 webhook URL，也看不到没有 owner 的系统订阅。",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "update_subscription",
      description: "更新自己的订阅的 url、过滤器、status、心跳监视或 agent_id。不能改 mode，也不能改别人的或系统订阅。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string" },
          event_types: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["active", "paused"] },
          watch_heartbeat: { type: "boolean" },
          agent_id: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_subscription",
      description: "硬删除自己的订阅，并把未终态投递标成 dead，dead_reason 为 subscription_deleted。别人的订阅和系统订阅是 not found。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    {
      name: "rotate_subscription_secret",
      description:
        "轮换自己的 webhook 密钥。先看 webhook_auth：hmac 由服务端生成新 secret，只在这次响应里出现；bearer 必须传新的 bearer_token，且不回显。poll 订阅会拒绝。别人的订阅和系统订阅是 not found，不会换出新的 HMAC secret。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          bearer_token: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ];

  const handlers = {
    poll_events: pollEvents,
    ack_event: ackEvent,
    heartbeat,
    emit_event: emitEvent,
    create_subscription: createSubscription,
    get_subscription: getSubscription,
    list_subscriptions: listSubscriptions,
    update_subscription: updateSubscription,
    delete_subscription: deleteSubscription,
    rotate_subscription_secret: rotateSubscriptionSecret,
  };

  return {
    tools,
    handlers,
    emitCalendarDueForEvent,
    handleScheduled,
    handleQueue,
    consumeDelivery,
    consumeDeadDelivery,
    bindRuntime,
    DELIVER_QUEUE_NAME,
    DLQ_QUEUE_NAME,
  };
}
