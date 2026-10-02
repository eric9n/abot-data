/**
 * abot-data: personal structured data (contacts, calendar, notes).
 * POST /mcp   MCP (Streamable HTTP, JSON-RPC)
 *   Bearer DATA_MCP_TOKEN: legacy access to every row
 *   Bearer ad_…: one agent account, rows scoped by owner_email
 *   Bus poll for ad_ also returns system events (owner_email IS NULL)
 *   request_account_verification and verify_account: no Bearer
 * GET /ctc/{id}  GET /cal/{id}  GET /note/{id}   canonical JSON, same tokens
 * GET /health liveness, no personal data
 * GET  /oauth/authorize   authorization-code consent page (email code, optional PKCE S256)
 * POST /oauth/authorize   send or verify the email code, then 302
 * POST /oauth/token       exchange a one-time code for the ad_ token (secret and/or PKCE)
 * scheduled    detector and delivery repair (not a URL)
 * queue        abot-deliver / abot-deliver-dlq (not a URL)
 *
 * D1 binding is DB. This worker does not read the mail archive.
 */

import {
  buildWebhookBody,
  createPhase2,
  signWebhook,
  stableStringify,
  verifyWebhookRequest,
} from "./phase2.js";

export { buildWebhookBody, signWebhook, stableStringify, verifyWebhookRequest };

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 1_000_000;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_PREFIXES = new Set(["cal_", "ctc_", "note_", "evt_", "sub_", "dlv_"]);
const REPEAT_FREQ = new Set(["none", "daily", "weekly", "monthly"]);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const PUBLIC_ACCOUNT_TOOLS = new Set(["request_account_verification", "verify_account"]);
const CODE_TTL_MS = 15 * 60 * 1000;
const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_EMAIL_CODES = 3;
const MAX_IP_CODES = 10;
const MAX_CODE_ATTEMPTS = 5;
const CODE_SPACE = 1_000_000;
const CODE_REJECTION_LIMIT = Math.floor(0x1_0000_0000 / CODE_SPACE) * CODE_SPACE;
const ACCOUNT_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const CONTACT_FIELDS = "id, name, aliases, org, title, email, phone, relation, notes, source, created_by, created_at, updated_at";
const EVENT_FIELDS =
  "id, title, start_utc, end_utc, timezone, all_day, repeat, source, attendee_ids, reminder_minutes, location, notes, status, google_event_id, created_by, created_at, updated_at";
const NOTE_FIELDS = "id, title, body, tags, links, source, created_by, created_at, updated_at";

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "RpcError";
  }
}

/** Character-by-character compare. Always walks the longer string. */
export function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  const len = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < len; i++) {
    const ca = i < left.length ? left.charCodeAt(i) : 0;
    const cb = i < right.length ? right.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Unbiased 6-digit code. Bytes at or above the rejection limit are skipped. */
export function verificationCodeFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error("bad entropy");
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    const n = bytes[i] * 0x1000000 + bytes[i + 1] * 0x10000 + bytes[i + 2] * 0x100 + bytes[i + 3];
    if (n < CODE_REJECTION_LIMIT) return String(n % CODE_SPACE).padStart(6, "0");
  }
  throw new Error("not enough entropy");
}

export function newVerificationCode() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    try {
      return verificationCodeFromBytes(bytes);
    } catch (err) {
      if (!err || err.message !== "not enough entropy") throw err;
    }
  }
  throw new Error("code entropy exhausted");
}

/** ad_ plus 32 lowercase hex chars from the first 16 bytes. */
export function accountTokenFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) throw new Error("not enough entropy");
  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return `ad_${hex}`;
}

export function newAccountToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return accountTokenFromBytes(bytes);
}

export function normalizeAccountEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!ACCOUNT_EMAIL.test(email)) return null;
  return email;
}

export function likeContains(value) {
  const escaped = String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

/**
 * prefix + 12 chars from [a-z0-9]. Bytes >= 252 are skipped so `% 36` is unbiased.
 * Throws if the buffer does not contain 12 usable bytes.
 */
export function idFromBytes(prefix, bytes) {
  if (!ID_PREFIXES.has(prefix)) {
    throw new Error("bad id prefix");
  }
  let body = "";
  for (let i = 0; i < bytes.length && body.length < 12; i++) {
    const n = bytes[i];
    if (n >= 252) continue;
    body += ID_ALPHABET[n % 36];
  }
  if (body.length !== 12) throw new Error("not enough entropy");
  return prefix + body;
}

export function newId(prefix) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    try {
      return idFromBytes(prefix, bytes);
    } catch (err) {
      if (!err || err.message !== "not enough entropy") throw err;
    }
  }
  throw new Error("id entropy exhausted");
}

export function canonicalUtc(value, label) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    throw new RpcError(-32602, `${label} must be UTC ISO8601`);
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new RpcError(-32602, `${label} must be UTC ISO8601`);
  return new Date(t).toISOString();
}

export function assertTimeOrder(startUtc, endUtc) {
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  if (!(end > start)) throw new RpcError(-32602, "end_utc must be after start_utc");
}

/** Object or JSON text. freq must be none, daily, weekly, or monthly. */
export function normalizeRepeat(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new RpcError(-32602, "repeat must be valid JSON");
    }
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RpcError(-32602, "repeat must be a JSON object");
  }
  if (typeof parsed.freq !== "string" || !REPEAT_FREQ.has(parsed.freq)) {
    throw new RpcError(-32602, "repeat.freq must be none, daily, weekly, or monthly");
  }
  return JSON.stringify(parsed);
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function assertOnlyKeys(obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new RpcError(-32602, `unexpected argument: ${key}`);
  }
}

function requireArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new RpcError(-32602, "arguments must be an object");
  }
}

function clampLimit(limit, fallback, max) {
  if (limit == null) return fallback;
  if (!Number.isInteger(limit)) throw new RpcError(-32602, "limit must be an integer");
  if (limit < 1) throw new RpcError(-32602, "limit must be >= 1");
  return Math.min(limit, max);
}

function requireId(value, prefix) {
  if (typeof value !== "string" || !new RegExp(`^${prefix}[a-z0-9]{12}$`).test(value)) {
    throw new RpcError(-32602, "id is required");
  }
  return value;
}

function notFound() {
  return new RpcError(-32602, "not found");
}

function optionalQuery(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new RpcError(-32602, "query must be a string");
  if (value.length > 200) throw new RpcError(-32602, "query is too long");
  return value;
}

function optionalTag(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new RpcError(-32602, "tag must be a string");
  if (value.length > 100) throw new RpcError(-32602, "tag is too long");
  return value;
}

function optionalStatus(value) {
  if (value == null || value === "") return null;
  if (value !== "confirmed" && value !== "cancelled") {
    throw new RpcError(-32602, "status must be confirmed or cancelled");
  }
  return value;
}

function readText(value, key, { required, allowEmpty, max, nullable }) {
  if (value == null) {
    if (required) throw new RpcError(-32602, `${key} is required`);
    if (nullable) return null;
    throw new RpcError(-32602, `${key} must be a string`);
  }
  if (typeof value !== "string") throw new RpcError(-32602, `${key} must be a string`);
  if (!allowEmpty && value.trim() === "") throw new RpcError(-32602, `${key} is required`);
  if (value.length > max) throw new RpcError(-32602, `${key} is too long`);
  return value;
}

function takeText(args, key, opts) {
  if (!has(args, key)) {
    if (opts.required) throw new RpcError(-32602, `${key} is required`);
    return undefined;
  }
  return readText(args[key], key, opts);
}

function readStringArray(value, key, itemMax) {
  if (!Array.isArray(value)) throw new RpcError(-32602, `${key} must be an array`);
  if (value.length > 100) throw new RpcError(-32602, `${key} is too long`);
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") throw new RpcError(-32602, `${key} must be an array of strings`);
    if (item.length > itemMax) throw new RpcError(-32602, `${key} item is too long`);
    out.push(item);
  }
  return JSON.stringify(out);
}

function takeStringArray(args, key, itemMax) {
  if (!has(args, key)) return undefined;
  return readStringArray(args[key], key, itemMax);
}

