import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  accountTokenFromBytes,
  handleFetch,
  newAccountToken,
  newVerificationCode,
  sha256Hex,
  verificationCodeFromBytes,
} from "../src/worker.js";

const TOKEN = "test-data-token";
const RESEND_KEY = "test-resend-key";
const NOW = Date.parse("2026-09-29T04:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const CODE_TTL = 15 * 60 * 1000;

function schemaSql() {
  return readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
}

function sqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql());
  const env = {
    DATA_MCP_TOKEN: TOKEN,
    RESEND_API_KEY: RESEND_KEY,
    DB: {
      prepare(sql) {
        const make = (params) => ({
          all: async () => ({ results: db.prepare(sql).all(...params) }),
          first: async () => db.prepare(sql).get(...params) ?? null,
          run: async () => {
            const info = db.prepare(sql).run(...params);
            return { success: true, meta: { changes: info.changes } };
          },
        });
        return { ...make([]), bind: (...params) => make(params) };
      },
      async batch(statements) {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        return results;
      },
    },
  };
  return { db, env };
}

async function mcp(env, name, args, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token === undefined ? TOKEN : opts.token}`;
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  if (opts.forwarded) headers["x-forwarded-for"] = opts.forwarded;
  const method = opts.method ?? "tools/call";
  const message = { jsonrpc: "2.0", id: opts.id ?? 1, method };
  if (method === "tools/call") message.params = { name, arguments: args ?? {} };
  const res = await handleFetch(
    new Request(opts.url ?? "https://abot-data.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    }),
    env,
    { nowMs: opts.nowMs ?? NOW, clientIp: opts.clientIp, fetch: opts.fetch },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function unwrap(rpc) {
  assert.equal(rpc.status, 200, JSON.stringify(rpc.body));
  assert.equal(rpc.body.error, undefined, JSON.stringify(rpc.body));
  return JSON.parse(rpc.body.result.content[0].text);
}

function rpcError(rpc) {
  assert.equal(rpc.status, 200, JSON.stringify(rpc.body));
  assert.ok(rpc.body.error, JSON.stringify(rpc.body));
  return rpc.body.error;
}

function codeFromMail(sent) {
  const match = String(sent.init.body.text).match(/(\d{6})/);
  assert.ok(match, JSON.stringify(sent.init.body));
  return match[1];
}

async function requestCode(env, email, opts = {}) {
  let sent = null;
  let calls = 0;
  const rpc = await mcp(env, "request_account_verification", { email }, {
    token: opts.token === undefined ? null : opts.token,
    ip: opts.ip,
    forwarded: opts.forwarded,
    clientIp: opts.clientIp,
    nowMs: opts.nowMs ?? NOW,
    fetch: opts.fetch ?? (async (url, init) => {
      calls += 1;
      sent = { url, init: { ...init, body: JSON.parse(init.body) } };
      if (opts.fail) return new Response(opts.failBody ?? "upstream-detail-xyz", { status: 500 });
      return new Response("{}", { status: 200 });
    }),
  });
  return { rpc, sent, calls };
}

async function register(env, email, opts = {}) {
  const requested = await requestCode(env, email, opts);
  assert.deepEqual(unwrap(requested.rpc), { ok: true });
  const code = codeFromMail(requested.sent);
  assert.equal(JSON.stringify(requested.rpc.body).includes(code), false);
  const verified = unwrap(
    await mcp(env, "verify_account", { email, code }, { token: null, nowMs: opts.nowMs ?? NOW, ip: opts.ip }),
  );
  assert.equal(verified.ok, true);
  assert.match(verified.token, /^ad_[0-9a-f]{32}$/);
  assert.equal(Object.keys(verified).sort().join(","), "ok,token");
  return { token: verified.token, code, sent: requested.sent };
}

test("verification codes and account tokens are unbiased fixed-width values", async () => {
  assert.equal(verificationCodeFromBytes(Uint8Array.from([0, 0, 0, 0])), "000000");
  assert.equal(verificationCodeFromBytes(Uint8Array.from([0, 0, 0, 42])), "000042");
  assert.equal(
    verificationCodeFromBytes(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0, 0, 1, 0])),
    "000256",
  );
  assert.throws(() => verificationCodeFromBytes(Uint8Array.from([0xff, 0xff, 0xff, 0xff])), /not enough entropy/);
  assert.match(newVerificationCode(), /^\d{6}$/);
  assert.equal(accountTokenFromBytes(new Uint8Array(16)), `ad_${"0".repeat(32)}`);
  assert.throws(() => accountTokenFromBytes(new Uint8Array(15)), /not enough entropy/);
  assert.match(newAccountToken(), /^ad_[0-9a-f]{32}$/);
  assert.equal(await sha256Hex("abc"), createHash("sha256").update("abc").digest("hex"));
});

test("account tables reapply and leave legacy owner_email null", () => {
  const sql = schemaSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS accounts \([\s\S]*email TEXT PRIMARY KEY/);
  assert.match(sql, /token_hash TEXT NOT NULL/);
  assert.match(sql, /verified_at TEXT NOT NULL/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS verification_codes \([\s\S]*attempts INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS verification_requests/);
  assert.equal(/\bdrop\s+table\b/i.test(sql), false);
  assert.equal(/\balter\s+table\b/i.test(sql), false);
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  db.exec(sql);
  for (const table of ["contacts", "calendar_events", "notes"]) {
    const column = db.prepare(`SELECT "notnull" AS nn FROM pragma_table_info('${table}') WHERE name = 'owner_email'`).get();
    assert.equal(column.nn, 0);
  }
  db.prepare(
    "INSERT INTO verification_codes (email, code_hash, expires_at, requested_at) VALUES ('a@example.com', 'abc', '2026-09-29T04:15:00.000Z', '2026-09-29T04:00:00.000Z')",
  ).run();
  db.prepare(
    "INSERT INTO accounts (email, token_hash, created_at, verified_at) VALUES ('a@example.com', 'hash', '2026-09-29T04:00:00.000Z', '2026-09-29T04:00:00.000Z')",
  ).run();
  db.exec(sql);
  assert.equal(db.prepare("SELECT attempts FROM verification_codes").get().attempts, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1);
});

test("request_account_verification emails a hashed code and hides it from the caller", async () => {
  const { db, env } = sqliteEnv();
  const requested = await requestCode(env, "  Ada@Example.COM ", { ip: "203.0.113.8" });
  const body = unwrap(requested.rpc);
  assert.deepEqual(body, { ok: true });
  const code = codeFromMail(requested.sent);
  assert.equal(requested.sent.url, "https://api.resend.com/emails");
  assert.equal(requested.sent.init.method, "POST");
  assert.equal(requested.sent.init.headers.authorization, `Bearer ${RESEND_KEY}`);
  assert.equal(requested.sent.init.body.from, "abot-data@abot.run");
  assert.deepEqual(requested.sent.init.body.to, ["ada@example.com"]);
  assert.match(requested.sent.init.body.subject, new RegExp(code));
  assert.match(requested.sent.init.body.text, /15 分钟/);
  assert.equal(JSON.stringify(body).includes(code), false);
  const row = db.prepare("SELECT email, code_hash, attempts, expires_at, requested_at FROM verification_codes").get();
  assert.equal(row.email, "ada@example.com");
  assert.equal(row.attempts, 0);
  assert.equal(row.code_hash, await sha256Hex(code));
  assert.notEqual(row.code_hash, code);
  assert.equal(row.expires_at, "2026-09-29T04:15:00.000Z");
  assert.equal(row.requested_at, "2026-09-29T04:00:00.000Z");
  assert.equal(db.prepare("SELECT ip FROM verification_requests").get().ip, "203.0.113.8");
  assert.equal(JSON.stringify(row).includes(RESEND_KEY), false);
});

test("verification email failures stay generic and do not burn a code", async () => {
  const { db, env } = sqliteEnv();
  const first = await requestCode(env, "ada@example.com", { ip: "203.0.113.9" });
  unwrap(first.rpc);
  const code = codeFromMail(first.sent);
  let calls = 0;
  const failed = await requestCode(env, "ada@example.com", {
    ip: "203.0.113.9",
    fail: true,
    failBody: "upstream-detail-xyz",
    fetch: async (_url, init) => {
      calls += 1;
      const mail = JSON.parse(init.body);
      failed.code = mail.text.match(/(\d{6})/)[1];
      return new Response("upstream-detail-xyz", { status: 500 });
    },
  });
  assert.equal(calls, 1);
  const error = rpcError(failed.rpc);
  assert.equal(error.message, "could not send verification email");
  const encoded = JSON.stringify(failed.rpc.body);
  assert.equal(encoded.includes("upstream-detail-xyz"), false);
  assert.equal(encoded.includes(RESEND_KEY), false);
  assert.equal(encoded.includes(failed.code), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_requests").get().n, 1);
  const still = db.prepare("SELECT code_hash FROM verification_codes").get();
  assert.equal(still.code_hash, await sha256Hex(code));

  delete env.RESEND_API_KEY;
  let called = false;
  const missing = await requestCode(env, "ada@example.com", {
    ip: "198.51.100.9",
    fetch: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(called, false);
  assert.equal(rpcError(missing.rpc).message, "could not send verification email");
  assert.equal(JSON.stringify(missing.rpc.body).includes("RESEND"), false);
  const verified = unwrap(await mcp(env, "verify_account", { email: "ada@example.com", code }, { token: null }));
  assert.match(verified.token, /^ad_[0-9a-f]{32}$/);
});

test("verification codes expire, lock after five misses, and can be replaced", async () => {
  const { db, env } = sqliteEnv();
  const requested = await requestCode(env, "ada@example.com", { ip: "203.0.113.20" });
  unwrap(requested.rpc);
  const code = codeFromMail(requested.sent);

  const badFormat = rpcError(await mcp(env, "verify_account", { email: "ada@example.com", code: "12345" }, { token: null }));
  assert.equal(badFormat.message, "code must be a 6-digit string");
  assert.equal(db.prepare("SELECT attempts FROM verification_codes").get().attempts, 0);

  const wrongCode = code === "000000" ? "000001" : "000000";
  for (let i = 1; i <= 5; i++) {
    const missed = rpcError(
      await mcp(env, "verify_account", { email: "ada@example.com", code: wrongCode }, { token: null, nowMs: NOW }),
    );
    assert.equal(missed.message, "invalid verification code");
    assert.equal(db.prepare("SELECT attempts FROM verification_codes").get().attempts, i);
  }
  const locked = rpcError(
    await mcp(env, "verify_account", { email: "ada@example.com", code }, { token: null, nowMs: NOW }),
  );
  assert.equal(locked.message, "too many attempts");
  assert.equal(db.prepare("SELECT attempts FROM verification_codes").get().attempts, 6);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 0);

  const expiredRequest = await requestCode(env, "bea@example.com", { ip: "203.0.113.21" });
  unwrap(expiredRequest.rpc);
  const expiredCode = codeFromMail(expiredRequest.sent);
  const tooLate = rpcError(
    await mcp(env, "verify_account", { email: "bea@example.com", code: "111111" }, { token: null, nowMs: NOW + CODE_TTL }),
  );
  assert.equal(tooLate.message, "verification code expired");
  assert.equal(db.prepare("SELECT attempts FROM verification_codes WHERE email = 'bea@example.com'").get().attempts, 0);

  const fresh = await requestCode(env, "bea@example.com", { ip: "203.0.113.22", nowMs: NOW + CODE_TTL });
  unwrap(fresh.rpc);
  const freshCode = codeFromMail(fresh.sent);
  assert.notEqual(freshCode, expiredCode);
  const almost = unwrap(
    await mcp(env, "verify_account", { email: "bea@example.com", code: freshCode }, {
      token: null,
      nowMs: NOW + CODE_TTL + CODE_TTL - 1,
    }),
  );
  assert.match(almost.token, /^ad_[0-9a-f]{32}$/);
  assert.equal(db.prepare("SELECT code_hash FROM verification_codes WHERE email = 'bea@example.com'").get(), undefined);
  const stored = db.prepare("SELECT token_hash, created_at FROM accounts WHERE email = 'bea@example.com'").get();
  assert.equal(stored.token_hash, await sha256Hex(almost.token));
  assert.equal(JSON.stringify(stored).includes(almost.token), false);
});

test("verification requests are limited per email and per IP", async () => {
  const { db, env } = sqliteEnv();
  const ip = "203.0.113.50";
  for (let i = 0; i < 3; i++) {
    unwrap((await requestCode(env, "ada@example.com", { ip, nowMs: NOW })).rpc);
  }
  const blocked = await requestCode(env, "ada@example.com", { ip: "198.51.100.50", nowMs: NOW + 10 });
  assert.equal(rpcError(blocked.rpc).message, "too many verification requests");
  assert.equal(blocked.calls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_requests WHERE email = 'ada@example.com'").get().n, 3);

  const invalid = rpcError(await mcp(env, "request_account_verification", { email: "not-an-email" }, { token: null, ip }));
  assert.equal(invalid.message, "email is invalid");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_requests").get().n, 3);

  for (let i = 0; i < 7; i++) {
    unwrap((await requestCode(env, `user${i}@example.com`, { ip, nowMs: NOW + 20 + i })).rpc);
  }
  const ipBlocked = await requestCode(env, "new@example.com", { ip, nowMs: NOW + 40 });
  assert.equal(rpcError(ipBlocked.rpc).message, "too many verification requests");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_requests WHERE ip = ?").get(ip).n, 10);

  unwrap((await requestCode(env, "new@example.com", { ip: "198.51.100.77", nowMs: NOW + 41 })).rpc);
  unwrap((await requestCode(env, "ada@example.com", { ip: "198.51.100.78", nowMs: NOW + HOUR })).rpc);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_requests WHERE email = 'ada@example.com'").get().n, 1);

  const forwarded = await requestCode(env, "fwd@example.com", { forwarded: "192.0.2.9, 10.0.0.1" });
  unwrap(forwarded.rpc);
  assert.equal(db.prepare("SELECT ip FROM verification_requests WHERE email = 'fwd@example.com'").get().ip, "192.0.2.9");
  const preferred = await requestCode(env, "cf@example.com", { ip: "203.0.113.1", forwarded: "192.0.2.8" });
  unwrap(preferred.rpc);
  assert.equal(db.prepare("SELECT ip FROM verification_requests WHERE email = 'cf@example.com'").get().ip, "203.0.113.1");
});

test("account tokens authenticate, rotate, and stay out of other responses", async () => {
  const { db, env } = sqliteEnv();
  const first = await register(env, "ada@example.com", { ip: "203.0.113.60" });
  const createdAt = db.prepare("SELECT created_at FROM accounts").get().created_at;
  const second = await register(env, "Ada@Example.com", { ip: "203.0.113.61", nowMs: NOW + 1000 });
  assert.notEqual(first.token, second.token);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1);
  assert.equal(db.prepare("SELECT created_at FROM accounts").get().created_at, createdAt);
  assert.equal(db.prepare("SELECT verified_at FROM accounts").get().verified_at, "2026-09-29T04:00:01.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_codes").get().n, 0);

  const stale = await mcp(env, "list_contacts", {}, { token: first.token });
  assert.equal(stale.status, 401);
  assert.deepEqual(stale.body, { ok: false, error: "unauthorized" });

  const listed = await mcp(env, "list_contacts", {}, { token: second.token, method: "tools/list" });
  assert.equal(listed.status, 200);
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("request_account_verification"));
  assert.ok(names.includes("verify_account"));

  const forged = "ad_" + "ab".repeat(16);
  const unknown = await mcp(env, "list_contacts", {}, { token: forged });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.body, { ok: false, error: "unauthorized" });
  const wrong = await mcp(env, "get_contact", { id: "ctc_abcdefghijkl" }, { token: "wrong-token" });
  assert.equal(wrong.status, 401);
  let mailed = false;
  const wrongPublic = await mcp(env, "request_account_verification", { email: "ada@example.com" }, {
    token: "wrong-token",
    fetch: async () => {
      mailed = true;
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(wrongPublic.status, 401);
  assert.equal(mailed, false);
  const anonymous = await mcp(env, "list_contacts", {}, { token: null });
  assert.equal(anonymous.status, 401);
  const legacy = unwrap(await mcp(env, "list_contacts", {}));
  assert.deepEqual(legacy, []);

  const contact = unwrap(await mcp(env, "create_contact", { name: "Ada" }, { token: second.token }));
  const echoed = JSON.stringify(contact);
  assert.equal(echoed.includes(second.token), false);
  const page = await handleFetch(new Request(contact.url, { headers: { authorization: `Bearer ${second.token}` } }), env);
  assert.equal(JSON.stringify(await page.json()).includes(second.token), false);
});

test("per-agent tokens isolate contacts, calendar events, and notes", async () => {
  const { db, env } = sqliteEnv();
  const ada = await register(env, "ada@example.com", { ip: "203.0.113.70" });
  const bea = await register(env, "bea@example.com", { ip: "203.0.113.71" });
  const window = { start_utc: "2026-09-29T00:00:00.000Z", end_utc: "2026-09-30T00:00:00.000Z" };

  const adaContact = unwrap(await mcp(env, "create_contact", { name: "Ada contact", created_by: "bot:main" }, { token: ada.token }));
  const beaContact = unwrap(await mcp(env, "create_contact", { name: "Bea contact" }, { token: bea.token }));
  const legacyContact = unwrap(await mcp(env, "create_contact", { name: "Legacy contact" }));
  const adaEvent = unwrap(
    await mcp(env, "create_event", {
      title: "Ada event",
      start_utc: "2026-09-29T06:00:00.000Z",
      end_utc: "2026-09-29T07:00:00.000Z",
    }, { token: ada.token }),
  );
  const beaEvent = unwrap(
    await mcp(env, "create_event", {
      title: "Bea event",
      start_utc: "2026-09-29T08:00:00.000Z",
      end_utc: "2026-09-29T09:00:00.000Z",
    }, { token: bea.token }),
  );
  const legacyEvent = unwrap(
    await mcp(env, "create_event", {
      title: "Legacy event",
      start_utc: "2026-09-29T10:00:00.000Z",
      end_utc: "2026-09-29T11:00:00.000Z",
    }),
  );
  const adaNote = unwrap(await mcp(env, "create_note", { title: "Ada note", tags: ["own"] }, { token: ada.token }));
  const beaNote = unwrap(await mcp(env, "create_note", { title: "Bea note" }, { token: bea.token }));
  const legacyNote = unwrap(await mcp(env, "create_note", { title: "Legacy note" }));

  assert.equal(db.prepare("SELECT owner_email FROM contacts WHERE id = ?").get(adaContact.id).owner_email, "ada@example.com");
  assert.equal(db.prepare("SELECT owner_email FROM contacts WHERE id = ?").get(legacyContact.id).owner_email, null);
  assert.equal(db.prepare("SELECT owner_email FROM calendar_events WHERE id = ?").get(beaEvent.id).owner_email, "bea@example.com");
  assert.equal(db.prepare("SELECT owner_email FROM notes WHERE id = ?").get(legacyNote.id).owner_email, null);

  assert.deepEqual(
    unwrap(await mcp(env, "list_contacts", {}, { token: ada.token })).map((row) => row.id),
    [adaContact.id],
  );
  assert.deepEqual(
    unwrap(await mcp(env, "list_events", window, { token: bea.token })).map((row) => row.id),
    [beaEvent.id],
  );
  assert.deepEqual(
    unwrap(await mcp(env, "list_notes", { tag: "own" }, { token: ada.token })).map((row) => row.id),
    [adaNote.id],
  );
  assert.deepEqual(unwrap(await mcp(env, "get_contact", { id: beaContact.id }, { token: ada.token })), {
    found: false,
    id: beaContact.id,
  });
  assert.equal(unwrap(await mcp(env, "get_event", { id: adaEvent.id }, { token: bea.token })).found, false);
  assert.equal(unwrap(await mcp(env, "get_note", { id: legacyNote.id }, { token: ada.token })).found, false);

  const denied = rpcError(await mcp(env, "update_contact", { id: beaContact.id, name: "stolen" }, { token: ada.token }));
  assert.equal(denied.message, "not found");
  assert.equal(rpcError(await mcp(env, "delete_note", { id: adaNote.id }, { token: bea.token })).message, "not found");
  assert.equal(rpcError(await mcp(env, "delete_event", { id: beaEvent.id }, { token: ada.token })).message, "not found");
  assert.equal(db.prepare("SELECT name FROM contacts WHERE id = ?").get(beaContact.id).name, "Bea contact");
  assert.equal(db.prepare("SELECT status FROM calendar_events WHERE id = ?").get(beaEvent.id).status, "confirmed");

  unwrap(await mcp(env, "update_contact", { id: adaContact.id, org: "Analytical" }, { token: ada.token }));
  assert.equal(db.prepare("SELECT owner_email FROM contacts WHERE id = ?").get(adaContact.id).owner_email, "ada@example.com");
  unwrap(await mcp(env, "update_contact", { id: adaContact.id, title: "kept" }));
  assert.equal(db.prepare("SELECT owner_email, title FROM contacts WHERE id = ?").get(adaContact.id).owner_email, "ada@example.com");

  const legacyContacts = unwrap(await mcp(env, "list_contacts", {})).map((row) => row.id).sort();
  assert.deepEqual(legacyContacts, [adaContact.id, beaContact.id, legacyContact.id].sort());
  const legacyEvents = unwrap(await mcp(env, "list_events", window)).map((row) => row.title).sort();
  assert.deepEqual(legacyEvents, ["Ada event", "Bea event", "Legacy event"]);
  const legacyNotes = unwrap(await mcp(env, "list_notes", {})).map((row) => row.title).sort();
  assert.deepEqual(legacyNotes, ["Ada note", "Bea note", "Legacy note"]);

  async function read(url, token) {
    const res = await handleFetch(new Request(url, { headers: { authorization: `Bearer ${token}` } }), env);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  assert.equal((await read(adaContact.url, ada.token)).status, 200);
  assert.equal((await read(beaContact.url, ada.token)).status, 404);
  assert.equal((await read(legacyNote.url, TOKEN)).body.title, "Legacy note");
  assert.equal((await read(adaEvent.url, ada.token)).body.title, "Ada event");
  assert.equal((await read(legacyEvent.url, bea.token)).status, 404);

  const createdBy = rpcError(
    await mcp(env, "create_contact", { name: "nope", created_by: "agent:ada" }, { token: ada.token }),
  );
  assert.equal(createdBy.message, "created_by must be human or bot:main");
  const extra = rpcError(
    await mcp(env, "create_note", { title: "x", owner_email: "bea@example.com" }, { token: ada.token }),
  );
  assert.match(extra.message, /unexpected argument/);

  const sub = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["*"] }, { token: ada.token }));
  unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:acct:2026-09-30T00:00:00.000Z",
    }, { token: ada.token }),
  );
  const polled = unwrap(await mcp(env, "poll_events", { subscription_id: sub.id }));
  assert.equal(polled.events.length, 1);
  const beaSubs = unwrap(await mcp(env, "list_subscriptions", {}, { token: bea.token }));
  assert.equal(beaSubs.some((row) => row.id === sub.id), true);
});