function readMinutes(value) {
  if (!Array.isArray(value)) throw new RpcError(-32602, "reminder_minutes must be an array");
  if (value.length > 50) throw new RpcError(-32602, "reminder_minutes is too long");
  const out = [];
  for (const item of value) {
    if (!Number.isInteger(item) || item < 0 || item > 525600) {
      throw new RpcError(-32602, "reminder_minutes must be non-negative integers");
    }
    out.push(item);
  }
  return JSON.stringify(out);
}

function takeMinutes(args) {
  if (!has(args, "reminder_minutes")) return undefined;
  return readMinutes(args.reminder_minutes);
}

function readCreatedBy(value) {
  if (value == null) return "human";
  if (value !== "human" && value !== "bot:main") {
    throw new RpcError(-32602, "created_by must be human or bot:main");
  }
  return value;
}

function takeCreatedBy(args) {
  if (!has(args, "created_by")) return "human";
  return readCreatedBy(args.created_by);
}

function readTimezone(value) {
  if (value == null) return "Asia/Shanghai";
  if (typeof value !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) {
    throw new RpcError(-32602, "timezone must be a string");
  }
  return value;
}

function takeTimezone(args) {
  if (!has(args, "timezone")) return undefined;
  return readTimezone(args.timezone);
}

function readAllDay(value) {
  if (value == null) return 0;
  if (typeof value !== "boolean") throw new RpcError(-32602, "all_day must be a boolean");
  return value ? 1 : 0;
}

function takeAllDay(args) {
  if (!has(args, "all_day")) return undefined;
  return readAllDay(args.all_day);
}

function takeRepeat(args) {
  if (!has(args, "repeat")) return undefined;
  if (args.repeat == null) throw new RpcError(-32602, "repeat must be valid JSON");
  return normalizeRepeat(args.repeat);
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function nowIso(deps) {
  return new Date(nowMsOf(deps)).toISOString();
}

function nowMsOf(deps) {
  return deps && typeof deps.nowMs === "number" && Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
}

/** Per-agent token scopes rows. Legacy and unscoped callers see every row. */
function scopedOwner(deps) {
  if (!deps || typeof deps.ownerEmail !== "string" || deps.ownerEmail === "") return null;
  return deps.ownerEmail;
}

function ownerSql(owner, params) {
  if (owner == null) return "";
  params.push(owner);
  return " AND owner_email = ?";
}

const RESOURCE_KIND = { ctc_: "ctc", cal_: "cal", note_: "note" };

/** Absolute canonical URL for a record. Origin is the request origin, not stored. */
export function canonicalUrl(origin, id) {
  const prefix = typeof id === "string" ? id.slice(0, id.indexOf("_") + 1) : "";
  const kind = RESOURCE_KIND[prefix];
  if (!kind) throw new Error("bad id");
  const path = `/${kind}/${id}`;
  if (typeof origin !== "string" || origin === "") return path;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

function contactView(row, origin) {
  return {
    id: row.id,
    url: canonicalUrl(origin, row.id),
    name: row.name,
    aliases: parseJson(row.aliases, []),
    org: row.org ?? null,
    title: row.title ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    relation: row.relation ?? null,
    notes: row.notes ?? null,
    source: row.source,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function eventView(row, origin) {
  return {
    id: row.id,
    url: canonicalUrl(origin, row.id),
    title: row.title,
    start_utc: row.start_utc,
    end_utc: row.end_utc,
    timezone: row.timezone,
    all_day: row.all_day === 1 || row.all_day === true,
    repeat: parseJson(row.repeat, { freq: "none" }),
    source: row.source,
    attendee_ids: parseJson(row.attendee_ids, []),
    reminder_minutes: parseJson(row.reminder_minutes, []),
    location: row.location ?? null,
    notes: row.notes ?? null,
    status: row.status,
    google_event_id: row.google_event_id ?? null,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function noteView(row, origin) {
  return {
    id: row.id,
    url: canonicalUrl(origin, row.id),
    title: row.title,
    body: row.body,
    tags: parseJson(row.tags, []),
    links: parseJson(row.links, []),
    source: row.source,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function queryAll(deps, sql, params) {
  if (!deps || typeof deps.queryAll !== "function") throw new Error("queryAll is not configured");
  const rows = await deps.queryAll(sql, params);
  return Array.isArray(rows) ? rows : [];
}

async function queryFirst(deps, sql, params) {
  if (!deps || typeof deps.queryFirst !== "function") throw new Error("queryFirst is not configured");
  const row = await deps.queryFirst(sql, params);
  return row ?? null;
}

async function queryRun(deps, sql, params) {
  if (!deps || typeof deps.queryRun !== "function") throw new Error("queryRun is not configured");
  return deps.queryRun(sql, params);
}

function isUniqueError(err) {
  return /unique/i.test(String(err && err.message));
}

async function insertWithId(deps, prefix, sql, paramsAfterId) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId(prefix);
    try {
      await queryRun(deps, sql, [id, ...paramsAfterId]);
      return id;
    } catch (err) {
      lastErr = err;
      if (!isUniqueError(err)) throw err;
    }
  }
  throw lastErr;
}

function assign(sets, params, column, value) {
  if (value === undefined) return;
  sets.push(`${column} = ?`);
  params.push(value);
}

async function createContact(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["name", "aliases", "org", "title", "email", "phone", "relation", "notes", "created_by"]));
  const name = readText(args.name, "name", { required: true, allowEmpty: false, max: 200 });
  const aliases = takeStringArray(args, "aliases", 200) ?? "[]";
  const org = takeText(args, "org", { nullable: true, allowEmpty: true, max: 200 });
  const title = takeText(args, "title", { nullable: true, allowEmpty: true, max: 200 });
  const email = takeText(args, "email", { nullable: true, allowEmpty: true, max: 200 });
  const phone = takeText(args, "phone", { nullable: true, allowEmpty: true, max: 200 });
  const relation = takeText(args, "relation", { nullable: true, allowEmpty: true, max: 200 });
  const notes = takeText(args, "notes", { nullable: true, allowEmpty: true, max: 20000 });
  const createdBy = takeCreatedBy(args);
  const now = nowIso(deps);
  const owner = scopedOwner(deps);
  const id = await insertWithId(
    deps,
    "ctc_",
    `INSERT INTO contacts (
      id, name, aliases, org, title, email, phone, relation, notes, source, created_by, created_at, updated_at, owner_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
    [name, aliases, org ?? null, title ?? null, email ?? null, phone ?? null, relation ?? null, notes ?? null, createdBy, now, now, owner],
  );
  return { id, url: canonicalUrl(deps && deps.origin, id) };
}

async function getContact(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "ctc_");
  const params = [id];
  const row = await queryFirst(
    deps,
    `SELECT ${CONTACT_FIELDS} FROM contacts WHERE id = ?${ownerSql(scopedOwner(deps), params)}`,
    params,
  );
  if (!row) return { found: false, id };
  return { found: true, ...contactView(row, deps.origin) };
}

async function listContacts(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["query", "limit"]));
  const limit = clampLimit(args.limit, 20, 100);
  const query = optionalQuery(args.query);
  const filters = [];
  const params = [];
  const owner = scopedOwner(deps);
  if (owner != null) {
    filters.push("owner_email = ?");
    params.push(owner);
  }
  if (query != null) {
    const pattern = likeContains(query);
    filters.push("(name LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR IFNULL(org, '') LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern, pattern);
  }
  const where = filters.length ? `WHERE ${filters.join("\n  AND ")}\n` : "";
  params.push(limit);
  const rows = await queryAll(
    deps,
    `SELECT ${CONTACT_FIELDS}
FROM contacts
${where}ORDER BY updated_at DESC, id ASC
LIMIT ?`,
    params,
  );
  return rows.map((row) => contactView(row, deps.origin));
}

async function updateContact(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id", "name", "aliases", "org", "title", "email", "phone", "relation", "notes"]));
  const id = requireId(args.id, "ctc_");
  const sets = [];
  const params = [];
  assign(sets, params, "name", takeText(args, "name", { allowEmpty: false, max: 200 }));
  assign(sets, params, "aliases", takeStringArray(args, "aliases", 200));
  assign(sets, params, "org", takeText(args, "org", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "title", takeText(args, "title", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "email", takeText(args, "email", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "phone", takeText(args, "phone", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "relation", takeText(args, "relation", { nullable: true, allowEmpty: true, max: 200 }));
  assign(sets, params, "notes", takeText(args, "notes", { nullable: true, allowEmpty: true, max: 20000 }));
  if (sets.length === 0) throw new RpcError(-32602, "no fields to update");
  const ownerParams = [id];
  const ownerFilter = ownerSql(scopedOwner(deps), ownerParams);
  const existing = await queryFirst(deps, `SELECT id FROM contacts WHERE id = ?${ownerFilter}`, ownerParams);
  if (!existing) throw notFound();
  const now = nowIso(deps);
  sets.push("updated_at = ?");
  params.push(now, id);
  if (ownerParams.length > 1) params.push(ownerParams[1]);
  await queryRun(deps, `UPDATE contacts SET ${sets.join(", ")} WHERE id = ?${ownerFilter}`, params);
  const row = await queryFirst(deps, `SELECT ${CONTACT_FIELDS} FROM contacts WHERE id = ?${ownerFilter}`, ownerParams);
  return { found: true, ...contactView(row, deps.origin) };
}

async function deleteContact(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "ctc_");
  const params = [id];
  const filter = ownerSql(scopedOwner(deps), params);
  const existing = await queryFirst(deps, `SELECT id FROM contacts WHERE id = ?${filter}`, params);
  if (!existing) throw notFound();
  await queryRun(deps, `DELETE FROM contacts WHERE id = ?${filter}`, params);
  return { id, deleted: true };
}

async function createEvent(args, deps) {
  requireArgs(args);
  assertOnlyKeys(
    args,
    new Set([
      "title",
      "start_utc",
      "end_utc",
      "timezone",
      "all_day",
      "repeat",
      "attendee_ids",
      "reminder_minutes",
      "location",
      "notes",
      "created_by",
    ]),
  );
  const title = readText(args.title, "title", { required: true, allowEmpty: false, max: 500 });
  const start = canonicalUtc(args.start_utc, "start_utc");
  const end = canonicalUtc(args.end_utc, "end_utc");
  assertTimeOrder(start, end);
  const timezone = has(args, "timezone") ? readTimezone(args.timezone) : "Asia/Shanghai";
  const allDay = has(args, "all_day") ? readAllDay(args.all_day) : 0;
  const repeat = has(args, "repeat") ? takeRepeat(args) : '{"freq":"none"}';
  const attendees = takeStringArray(args, "attendee_ids", 64) ?? "[]";
  const reminders = takeMinutes(args) ?? "[]";
  const location = takeText(args, "location", { nullable: true, allowEmpty: true, max: 500 });
  const notes = takeText(args, "notes", { nullable: true, allowEmpty: true, max: 20000 });
  const createdBy = takeCreatedBy(args);
  const now = nowIso(deps);
  const owner = scopedOwner(deps);
  const id = await insertWithId(
    deps,
    "cal_",
    `INSERT INTO calendar_events (
      id, title, start_utc, end_utc, timezone, all_day, repeat, source,
      attendee_ids, reminder_minutes, location, notes, status, created_by, created_at, updated_at, owner_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'bot', ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`,
    [title, start, end, timezone, allDay, repeat, attendees, reminders, location ?? null, notes ?? null, createdBy, now, now, owner],
  );
  return { id, url: canonicalUrl(deps && deps.origin, id) };
}

async function getEvent(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "cal_");
  const params = [id];
  const row = await queryFirst(
    deps,
    `SELECT ${EVENT_FIELDS} FROM calendar_events WHERE id = ?${ownerSql(scopedOwner(deps), params)}`,
    params,
  );
  if (!row) return { found: false, id };
  return { found: true, ...eventView(row, deps.origin) };
}

async function listEvents(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["start_utc", "end_utc", "status", "limit"]));
  const start = canonicalUtc(args.start_utc, "start_utc");
  const end = canonicalUtc(args.end_utc, "end_utc");
  assertTimeOrder(start, end);
  const status = optionalStatus(args.status);
  const limit = clampLimit(args.limit, 100, 500);
  const where = ["start_utc < ?", "end_utc > ?"];
  const params = [end, start];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  const owner = scopedOwner(deps);
  if (owner != null) {
    where.push("owner_email = ?");
    params.push(owner);
  }
  params.push(limit);
  const rows = await queryAll(
    deps,
    `SELECT ${EVENT_FIELDS}
FROM calendar_events
WHERE ${where.join("\n  AND ")}
ORDER BY start_utc ASC, id ASC
LIMIT ?`,
    params,
  );
  return rows.map((row) => eventView(row, deps.origin));
}

async function updateEvent(args, deps) {
  requireArgs(args);
  assertOnlyKeys(
    args,
    new Set([
      "id",
      "title",
      "start_utc",
      "end_utc",
      "timezone",
      "all_day",
      "repeat",
      "attendee_ids",
      "reminder_minutes",
      "location",
      "notes",
      "status",
    ]),
  );
  const id = requireId(args.id, "cal_");
  const title = takeText(args, "title", { allowEmpty: false, max: 500 });
  const start = has(args, "start_utc") ? canonicalUtc(args.start_utc, "start_utc") : undefined;
  const end = has(args, "end_utc") ? canonicalUtc(args.end_utc, "end_utc") : undefined;
  const timezone = takeTimezone(args);
  const allDay = takeAllDay(args);
  const repeat = takeRepeat(args);
  const attendees = takeStringArray(args, "attendee_ids", 64);
  const reminders = takeMinutes(args);
  const location = takeText(args, "location", { nullable: true, allowEmpty: true, max: 500 });
  const notes = takeText(args, "notes", { nullable: true, allowEmpty: true, max: 20000 });
  const status = has(args, "status") ? optionalStatus(args.status) : undefined;
  if (has(args, "status") && status == null) throw new RpcError(-32602, "status must be confirmed or cancelled");
  const sets = [];
  const params = [];
  assign(sets, params, "title", title);
  assign(sets, params, "start_utc", start);
  assign(sets, params, "end_utc", end);
  assign(sets, params, "timezone", timezone);
  assign(sets, params, "all_day", allDay);
  assign(sets, params, "repeat", repeat);
  assign(sets, params, "attendee_ids", attendees);
  assign(sets, params, "reminder_minutes", reminders);
  assign(sets, params, "location", location);
  assign(sets, params, "notes", notes);
  assign(sets, params, "status", status);
  if (sets.length === 0) throw new RpcError(-32602, "no fields to update");
  const ownerParams = [id];
  const filter = ownerSql(scopedOwner(deps), ownerParams);
  const existing = await queryFirst(deps, `SELECT ${EVENT_FIELDS} FROM calendar_events WHERE id = ?${filter}`, ownerParams);
  if (!existing) throw notFound();
  assertTimeOrder(start ?? existing.start_utc, end ?? existing.end_utc);
  const now = nowIso(deps);
  sets.push("updated_at = ?");
  params.push(now, ...ownerParams);
  await queryRun(deps, `UPDATE calendar_events SET ${sets.join(", ")} WHERE id = ?${filter}`, params);
  const row = await queryFirst(deps, `SELECT ${EVENT_FIELDS} FROM calendar_events WHERE id = ?${filter}`, ownerParams);
  return { found: true, ...eventView(row, deps.origin) };
}

async function deleteEvent(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "cal_");
  const params = [id];
  const filter = ownerSql(scopedOwner(deps), params);
  const existing = await queryFirst(deps, `SELECT id FROM calendar_events WHERE id = ?${filter}`, params);
  if (!existing) throw notFound();
  const now = nowIso(deps);
  await queryRun(deps, `UPDATE calendar_events SET status = 'cancelled', updated_at = ? WHERE id = ?${filter}`, [now, ...params]);
  return { id, status: "cancelled" };
}

async function createNote(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["title", "body", "tags", "links", "created_by"]));
  const title = takeText(args, "title", { allowEmpty: true, max: 500 }) ?? "";
  const body = takeText(args, "body", { allowEmpty: true, max: 100000 }) ?? "";
  const tags = takeStringArray(args, "tags", 100) ?? "[]";
  const links = takeStringArray(args, "links", 500) ?? "[]";
  const createdBy = takeCreatedBy(args);
  const now = nowIso(deps);
  const owner = scopedOwner(deps);
  const id = await insertWithId(
    deps,
    "note_",
    `INSERT INTO notes (
      id, title, body, tags, links, source, created_by, created_at, updated_at, owner_email
    ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
    [title, body, tags, links, createdBy, now, now, owner],
  );
  return { id, url: canonicalUrl(deps && deps.origin, id) };
}

async function getNote(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "note_");
  const params = [id];
  const row = await queryFirst(
    deps,
    `SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?${ownerSql(scopedOwner(deps), params)}`,
    params,
  );
  if (!row) return { found: false, id };
  return { found: true, ...noteView(row, deps.origin) };
}

async function listNotes(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["query", "tag", "limit"]));
  const limit = clampLimit(args.limit, 20, 100);
  const query = optionalQuery(args.query);
  const tag = optionalTag(args.tag);
  const where = [];
  const params = [];
  const owner = scopedOwner(deps);
  if (owner != null) {
    where.push("owner_email = ?");
    params.push(owner);
  }
  if (query != null) {
    const pattern = likeContains(query);
    where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (tag != null) {
    where.push("EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE json_each.value = ?)");
    params.push(tag);
  }
  params.push(limit);
  const whereSql = where.length ? `WHERE ${where.join("\n  AND ")}\n` : "";
  const rows = await queryAll(
    deps,
    `SELECT ${NOTE_FIELDS}
FROM notes
${whereSql}ORDER BY updated_at DESC, id ASC
LIMIT ?`,
    params,
  );
  return rows.map((row) => noteView(row, deps.origin));
}

async function updateNote(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id", "title", "body", "tags", "links"]));
  const id = requireId(args.id, "note_");
  const sets = [];
  const params = [];
  assign(sets, params, "title", takeText(args, "title", { allowEmpty: true, max: 500 }));
  assign(sets, params, "body", takeText(args, "body", { allowEmpty: true, max: 100000 }));
  assign(sets, params, "tags", takeStringArray(args, "tags", 100));
  assign(sets, params, "links", takeStringArray(args, "links", 500));
  if (sets.length === 0) throw new RpcError(-32602, "no fields to update");
  const ownerParams = [id];
  const filter = ownerSql(scopedOwner(deps), ownerParams);
  const existing = await queryFirst(deps, `SELECT id FROM notes WHERE id = ?${filter}`, ownerParams);
  if (!existing) throw notFound();
  const now = nowIso(deps);
  sets.push("updated_at = ?");
  params.push(now, ...ownerParams);
  await queryRun(deps, `UPDATE notes SET ${sets.join(", ")} WHERE id = ?${filter}`, params);
  const row = await queryFirst(deps, `SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?${filter}`, ownerParams);
  return { found: true, ...noteView(row, deps.origin) };
}

async function deleteNote(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["id"]));
  const id = requireId(args.id, "note_");
  const params = [id];
  const filter = ownerSql(scopedOwner(deps), params);
  const existing = await queryFirst(deps, `SELECT id FROM notes WHERE id = ?${filter}`, params);
  if (!existing) throw notFound();
  await queryRun(deps, `DELETE FROM notes WHERE id = ?${filter}`, params);
  return { id, deleted: true };
}

function countValue(row) {
  const n = row && row.n;
  const value = typeof n === "number" ? n : Number(n);
  return Number.isFinite(value) ? value : 0;
}

function rateLimitIp(deps) {
  const ip = deps && typeof deps.clientIp === "string" ? deps.clientIp.trim() : "";
  if (!ip) return "unknown";
  return ip.slice(0, 128);
}

function randomRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function requireAccountEmail(args) {
  if (!has(args, "email")) throw new RpcError(-32602, "email is required");
  const email = normalizeAccountEmail(args.email);
  if (!email) throw new RpcError(-32602, "email is invalid");
  return email;
}

async function assertVerificationRate(deps, email, ip, nowMs) {
  const since = new Date(nowMs - RATE_WINDOW_MS).toISOString();
  await queryRun(deps, "DELETE FROM verification_requests WHERE requested_at <= ?", [since]);
  const emailRow = await queryFirst(
    deps,
    "SELECT COUNT(*) AS n FROM verification_requests WHERE email = ? AND requested_at > ?",
    [email, since],
  );
  const ipRow = await queryFirst(
    deps,
    "SELECT COUNT(*) AS n FROM verification_requests WHERE ip = ? AND requested_at > ?",
    [ip, since],
  );
  if (countValue(emailRow) >= MAX_EMAIL_CODES || countValue(ipRow) >= MAX_IP_CODES) {
    throw new RpcError(-32602, "too many verification requests");
  }
}

async function rollbackVerification(deps, email, previous, requestId) {
  try {
    if (previous) {
      await queryRun(
        deps,
        `UPDATE verification_codes
         SET code_hash = ?, expires_at = ?, attempts = ?, requested_at = ?
         WHERE email = ?`,
        [previous.code_hash, previous.expires_at, previous.attempts, previous.requested_at, email],
      );
    } else {
      await queryRun(deps, "DELETE FROM verification_codes WHERE email = ?", [email]);
    }
    await queryRun(deps, "DELETE FROM verification_requests WHERE id = ?", [requestId]);
  } catch {
    // The caller still returns a generic send failure.
  }
}

async function sendVerificationEmail(deps, email, code) {
  const apiKey = deps && deps.env && deps.env.RESEND_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new RpcError(-32603, "could not send verification email");
  }
  const doFetch = deps && typeof deps.fetch === "function" ? deps.fetch : fetch;
  let response;
  try {
    response = await doFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        from: "abot-data@abot.run",
        to: [email],
        subject: `abot-data 验证码 ${code}`,
        text: `你的 abot-data 验证码是 ${code}。验证码 15 分钟内有效。如果不是你本人操作，可以忽略这封邮件。`,
      }),
    });
  } catch {
    throw new RpcError(-32603, "could not send verification email");
  }
  if (!response || response.ok !== true) {
    throw new RpcError(-32603, "could not send verification email");
  }
}

async function requestAccountVerification(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["email"]));
  const email = requireAccountEmail(args);
  const nowMs = nowMsOf(deps);
  const ip = rateLimitIp(deps);
  await assertVerificationRate(deps, email, ip, nowMs);
  const previous = await queryFirst(
    deps,
    "SELECT code_hash, expires_at, attempts, requested_at FROM verification_codes WHERE email = ?",
    [email],
  );
  const code = newVerificationCode();
  const codeHash = await sha256Hex(code);
  const requestedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + CODE_TTL_MS).toISOString();
  await queryRun(
    deps,
    `INSERT INTO verification_codes (email, code_hash, expires_at, attempts, requested_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET
       code_hash = excluded.code_hash,
       expires_at = excluded.expires_at,
       attempts = 0,
       requested_at = excluded.requested_at`,
    [email, codeHash, expiresAt, requestedAt],
  );
  const requestId = randomRequestId();
  await queryRun(
    deps,
    "INSERT INTO verification_requests (id, email, ip, requested_at) VALUES (?, ?, ?, ?)",
    [requestId, email, ip, requestedAt],
  );
  try {
    await sendVerificationEmail(deps, email, code);
  } catch (err) {
    await rollbackVerification(deps, email, previous, requestId);
    console.error(JSON.stringify({ msg: "verification email failed" }));
    if (err instanceof RpcError) throw err;
    throw new RpcError(-32603, "could not send verification email");
  }
  return { ok: true };
}

async function bumpCodeAttempts(deps, email) {
  await queryRun(deps, "UPDATE verification_codes SET attempts = attempts + 1 WHERE email = ?", [email]);
}

/** Shared by verify_account and the OAuth consent page. Does not issue a token. */
async function assertVerificationCode(deps, email, code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new RpcError(-32602, "code must be a 6-digit string");
  }
  const row = await queryFirst(
    deps,
    "SELECT code_hash, expires_at, attempts FROM verification_codes WHERE email = ?",
    [email],
  );
  if (!row) throw new RpcError(-32602, "invalid verification code");
  if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) {
    await bumpCodeAttempts(deps, email);
    throw new RpcError(-32602, "too many attempts");
  }
  const expiresMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresMs) || nowMsOf(deps) >= expiresMs) {
    throw new RpcError(-32602, "verification code expired");
  }
  const actual = await sha256Hex(code);
  if (typeof row.code_hash !== "string" || !timingSafeEqual(actual, row.code_hash)) {
    await bumpCodeAttempts(deps, email);
    throw new RpcError(-32602, "invalid verification code");
  }
}

async function issueAccountToken(deps, email) {
  const token = newAccountToken();
  const tokenHash = await sha256Hex(token);
  const now = nowIso(deps);
  await queryRun(
    deps,
    `INSERT INTO accounts (email, token_hash, created_at, verified_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       token_hash = excluded.token_hash,
       verified_at = excluded.verified_at`,
    [email, tokenHash, now, now],
  );
  return token;
}

async function verifyAccount(args, deps) {
  requireArgs(args);
  assertOnlyKeys(args, new Set(["email", "code"]));
  const email = requireAccountEmail(args);
  if (!has(args, "code")) throw new RpcError(-32602, "code is required");
  await assertVerificationCode(deps, email, args.code);
  const token = await issueAccountToken(deps, email);
  await queryRun(deps, "DELETE FROM verification_codes WHERE email = ?", [email]);
  return { ok: true, token };
}

const phase2 = createPhase2({
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
});

export const TOOLS = [
  {
    name: "create_contact",
    description: "新建联系人。name 必填。aliases 为字符串数组。返回 {id, url}，id 前缀 ctc_，url 是 canonical URL。created_by 可选：human 或 bot:main。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        org: { type: "string" },
        title: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        relation: { type: "string" },
        notes: { type: "string" },
        created_by: { type: "string", enum: ["human", "bot:main"] },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "get_contact",
    description: "按 id 读取一个联系人。命中时带 url。不存在时 found 为 false。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_contacts",
    description: "列出联系人。query 对 name、aliases、org 做 LIKE。limit 默认 20，最大 100。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_contact",
    description: "按 id 更新联系人字段。只改传入的字段。aliases 会整组替换。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        org: { type: "string" },
        title: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        relation: { type: "string" },
        notes: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_contact",
    description: "硬删除一个联系人。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_event",
    description:
      "新建日历事件。start_utc / end_utc 为 UTC ISO8601，end 必须晚于 start。repeat.freq 为 none、daily、weekly 或 monthly。返回 {id, url}，id 前缀 cal_。不检查 attendee_ids 是否已有联系人。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start_utc: { type: "string" },
        end_utc: { type: "string" },
        timezone: { type: "string", default: "Asia/Shanghai" },
        all_day: { type: "boolean", default: false },
        repeat: { type: "object" },
        attendee_ids: { type: "array", items: { type: "string" } },
        reminder_minutes: { type: "array", items: { type: "integer" } },
        location: { type: "string" },
        notes: { type: "string" },
        created_by: { type: "string", enum: ["human", "bot:main"] },
      },
      required: ["title", "start_utc", "end_utc"],
      additionalProperties: false,
    },
  },
  {
    name: "get_event",
    description: "按 id 读取一个事件，包括已取消的事件。命中时带 url。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_events",
    description:
      "列出与 [start_utc, end_utc) 重叠的事件（start_utc < 窗口结束且 end_utc > 窗口开始）。status 可选 confirmed 或 cancelled；省略则两者都返回。",
    inputSchema: {
      type: "object",
      properties: {
        start_utc: { type: "string" },
        end_utc: { type: "string" },
        status: { type: "string", enum: ["confirmed", "cancelled"] },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      required: ["start_utc", "end_utc"],
      additionalProperties: false,
    },
  },
  {
    name: "update_event",
    description: "按 id 更新事件。改时间时仍要求结束晚于开始。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        start_utc: { type: "string" },
        end_utc: { type: "string" },
        timezone: { type: "string" },
        all_day: { type: "boolean" },
        repeat: { type: "object" },
        attendee_ids: { type: "array", items: { type: "string" } },
        reminder_minutes: { type: "array", items: { type: "integer" } },
        location: { type: "string" },
        notes: { type: "string" },
        status: { type: "string", enum: ["confirmed", "cancelled"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_event",
    description: "将事件 status 标为 cancelled，保留历史，不物理删除。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "create_note",
    description: "新建笔记。title、body、tags、links 都可选。返回 {id, url}，id 前缀 note_。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        links: { type: "array", items: { type: "string" } },
        created_by: { type: "string", enum: ["human", "bot:main"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_note",
    description: "按 id 读取一条笔记。命中时带 url。不存在时 found 为 false。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_notes",
    description: "列出笔记。query 对 title 和 body 做 LIKE。tag 精确匹配 tags 数组里的一项。limit 默认 20，最大 100。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tag: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_note",
    description: "按 id 更新笔记。tags 和 links 会整组替换。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        links: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_note",
    description: "硬删除一条笔记。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  ...phase2.tools,
  {
    name: "request_account_verification",
    description:
      "为邮箱申请 agent 账户验证码。无需 Bearer。同一邮箱 60 分钟最多 3 次，同一 IP 60 分钟最多 10 次。验证码 15 分钟有效，通过邮件发送。返回 {ok:true}，不包含验证码。已注册邮箱可以再次申请以轮换 token。",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_account",
    description:
      "提交邮箱验证码。成功返回 {ok:true, token}。token 形如 ad_ 加 32 位十六进制，只出现这一次。已有账户会轮换 token，旧 token 立即失效。验证码错误会计入尝试次数，达到 5 次后拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string" },
        code: { type: "string" },
      },
      required: ["email", "code"],
      additionalProperties: false,
    },
  },
];

function toolText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function callTool(name, args, deps) {
  if (deps && deps.authKind === "public" && !PUBLIC_ACCOUNT_TOOLS.has(name)) {
    throw new RpcError(-32601, `unknown tool: ${name}`);
  }
  switch (name) {
    case "create_contact":
      return createContact(args, deps);
    case "get_contact":
      return getContact(args, deps);
    case "list_contacts":
      return listContacts(args, deps);
    case "update_contact":
      return updateContact(args, deps);
    case "delete_contact":
      return deleteContact(args, deps);
    case "create_event":
      return createEvent(args, deps);
    case "get_event":
      return getEvent(args, deps);
    case "list_events":
      return listEvents(args, deps);
    case "update_event":
      return updateEvent(args, deps);
    case "delete_event":
      return deleteEvent(args, deps);
    case "create_note":
      return createNote(args, deps);
    case "get_note":
      return getNote(args, deps);
    case "list_notes":
      return listNotes(args, deps);
    case "update_note":
      return updateNote(args, deps);
    case "delete_note":
      return deleteNote(args, deps);
    case "request_account_verification":
      return requestAccountVerification(args, deps);
    case "verify_account":
      return verifyAccount(args, deps);
    default: {
      const handler = phase2.handlers[name];
      if (handler) return handler(args, deps);
      throw new RpcError(-32601, `unknown tool: ${name}`);
    }
  }
}

export async function handleMcpRpc(message, deps) {
  try {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { type: "error", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
      return { type: "error", id, error: { code: -32600, message: "Invalid Request" } };
    }
    if (message.method.startsWith("notifications/")) {
      return { type: "notification" };
    }
    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      return { type: "error", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const id = message.id;
    if (message.method === "initialize") {
      return {
        type: "result",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "abot-data-mcp", version: "1.0.0" },
        },
      };
    }
    if (message.method === "tools/list") {
      return { type: "result", id, result: { tools: TOOLS } };
    }
    if (message.method === "tools/call") {
      const params = message.params;
      if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.name !== "string") {
        throw new RpcError(-32602, "tools/call requires params.name");
      }
      const args = params.arguments == null ? {} : params.arguments;
      if (typeof args !== "object" || Array.isArray(args)) throw new RpcError(-32602, "arguments must be an object");
      const known = TOOLS.some((tool) => tool.name === params.name);
      if (!known) throw new RpcError(-32601, `unknown tool: ${params.name}`);
      const value = await callTool(params.name, args, deps);
      return { type: "result", id, result: toolText(value) };
    }
    return { type: "error", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  } catch (err) {
    const id = message && typeof message === "object" && Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
    if (err instanceof RpcError) {
      return { type: "error", id, error: { code: err.code, message: err.message } };
    }
    console.error(JSON.stringify({ msg: "mcp failed", error: err && err.message }));
    return { type: "error", id, error: { code: -32603, message: "internal error" } };
  }
}

function bindStmt(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params && params.length) return stmt.bind(...params);
  return stmt;
}

function d1Deps(env) {
  const source = env && env.DB;
  return {
    async queryAll(sql, params) {
      const out = await bindStmt(source, sql, params).all();
      return out.results || [];
    },
    async queryFirst(sql, params) {
      const row = await bindStmt(source, sql, params).first();
      return row ?? null;
    },
    async queryRun(sql, params) {
      return bindStmt(source, sql, params).run();
    },
    async batch(statements) {
      if (!source || typeof source.batch !== "function") throw new Error("batch is not configured");
      const prepared = statements.map((statement) => {
        const stmt = source.prepare(statement.sql);
        return statement.params && statement.params.length ? stmt.bind(...statement.params) : stmt;
      });
      const out = await source.batch(prepared);
      return Array.isArray(out) ? out : [];
    },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function pathOf(request) {
  const url = new URL(request.url);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) return url.pathname.slice(0, -1);
  return url.pathname;
}

function bearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer (.+)$/i.exec(header);
  return match ? match[1] : null;
}

function bearerOk(header, token) {
  if (typeof token !== "string" || token.length === 0) return false;
  const presented = bearerToken(header);
  if (presented == null) return false;
  return timingSafeEqual(presented, token);
}

function clientIp(request, deps) {
  if (deps && typeof deps.clientIp === "string" && deps.clientIp.trim() !== "") {
    return deps.clientIp.trim().slice(0, 128);
  }
  const cf = request.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim().slice(0, 128);
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first.slice(0, 128);
  }
  return "unknown";
}

function isPublicAccountCall(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  if (message.method !== "tools/call") return false;
  const params = message.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  return PUBLIC_ACCOUNT_TOOLS.has(params.name);
}

async function readPublicAccountCall(request) {
  if (!jsonContentType(request.headers.get("content-type"))) return null;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) return null;
  try {
    const message = JSON.parse(new TextDecoder("utf-8").decode(raw));
    if (!isPublicAccountCall(message)) return null;
    return message;
  } catch {
    return null;
  }
}

async function accountEmailForToken(env, token) {
  const hash = await sha256Hex(token);
  const row = await d1Deps(env).queryFirst("SELECT email FROM accounts WHERE token_hash = ?", [hash]);
  return row && typeof row.email === "string" ? row.email : null;
}

async function resolveBearer(request, env) {
  const header = request.headers.get("authorization");
  if (bearerOk(header, env && env.DATA_MCP_TOKEN)) return { kind: "legacy" };
  const presented = bearerToken(header);
  if (typeof presented === "string" && presented.startsWith("ad_")) {
    try {
      const email = await accountEmailForToken(env, presented);
      if (!email) return { kind: "unauthorized" };
      return { kind: "account", email };
    } catch {
      console.error(JSON.stringify({ msg: "account auth failed" }));
      return { kind: "error" };
    }
  }
  if (header == null || String(header).trim() === "") return { kind: "anonymous" };
  return { kind: "unauthorized" };
}

function attachIdentity(runtime, env, request, deps, identity) {
  runtime.env = env;
  runtime.authKind = identity.kind;
  runtime.ownerEmail = identity.kind === "account" ? identity.email : null;
  runtime.clientIp = clientIp(request, deps);
  if (deps && typeof deps.fetch === "function") runtime.fetch = deps.fetch;
  return runtime;
}

function jsonContentType(header) {
  if (!header) return false;
  const media = header.split(";", 1)[0].trim().toLowerCase();
  return media === "application/json";
}

const RESOURCE_READ = {
  ctc: { idPrefix: "ctc_", sql: `SELECT ${CONTACT_FIELDS} FROM contacts WHERE id = ?`, view: contactView },
  cal: { idPrefix: "cal_", sql: `SELECT ${EVENT_FIELDS} FROM calendar_events WHERE id = ?`, view: eventView },
  note: { idPrefix: "note_", sql: `SELECT ${NOTE_FIELDS} FROM notes WHERE id = ?`, view: noteView },
};

function resourceFromPath(path) {
  const match = /^\/(ctc|cal|note)\/([^/]+)$/.exec(path);
  if (!match) return null;
  let id = match[2];
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return { kind: match[1], id: match[2], malformed: true };
  }
  return { kind: match[1], id };
}

function isResourceId(id, prefix) {
  return typeof id === "string" && new RegExp(`^${prefix}[a-z0-9]{12}$`).test(id);
}

function mediaType(header) {
  if (!header) return "";
  return header.split(";", 1)[0].trim().toLowerCase();
}

function changesOf(result) {
  const changes = result && result.meta ? result.meta.changes : undefined;
  const value = typeof changes === "number" ? changes : Number(changes);
  return Number.isFinite(value) ? value : 0;
}

function oauthRuntime(env, request, deps) {
  return {
    ...d1Deps(env),
    env,
    nowMs: deps && deps.nowMs,
    fetch: deps && deps.fetch,
    clientIp: clientIp(request, deps),
  };
}

function oauthFail(err) {
  if (err instanceof RpcError) {
    const status = err.code === -32603 ? 500 : 400;
    return json({ error: { code: err.code, message: err.message } }, status);
  }
  console.error(JSON.stringify({ msg: "oauth failed", error: err && err.message }));
  return json({ error: { code: -32603, message: "internal error" } }, 500);
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readLimitedBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RpcError(-32602, "payload too large");
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) throw new RpcError(-32602, "payload too large");
  return new TextDecoder("utf-8").decode(raw);
}

function readOAuthQuery(url) {
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const scope = url.searchParams.get("scope");
  if (responseType !== "code") throw new RpcError(-32602, "response_type must be code");
  if (typeof clientId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) {
    throw new RpcError(-32602, "client_id is invalid");
  }
  if (
    typeof redirectUri !== "string" ||
    redirectUri.length === 0 ||
    redirectUri.length > 2048 ||
    /[\s]/.test(redirectUri)
  ) {
    throw new RpcError(-32602, "redirect_uri is invalid");
  }
  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new RpcError(-32602, "redirect_uri is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RpcError(-32602, "redirect_uri is invalid");
  }
  if (typeof state !== "string" || state.length === 0 || state.length > 512 || /[\u0000-\u001F\u007F]/.test(state)) {
    throw new RpcError(-32602, "state is invalid");
  }
  if (scope != null && (scope.length > 512 || /[\u0000-\u001F\u007F]/.test(scope))) {
    throw new RpcError(-32602, "scope is invalid");
  }
  const loginHint = normalizeAccountEmail(url.searchParams.get("login_hint"));
  return { clientId, redirectUri, state, scope: scope || "", loginHint, ...readPkceParams(url) };
}

function blankToNull(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value;
}

/** S256 challenge is 32 bytes of SHA-256, base64url, no padding: 43 chars. */
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function readPkceParams(url) {
  const challenge = blankToNull(url.searchParams.get("code_challenge"));
  const method = blankToNull(url.searchParams.get("code_challenge_method"));
  if (challenge == null && method == null) return { codeChallenge: null };
  if (method !== "S256") throw new RpcError(-32602, "code_challenge_method must be S256");
  if (challenge == null) throw new RpcError(-32602, "code_challenge is required");
  if (!PKCE_CHALLENGE.test(challenge)) throw new RpcError(-32602, "code_challenge is invalid");
  return { codeChallenge: challenge };
}

function clientHasSecret(row) {
  return typeof row.client_secret_hash === "string" && row.client_secret_hash.length > 0;
}

/** base64url without padding. S256(verifier) is this encoding of SHA-256(verifier). */
function bytesToBase64Url(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += alphabet[(n >> 6) & 63];
    out += alphabet[n & 63];
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i] << 16;
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
  } else if (left === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63];
  }
  return out;
}

async function pkceS256(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function assertPkceVerifier(challenge, verifier) {
  if (verifier == null) throw new RpcError(-32602, "code_verifier is required");
  if (!PKCE_VERIFIER.test(verifier)) throw new RpcError(-32602, "invalid code_verifier");
  const actual = await pkceS256(verifier);
  if (!timingSafeEqual(actual, challenge)) throw new RpcError(-32602, "invalid code_verifier");
}

async function ensureCodeChallengeColumn(deps) {
  const rows = await queryAll(
    deps,
    "SELECT name FROM pragma_table_info('oauth_codes') WHERE name = 'code_challenge'",
    [],
  );
  if (rows.length > 0) return;
  try {
    await queryRun(deps, "ALTER TABLE oauth_codes ADD COLUMN code_challenge TEXT", []);
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    if (/duplicate column/i.test(message)) return;
    throw err;
  }
}

async function loadOAuthClient(deps, clientId) {
  const row = await queryFirst(
    deps,
    "SELECT client_id, client_secret_hash, redirect_uris, name FROM oauth_clients WHERE client_id = ?",
    [clientId],
  );
  if (!row) throw new RpcError(-32602, "unknown client_id");
  return row;
}

// Unregistered public PKCE clients (e.g. Muse custom connector). The
// redirect must match exactly; the email verification is the real auth.
const PUBLIC_PKCE_REDIRECT_ALLOWLIST = ["https://agent.meta.ai/api/hatch/oauth/callback"];

async function loadAuthorizeClient(deps, query) {
  const row = await queryFirst(
    deps,
    "SELECT client_id, client_secret_hash, redirect_uris, name FROM oauth_clients WHERE client_id = ?",
    [query.clientId],
  );
  if (row) return row;
  if (!query.codeChallenge) throw new RpcError(-32602, "unknown client_id");
  if (!PUBLIC_PKCE_REDIRECT_ALLOWLIST.includes(query.redirectUri)) {
    throw new RpcError(-32602, "redirect_uri mismatch");
  }
  return {
    client_id: query.clientId,
    client_secret_hash: "",
    redirect_uris: JSON.stringify(PUBLIC_PKCE_REDIRECT_ALLOWLIST),
    name: "public-pkce",
  };
}

function assertRegisteredRedirect(row, redirectUri) {
  let list;
  try {
    list = JSON.parse(row.redirect_uris);
  } catch {
    list = null;
  }
  if (!Array.isArray(list) || !list.some((item) => item === redirectUri)) {
    throw new RpcError(-32602, "redirect_uri mismatch");
  }
}

async function assertClientSecret(row, secret) {
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 512) {
    throw new RpcError(-32602, "invalid client_secret");
  }
  const actual = await sha256Hex(secret);
  if (typeof row.client_secret_hash !== "string" || !timingSafeEqual(actual, row.client_secret_hash)) {
    throw new RpcError(-32602, "invalid client_secret");
  }
}

function authorizeAction(query) {
  const params = new URLSearchParams();
  params.set("response_type", "code");
  params.set("client_id", query.clientId);
  params.set("redirect_uri", query.redirectUri);
  params.set("state", query.state);
  if (query.scope) params.set("scope", query.scope);
  if (query.codeChallenge) {
    params.set("code_challenge", query.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  if (query.loginHint) params.set("login_hint", query.loginHint);
  return `/oauth/authorize?${params.toString()}`;
}

function renderAuthorizePage(query, view) {
  const email = view.email || "";
  const error = view.error ? `<p class="error">${escapeHtml(view.error)}</p>` : "";
  const sent = view.sent ? `<p class="ok">验证码已发送，15 分钟内有效。</p>` : "";
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>绑定邮箱</title>
<style>
  body { font-family: sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; }
  label { display: block; margin-top: 1rem; }
  input, button { font: inherit; }
  input { width: 100%; box-sizing: border-box; padding: 0.4rem; margin-top: 0.25rem; }
  button { margin-top: 0.75rem; margin-right: 0.4rem; }
  .error { color: #a40000; }
  .ok { color: #066006; }
</style>
</head>
<body>
  <h1>绑定邮箱</h1>
  <p>验证通过后会回到连接方。</p>
  ${error}
  ${sent}
  <form method="post" action="${escapeHtml(authorizeAction(query))}">
    <label>邮箱
      <input name="email" type="email" autocomplete="email" required value="${escapeHtml(email)}">
    </label>
    <button type="submit" name="action" value="send">发送验证码</button>
    <label>验证码
      <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}">
    </label>
    <button type="submit" name="action" value="verify">验证并继续</button>
  </form>
</body>
</html>`;
}

function newAuthorizationCode() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function redirectWithCode(redirectUri, state, code) {
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", state);
  const url = target.toString();
  // Return an HTML page with JS redirect + manual fallback link.
  // More compatible with in-app browsers than a bare 302.
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="refresh" content="0;url=${escapeHtml(url)}">` +
    `<title>\u6388\u6743\u6210\u529f</title></head><body>` +
    `<p>\u6388\u6743\u6210\u529f\uFF0C\u6B63\u5728\u8FD4\u56DE Muse\u2026</p>` +
    `<p><a href="${escapeHtml(url)}">\u5982\u679C\u6CA1\u6709\u81EA\u52A8\u8DF3\u8F6C\uFF0C\u8BF7\u70B9\u51FB\u8FD9\u91CC</a></p>` +
    `<script>window.location.replace(${JSON.stringify(url)});</script>` +
    `</body></html>`;
  return new Response(page, {
    status: 302,
    headers: {
      location: url,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readAuthorizeForm(request) {
  if (mediaType(request.headers.get("content-type")) !== "application/x-www-form-urlencoded") {
    throw new RpcError(-32602, "Content-Type must be application/x-www-form-urlencoded");
  }
  const params = new URLSearchParams(await readLimitedBody(request));
  return {
    action: params.get("action") || "",
    email: params.get("email") || "",
    code: params.get("code") || "",
  };
}

async function postOAuthAuthorize(request, query, runtime) {
  let email = "";
  try {
    const form = await readAuthorizeForm(request);
    email = form.email;
    if (form.action === "send") {
      await requestAccountVerification({ email: form.email }, runtime);
      return html(renderAuthorizePage(query, { email: normalizeAccountEmail(form.email), sent: true }));
    }
    if (form.action === "verify") {
      const normalized = requireAccountEmail({ email: form.email });
      email = normalized;
      await assertVerificationCode(runtime, normalized, form.code);
      const deleted = await queryRun(runtime, "DELETE FROM verification_codes WHERE email = ?", [normalized]);
      if (changesOf(deleted) !== 1) throw new RpcError(-32602, "invalid verification code");
      const code = newAuthorizationCode();
      const codeHash = await sha256Hex(code);
      const expiresAt = new Date(nowMsOf(runtime) + OAUTH_CODE_TTL_MS).toISOString();
      await ensureCodeChallengeColumn(runtime);
      await queryRun(
        runtime,
        `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, email, expires_at, used_at, code_challenge)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        [codeHash, query.clientId, query.redirectUri, normalized, expiresAt, query.codeChallenge],
      );
      return redirectWithCode(query.redirectUri, query.state, code);
    }
    throw new RpcError(-32602, "action is invalid");
  } catch (err) {
    if (err instanceof RpcError) {
      const status = err.code === -32603 ? 500 : 400;
      return html(renderAuthorizePage(query, { email, error: err.message }), status);
    }
    console.error(JSON.stringify({ msg: "oauth authorize failed", error: err && err.message }));
    return html(renderAuthorizePage(query, { email, error: "internal error" }), 500);
  }
}

async function handleOAuthAuthorize(request, env, deps) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  try {
    const query = readOAuthQuery(new URL(request.url));
    const runtime = oauthRuntime(env, request, deps);
    const client = await loadAuthorizeClient(runtime, query);
    assertRegisteredRedirect(client, query.redirectUri);
    if (!clientHasSecret(client) && !query.codeChallenge) {
      throw new RpcError(-32602, "code_challenge is required");
    }
    if (request.method === "GET") return html(renderAuthorizePage(query, { email: query.loginHint || "" }));
    return postOAuthAuthorize(request, query, runtime);
  } catch (err) {
    return oauthFail(err);
  }
}

function requireBodyString(body, key) {
  if (!body || typeof body !== "object" || !has(body, key) || typeof body[key] !== "string" || body[key].length === 0) {
    throw new RpcError(-32602, `${key} is required`);
  }
  return body[key];
}

function optionalBodyString(body, key) {
  if (!body || typeof body !== "object" || !has(body, key) || body[key] == null || body[key] === "") return null;
  if (typeof body[key] !== "string") throw new RpcError(-32602, `${key} is invalid`);
  return body[key];
}

async function readTokenBody(request) {
  const media = mediaType(request.headers.get("content-type"));
  const text = await readLimitedBody(request);
  if (media === "application/json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RpcError(-32602, "invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new RpcError(-32602, "arguments must be an object");
    }
    return parsed;
  }
  if (media === "application/x-www-form-urlencoded" || media === "") {
    const params = new URLSearchParams(text);
    const out = {};
    for (const key of ["grant_type", "code", "redirect_uri", "client_id", "client_secret", "code_verifier"]) {
      const value = params.get(key);
      if (value != null) out[key] = value;
    }
    return out;
  }
  throw new RpcError(-32602, "Content-Type must be application/json or application/x-www-form-urlencoded");
}

async function handleOAuthToken(request, env, deps) {
  if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  try {
    const body = await readTokenBody(request);
    const grantType = requireBodyString(body, "grant_type");
    if (grantType !== "authorization_code") {
      throw new RpcError(-32602, "grant_type must be authorization_code");
    }
    const code = requireBodyString(body, "code");
    const redirectUri = requireBodyString(body, "redirect_uri");
    const clientId = requireBodyString(body, "client_id");
    const clientSecret = optionalBodyString(body, "client_secret");
    const codeVerifier = optionalBodyString(body, "code_verifier");
    if (!/^[0-9a-f]{64}$/.test(code)) throw new RpcError(-32602, "invalid authorization code");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) throw new RpcError(-32602, "client_id is invalid");
    const runtime = oauthRuntime(env, request, deps);
    let client = null;
    try {
      client = await loadOAuthClient(runtime, clientId);
    } catch (err) {
      // Unregistered public PKCE client: the code row must carry a challenge.
      if (!err || err.code !== -32602) throw err;
    }
    if (client && clientHasSecret(client)) {
      if (clientSecret == null) throw new RpcError(-32602, "client_secret is required");
      await assertClientSecret(client, clientSecret);
    }
    await ensureCodeChallengeColumn(runtime);
    const codeHash = await sha256Hex(code);
    const row = await queryFirst(
      runtime,
      "SELECT client_id, redirect_uri, email, expires_at, used_at, code_challenge FROM oauth_codes WHERE code_hash = ?",
      [codeHash],
    );
    if (!row) throw new RpcError(-32602, "invalid authorization code");
    if (row.client_id !== clientId) throw new RpcError(-32602, "authorization code mismatch");
    if (row.redirect_uri !== redirectUri) throw new RpcError(-32602, "redirect_uri mismatch");
    if (row.used_at != null && row.used_at !== "") {
      throw new RpcError(-32602, "authorization code already used");
    }
    const expiresMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresMs) || nowMsOf(runtime) >= expiresMs) {
      throw new RpcError(-32602, "authorization code expired");
    }
    const boundChallenge = typeof row.code_challenge === "string" && row.code_challenge.length > 0 ? row.code_challenge : null;
    if (boundChallenge) {
      await assertPkceVerifier(boundChallenge, codeVerifier);
    } else if (!client || !clientHasSecret(client)) {
      throw new RpcError(-32602, "code_verifier is required");
    }
    const email = normalizeAccountEmail(row.email);
    if (!email) throw new RpcError(-32603, "internal error");
    const consumed = await queryRun(
      runtime,
      "UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
      [nowIso(runtime), codeHash],
    );
    if (changesOf(consumed) !== 1) throw new RpcError(-32602, "authorization code already used");
    const token = await issueAccountToken(runtime, email);
    return json({ access_token: token, token_type: "Bearer" });
  } catch (err) {
    return oauthFail(err);
  }
}

export async function handleFetch(request, env, deps = {}) {
  const origin = new URL(request.url).origin;
  const path = pathOf(request);

  if (path === "/health") {
    if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
    try {
      const row = await d1Deps(env).queryFirst("SELECT 1 AS ok", []);
      if (!row) return json({ ok: false }, 503);
      return json({ ok: true, service: "abot-data" });
    } catch (err) {
      console.error(JSON.stringify({ msg: "health failed", error: err && err.message }));
      return json({ ok: false }, 503);
    }
  }

  if (path === "/mcp") {
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
    let identity = await resolveBearer(request, env);
    if (identity.kind === "error") return json({ ok: false }, 500);
    if (identity.kind === "unauthorized") return json({ ok: false, error: "unauthorized" }, 401);
    let message = null;
    if (identity.kind === "anonymous") {
      message = await readPublicAccountCall(request);
      if (!message) return json({ ok: false, error: "unauthorized" }, 401);
      identity = { kind: "public" };
    }
    if (!message) {
      if (!jsonContentType(request.headers.get("content-type"))) {
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Content-Type must be application/json" } },
          415,
        );
      }
      const raw = await request.arrayBuffer();
      if (raw.byteLength > MAX_BODY_BYTES) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "payload too large" } }, 413);
      }
      try {
        message = JSON.parse(new TextDecoder("utf-8").decode(raw));
      } catch {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
    }
    const runtime = attachIdentity(phase2.bindRuntime(env, { nowMs: deps.nowMs, origin }), env, request, deps, identity);
    const rpc = await handleMcpRpc(message, runtime);
    if (rpc.type === "notification") return new Response(null, { status: 202 });
    if (rpc.type === "error") {
      return json({ jsonrpc: "2.0", id: rpc.id ?? null, error: rpc.error });
    }
    return json({ jsonrpc: "2.0", id: rpc.id, result: rpc.result });
  }

  if (path === "/oauth/authorize") return handleOAuthAuthorize(request, env, deps);
  if (path === "/oauth/token") return handleOAuthToken(request, env, deps);

  const resource = resourceFromPath(path);
  if (resource) {
    if (request.method !== "GET") return json({ ok: false, error: "method not allowed" }, 405);
    const identity = await resolveBearer(request, env);
    if (identity.kind === "error") return json({ ok: false }, 500);
    if (identity.kind !== "legacy" && identity.kind !== "account") {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const spec = RESOURCE_READ[resource.kind];
    if (resource.malformed || !isResourceId(resource.id, spec.idPrefix)) {
      return json({ found: false, id: resource.id }, 404);
    }
    try {
      const params = [resource.id];
      let sql = spec.sql;
      if (identity.kind === "account") {
        sql += " AND owner_email = ?";
        params.push(identity.email);
      }
      const row = await d1Deps(env).queryFirst(sql, params);
      if (!row) return json({ found: false, id: resource.id }, 404);
      return json({ found: true, ...spec.view(row, origin) });
    } catch (err) {
      console.error(JSON.stringify({ msg: "resource read failed", error: err && err.message }));
      return json({ ok: false }, 500);
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}

export async function handleScheduled(event, env, deps = {}) {
  return phase2.handleScheduled(event, env, deps);
}

export async function handleQueue(batch, env, deps = {}) {
  return phase2.handleQueue(batch, env, deps);
}

export async function consumeDelivery(message, env, deps = {}) {
  return phase2.consumeDelivery(message, env, deps);
}

export default {
  fetch(request, env, ctx) {
    return handleFetch(request, env, { ctx });
  },
  scheduled(event, env, ctx) {
    return handleScheduled(event, env, { ctx });
  },
  queue(batch, env, ctx) {
    return handleQueue(batch, env, { ctx });
  },
};
