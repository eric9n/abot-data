import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { consumeDelivery, handleFetch, handleScheduled, TOOLS, verifyWebhookRequest } from "../src/worker.js";

const TOKEN = "test-data-token";
const SEAL = Buffer.alloc(32, 7).toString("base64");
const RESEND_KEY = "test-resend-key";
const NOW = Date.parse("2026-09-29T04:00:00.000Z");
const WINDOW = { start_utc: "2026-09-29T00:00:00.000Z", end_utc: "2026-09-30T00:00:00.000Z" };

function schemaSql() {
  return readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
}

function sqliteEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql());
  const sent = [];
  const env = {
    DATA_MCP_TOKEN: TOKEN,
    SUBSCRIPTION_SEAL: SEAL,
    RESEND_API_KEY: RESEND_KEY,
    SCHEDULER_SECRET: "scheduler-secret",
    DELIVER_QUEUE: {
      sent,
      async send(body) {
        sent.push(body);
      },
    },
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
  return { db, env, sent };
}

async function mcp(env, name, args, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token === undefined ? TOKEN : opts.token}`;
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
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
    { nowMs: opts.nowMs ?? NOW, fetch: opts.fetch, clientIp: opts.clientIp },
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
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
  const match = String(sent.body.text).match(/(\d{6})/);
  assert.ok(match, JSON.stringify(sent.body));
  return match[1];
}

function mailFetch() {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push({ url: _url, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
  return { sent, fetchImpl };
}

async function register(env, email, opts = {}) {
  const mail = mailFetch();
  const requested = await mcp(env, "request_account_verification", { email }, {
    token: null,
    ip: opts.ip,
    nowMs: opts.nowMs ?? NOW,
    fetch: mail.fetchImpl,
  });
  assert.deepEqual(unwrap(requested), { ok: true });
  const code = codeFromMail(mail.sent[0]);
  assert.equal(JSON.stringify(requested.body).includes(code), false);
  const verified = unwrap(
    await mcp(env, "verify_account", { email, code }, { token: null, ip: opts.ip, nowMs: opts.nowMs ?? NOW }),
  );
  assert.equal(verified.ok, true);
  assert.match(verified.token, /^ad_[0-9a-f]{32}$/);
  return verified.token;
}

async function readResource(env, url, token) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await handleFetch(new Request(url, { headers }), env, { nowMs: NOW });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function titles(rows) {
  return rows.map((row) => row.title).sort();
}

test("e2e exposes 27 tools and rejects unauthorized MCP and canonical reads", async () => {
  const { env } = sqliteEnv();
  assert.equal(TOOLS.length, 27);
  assert.deepEqual(
    TOOLS.map((tool) => tool.name).sort(),
    [
      "ack_event",
      "create_contact",
      "create_event",
      "create_note",
      "create_subscription",
      "delete_contact",
      "delete_event",
      "delete_note",
      "delete_subscription",
      "emit_event",
      "get_contact",
      "get_event",
      "get_note",
      "get_subscription",
      "heartbeat",
      "list_contacts",
      "list_events",
      "list_notes",
      "list_subscriptions",
      "poll_events",
      "request_account_verification",
      "rotate_subscription_secret",
      "update_contact",
      "update_event",
      "update_note",
      "update_subscription",
      "verify_account",
    ],
  );

  const listed = await mcp(env, null, null, { token: null, method: "tools/list" });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.result.tools.length, 27);

  const missing = await mcp(env, "list_contacts", {}, { token: null });
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, { ok: false, error: "unauthorized" });
  assert.match(missing.headers.get("www-authenticate"), /oauth-protected-resource/);

  const wrong = await mcp(env, "list_notes", {}, { token: "wrong-token" });
  assert.equal(wrong.status, 401);
  const forged = await mcp(env, "list_events", WINDOW, { token: `ad_${"ab".repeat(16)}` });
  assert.equal(forged.status, 401);
  const empty = await mcp(env, "get_contact", { id: "ctc_abcdefghijkl" }, { token: "" });
  assert.equal(empty.status, 401);

  const ada = await register(env, "ada@example.com", { ip: "203.0.113.10" });
  const contact = unwrap(await mcp(env, "create_contact", { name: "Ada" }, { token: ada }));
  assert.equal((await readResource(env, contact.url, null)).status, 401);
  assert.equal((await readResource(env, contact.url.replace("/ctc/", "/cal/"), "nope")).status, 401);
  const note = unwrap(await mcp(env, "create_note", { title: "Ada note" }, { token: ada }));
  assert.equal((await readResource(env, note.url, `ad_${"cd".repeat(16)}`)).status, 401);
  const event = unwrap(
    await mcp(env, "create_event", {
      title: "Ada event",
      start_utc: "2026-09-29T06:00:00.000Z",
      end_utc: "2026-09-29T07:00:00.000Z",
    }, { token: ada }),
  );
  assert.equal((await readResource(env, event.url, null)).status, 401);
  assert.equal((await readResource(env, event.url, ada)).status, 200);
});

test("e2e calendar, contacts, and notes CRUD stay inside the creating account", async () => {
  const { db, env } = sqliteEnv();
  const ada = await register(env, "ada@example.com", { ip: "203.0.113.20" });
  const bea = await register(env, "bea@example.com", { ip: "203.0.113.21", nowMs: NOW + 1000 });

  const adaContact = unwrap(
    await mcp(env, "create_contact", {
      name: "Ada Lovelace",
      aliases: ["A.L."],
      org: "Analytical",
      title: "Programmer",
      email: "ada@example.com",
      phone: "+1-555-0100",
      relation: "self",
      notes: "ada-contact-secret",
      created_by: "human",
    }, { token: ada }),
  );
  const beaContact = unwrap(
    await mcp(env, "create_contact", {
      name: "Bea Lovelace",
      email: "bea@example.com",
      notes: "bea-contact-secret",
    }, { token: bea, nowMs: NOW + 1000 }),
  );
  assert.match(adaContact.id, /^ctc_[a-z0-9]{12}$/);
  assert.equal(adaContact.url, `https://abot-data.test/ctc/${adaContact.id}`);

  const adaGot = unwrap(await mcp(env, "get_contact", { id: adaContact.id }, { token: ada }));
  assert.equal(adaGot.found, true);
  assert.equal(adaGot.name, "Ada Lovelace");
  assert.deepEqual(adaGot.aliases, ["A.L."]);
  assert.equal(adaGot.notes, "ada-contact-secret");
  assert.equal(adaGot.org, "Analytical");
  assert.deepEqual(
    unwrap(await mcp(env, "list_contacts", { query: "Lovelace" }, { token: ada })).map((row) => row.id),
    [adaContact.id],
  );
  const adaUpdated = unwrap(
    await mcp(env, "update_contact", { id: adaContact.id, title: "Countess", aliases: ["Ada"] }, { token: ada }),
  );
  assert.equal(adaUpdated.title, "Countess");
  assert.deepEqual(adaUpdated.aliases, ["Ada"]);
  assert.equal(db.prepare("SELECT owner_email FROM contacts WHERE id = ?").get(adaContact.id).owner_email, "ada@example.com");

  db.exec(`CREATE TABLE emails (
    resend_id TEXT,
    direction TEXT,
    msg_from TEXT,
    msg_to TEXT,
    subject TEXT,
    date TEXT
  )`);
  db.prepare(
    "INSERT INTO emails (resend_id, direction, msg_from, msg_to, subject, date) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("mail_bea_private", "in", "bea@example.com", '["ada@example.com"]', "bea-mailbox-secret", "2026-09-28T00:00:00.000Z");
  const afterMail = unwrap(await mcp(env, "get_contact", { id: adaContact.id }, { token: ada }));
  assert.equal(Object.hasOwn(afterMail, "recent_emails"), false);
  assert.equal(JSON.stringify(afterMail).includes("bea-mailbox-secret"), false);
  assert.equal(JSON.stringify(afterMail).includes("mail_bea_private"), false);

  const adaEvent = unwrap(
    await mcp(env, "create_event", {
      title: "Ada standup",
      start_utc: "2026-09-29T06:00:00.000Z",
      end_utc: "2026-09-29T07:00:00.000Z",
      timezone: "Asia/Shanghai",
      all_day: false,
      repeat: { freq: "weekly" },
      attendee_ids: [adaContact.id],
      reminder_minutes: [15, 60],
      location: "ada-room",
      notes: "ada-event-secret",
      created_by: "bot:main",
    }, { token: ada }),
  );
  const beaEvent = unwrap(
    await mcp(env, "create_event", {
      title: "Bea standup",
      start_utc: "2026-09-29T08:00:00.000Z",
      end_utc: "2026-09-29T09:00:00.000Z",
      location: "bea-room",
      notes: "bea-event-secret",
    }, { token: bea }),
  );
  const adaEventView = unwrap(await mcp(env, "get_event", { id: adaEvent.id }, { token: ada }));
  assert.equal(adaEventView.found, true);
  assert.equal(adaEventView.location, "ada-room");
  assert.deepEqual(adaEventView.reminder_minutes, [15, 60]);
  assert.equal(adaEventView.repeat.freq, "weekly");
  assert.deepEqual(titles(unwrap(await mcp(env, "list_events", WINDOW, { token: ada }))), ["Ada standup"]);
  const adaEventUpdated = unwrap(
    await mcp(env, "update_event", { id: adaEvent.id, location: "ada-room-2", title: "Ada sync" }, { token: ada }),
  );
  assert.equal(adaEventUpdated.title, "Ada sync");
  assert.equal(adaEventUpdated.location, "ada-room-2");
  const adaCancelled = unwrap(await mcp(env, "delete_event", { id: adaEvent.id }, { token: ada }));
  assert.equal(adaCancelled.status, "cancelled");
  const adaCancelledView = unwrap(await mcp(env, "get_event", { id: adaEvent.id }, { token: ada }));
  assert.equal(adaCancelledView.status, "cancelled");
  assert.equal(
    db.prepare("SELECT status, owner_email FROM calendar_events WHERE id = ?").get(adaEvent.id).owner_email,
    "ada@example.com",
  );

  const adaNote = unwrap(
    await mcp(env, "create_note", {
      title: "Ada notebook",
      body: "ada-note-secret",
      tags: ["shared", "ada"],
      links: ["https://ada.example/note"],
      created_by: "human",
    }, { token: ada }),
  );
  const beaNote = unwrap(
    await mcp(env, "create_note", {
      title: "Bea notebook",
      body: "bea-note-secret",
      tags: ["shared"],
    }, { token: bea }),
  );
  const adaNoteView = unwrap(await mcp(env, "get_note", { id: adaNote.id }, { token: ada }));
  assert.equal(adaNoteView.body, "ada-note-secret");
  assert.deepEqual(adaNoteView.tags, ["shared", "ada"]);
  assert.deepEqual(
    unwrap(await mcp(env, "list_notes", { tag: "shared", query: "notebook" }, { token: ada })).map((row) => row.id),
    [adaNote.id],
  );
  const adaNoteUpdated = unwrap(
    await mcp(env, "update_note", { id: adaNote.id, body: "ada-note-secret-2", tags: ["ada"] }, { token: ada }),
  );
  assert.equal(adaNoteUpdated.body, "ada-note-secret-2");
  assert.deepEqual(adaNoteUpdated.tags, ["ada"]);

  assert.equal(unwrap(await mcp(env, "get_contact", { id: beaContact.id }, { token: ada })).found, false);
  assert.equal(unwrap(await mcp(env, "get_event", { id: beaEvent.id }, { token: ada })).found, false);
  assert.equal(unwrap(await mcp(env, "get_note", { id: beaNote.id }, { token: ada })).found, false);
  assert.equal(unwrap(await mcp(env, "get_contact", { id: adaContact.id }, { token: bea })).found, false);
  assert.equal(unwrap(await mcp(env, "get_event", { id: adaEvent.id }, { token: bea })).found, false);
  assert.equal(unwrap(await mcp(env, "get_note", { id: adaNote.id }, { token: bea })).found, false);
  assert.deepEqual(titles(unwrap(await mcp(env, "list_events", WINDOW, { token: bea }))), ["Bea standup"]);
  assert.deepEqual(
    unwrap(await mcp(env, "list_notes", { tag: "shared" }, { token: bea })).map((row) => row.id),
    [beaNote.id],
  );
  assert.equal(JSON.stringify(unwrap(await mcp(env, "list_contacts", {}, { token: bea }))).includes("ada-contact-secret"), false);
  assert.equal((await readResource(env, adaContact.url, bea)).status, 404);
  assert.equal((await readResource(env, beaEvent.url, ada)).status, 404);
  assert.equal((await readResource(env, adaNote.url, bea)).status, 404);
  assert.equal((await readResource(env, beaContact.url, bea)).body.name, "Bea Lovelace");

  assert.equal(rpcError(await mcp(env, "update_contact", { id: beaContact.id, name: "stolen" }, { token: ada })).message, "not found");
  assert.equal(rpcError(await mcp(env, "update_event", { id: beaEvent.id, title: "stolen" }, { token: ada })).message, "not found");
  assert.equal(rpcError(await mcp(env, "update_note", { id: beaNote.id, body: "stolen" }, { token: ada })).message, "not found");
  assert.equal(rpcError(await mcp(env, "delete_contact", { id: beaContact.id }, { token: ada })).message, "not found");
  assert.equal(rpcError(await mcp(env, "delete_note", { id: beaNote.id }, { token: ada })).message, "not found");
  assert.equal(rpcError(await mcp(env, "delete_event", { id: beaEvent.id }, { token: ada })).message, "not found");
  assert.equal(db.prepare("SELECT name FROM contacts WHERE id = ?").get(beaContact.id).name, "Bea Lovelace");
  assert.equal(db.prepare("SELECT title FROM calendar_events WHERE id = ?").get(beaEvent.id).title, "Bea standup");
  assert.equal(db.prepare("SELECT body FROM notes WHERE id = ?").get(beaNote.id).body, "bea-note-secret");

  assert.equal(unwrap(await mcp(env, "delete_contact", { id: adaContact.id }, { token: ada })).deleted, true);
  assert.equal(unwrap(await mcp(env, "get_contact", { id: adaContact.id }, { token: ada })).found, false);
  assert.equal(unwrap(await mcp(env, "delete_note", { id: adaNote.id }, { token: ada })).deleted, true);
  assert.equal(unwrap(await mcp(env, "get_note", { id: adaNote.id }, { token: ada })).found, false);
  const legacyNames = unwrap(await mcp(env, "list_contacts", {})).map((row) => row.name);
  assert.deepEqual(legacyNames, ["Bea Lovelace"]);
});

test("e2e subscription create, update, delete, and rotate stay inside the owner", async () => {
  const { db, env } = sqliteEnv();
  const ada = await register(env, "ada@example.com", { ip: "203.0.113.30" });
  const bea = await register(env, "bea@example.com", { ip: "203.0.113.31", nowMs: NOW + 1000 });

  const systemPoll = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["*"] }));
  const systemHook = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/system",
      event_types: ["*"],
    }),
  );
  assert.equal(db.prepare("SELECT owner_email FROM subscriptions WHERE id = ?").get(systemPoll.id).owner_email, null);

  const adaPoll = unwrap(
    await mcp(env, "create_subscription", { mode: "poll", event_types: ["reminder.*"], agent_id: "bot:ada" }, { token: ada }),
  );
  const adaHmac = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/ada-hmac",
      event_types: ["*"],
      watch_heartbeat: false,
    }, { token: ada }),
  );
  const adaBearer = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/ada-bearer",
      event_types: ["reminder.*"],
      bearer_token: "ada-bearer-one",
    }, { token: ada }),
  );
  assert.match(adaHmac.secret, /^whsec_/);
  assert.equal(Object.hasOwn(adaBearer, "secret"), false);
  assert.equal(JSON.stringify(adaBearer).includes("ada-bearer-one"), false);
  assert.equal(db.prepare("SELECT owner_email FROM subscriptions WHERE id = ?").get(adaPoll.id).owner_email, "ada@example.com");

  const adaView = unwrap(await mcp(env, "get_subscription", { id: adaHmac.id }, { token: ada }));
  assert.equal(adaView.webhook_auth, "hmac");
  assert.equal(adaView.has_secret, true);
  assert.equal(adaView.url, "https://example.com/ada-hmac");
  assert.equal(Object.hasOwn(adaView, "secret"), false);
  const adaListed = unwrap(await mcp(env, "list_subscriptions", { limit: 20 }, { token: ada }));
  const adaIds = adaListed.map((row) => row.id);
  assert.ok(adaIds.includes(adaPoll.id));
  assert.equal(adaIds.includes(systemPoll.id), false);
  assert.equal(adaIds.includes(systemHook.id), false);
  assert.equal(JSON.stringify(adaListed).includes("https://example.com/system"), false);

  const paused = unwrap(
    await mcp(env, "update_subscription", {
      id: adaPoll.id,
      status: "paused",
      event_types: ["reminder.medication"],
      agent_id: "bot:ada2",
    }, { token: ada }),
  );
  assert.equal(paused.status, "paused");
  assert.deepEqual(paused.event_types, ["reminder.medication"]);
  assert.equal(paused.agent_id, "bot:ada2");
  const resumed = unwrap(
    await mcp(env, "update_subscription", { id: adaHmac.id, url: "https://example.com/ada-hmac-2", watch_heartbeat: true }, { token: ada }),
  );
  assert.equal(resumed.url, "https://example.com/ada-hmac-2");
  assert.equal(resumed.watch_heartbeat, true);

  const sealedBefore = db.prepare("SELECT secret_sealed FROM subscriptions WHERE id = ?").get(adaHmac.id).secret_sealed;
  const bearerSealedBefore = db.prepare("SELECT secret_sealed FROM subscriptions WHERE id = ?").get(adaBearer.id).secret_sealed;
  for (const id of [adaPoll.id, adaHmac.id, adaBearer.id]) {
    assert.equal(rpcError(await mcp(env, "get_subscription", { id }, { token: bea })).message, "not found");
    assert.equal(rpcError(await mcp(env, "update_subscription", { id, status: "paused" }, { token: bea })).message, "not found");
    assert.equal(rpcError(await mcp(env, "delete_subscription", { id }, { token: bea })).message, "not found");
    assert.equal(rpcError(await mcp(env, "rotate_subscription_secret", { id, bearer_token: "stolen" }, { token: bea })).message, "not found");
    assert.equal(rpcError(await mcp(env, "rotate_subscription_secret", { id }, { token: bea })).message, "not found");
  }
  assert.equal(db.prepare("SELECT secret_sealed FROM subscriptions WHERE id = ?").get(adaHmac.id).secret_sealed, sealedBefore);
  assert.equal(db.prepare("SELECT secret_sealed FROM subscriptions WHERE id = ?").get(adaBearer.id).secret_sealed, bearerSealedBefore);
  assert.equal(db.prepare("SELECT status FROM subscriptions WHERE id = ?").get(adaHmac.id).status, "active");
  assert.equal(unwrap(await mcp(env, "list_subscriptions", {}, { token: bea })).some((row) => row.id === adaPoll.id), false);

  assert.equal(rpcError(await mcp(env, "update_subscription", { id: systemPoll.id, status: "paused" }, { token: ada })).message, "not found");
  assert.equal(rpcError(await mcp(env, "delete_subscription", { id: systemHook.id }, { token: bea })).message, "not found");
  assert.equal(rpcError(await mcp(env, "rotate_subscription_secret", { id: systemHook.id }, { token: ada })).message, "not found");
  assert.equal(db.prepare("SELECT status FROM subscriptions WHERE id = ?").get(systemPoll.id).status, "active");
  assert.equal(db.prepare("SELECT id FROM subscriptions WHERE id = ?").get(systemHook.id).id, systemHook.id);
  assert.equal(rpcError(await mcp(env, "delete_subscription", { id: adaPoll.id })).message, "not found");
  assert.equal(db.prepare("SELECT id FROM subscriptions WHERE id = ?").get(adaPoll.id).id, adaPoll.id);

  const pollRotate = rpcError(await mcp(env, "rotate_subscription_secret", { id: adaPoll.id }, { token: ada }));
  assert.equal(pollRotate.message, "subscription has no webhook secret");
  const hmacRotated = unwrap(await mcp(env, "rotate_subscription_secret", { id: adaHmac.id }, { token: ada }));
  assert.match(hmacRotated.secret, /^whsec_/);
  assert.notEqual(hmacRotated.secret, adaHmac.secret);
  const bearerRotated = unwrap(
    await mcp(env, "rotate_subscription_secret", { id: adaBearer.id, bearer_token: "ada-bearer-two" }, { token: ada }),
  );
  assert.deepEqual(bearerRotated, { id: adaBearer.id });
  assert.equal(JSON.stringify(bearerRotated).includes("ada-bearer-two"), false);

  assert.equal(rpcError(await mcp(env, "get_subscription", { id: systemPoll.id }, { token: ada })).message, "not found");
  const deleted = unwrap(await mcp(env, "delete_subscription", { id: adaPoll.id }, { token: ada }));
  assert.deepEqual(deleted, { id: adaPoll.id, deleted: true });
  assert.equal(rpcError(await mcp(env, "get_subscription", { id: adaPoll.id }, { token: ada })).message, "not found");
  assert.equal(db.prepare("SELECT id FROM subscriptions WHERE id = ?").get(adaPoll.id), undefined);

  });

test("e2e webhook delivery signs hmac and sends bearer without crossing accounts", async () => {
  const { db, env } = sqliteEnv();
  const ada = await register(env, "ada@example.com", { ip: "203.0.113.40" });
  const bea = await register(env, "bea@example.com", { ip: "203.0.113.41", nowMs: NOW + 1000 });
  const adaHmac = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/ada-hmac",
      event_types: ["*"],
    }, { token: ada }),
  );
  const adaBearer = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/ada-bearer",
      event_types: ["*"],
      bearer_token: "ada-bearer-one",
    }, { token: ada }),
  );
  const beaHmac = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/bea-hmac",
      event_types: ["*"],
    }, { token: bea }),
  );
  const beaBearer = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/bea-bearer",
      event_types: ["*"],
      bearer_token: "bea-bearer-token",
    }, { token: bea }),
  );
  unwrap(await mcp(env, "rotate_subscription_secret", { id: adaHmac.id }, { token: ada }));
  const hmacSecret = unwrap(await mcp(env, "rotate_subscription_secret", { id: adaHmac.id }, { token: ada })).secret;
  unwrap(
    await mcp(env, "rotate_subscription_secret", { id: adaBearer.id, bearer_token: "ada-bearer-two" }, { token: ada }),
  );

  const ev = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:ada:2026-09-30T00:00:00.000Z",
      payload: { who: "ada-only" },
      audience: "bot",
    }, { token: ada }),
  );
  const deliveries = db.prepare(
    "SELECT id, subscription_id FROM deliveries WHERE event_id = ?",
  ).all(ev.id);
  const targets = new Set(deliveries.map((row) => row.subscription_id));
  assert.equal(targets.has(adaHmac.id), true);
  assert.equal(targets.has(adaBearer.id), true);
  assert.equal(targets.has(beaHmac.id), false);
  assert.equal(targets.has(beaBearer.id), false);

  const seen = new Map();
  for (const delivery of deliveries) {
    const decision = await consumeDelivery({ body: { delivery_id: delivery.id } }, env, {
      nowMs: NOW,
      fetch: async (url, init) => {
        seen.set(delivery.subscription_id, { url, headers: init.headers, body: init.body });
        return new Response("ok", { status: 200 });
      },
    });
    assert.equal(decision.action, "ack");
  }
  const hmacHit = seen.get(adaHmac.id);
  assert.equal(hmacHit.url, "https://example.com/ada-hmac");
  assert.equal(hmacHit.headers.authorization, undefined);
  assert.equal(hmacHit.headers["x-abot-event-id"], ev.id);
  assert.equal(hmacHit.headers["x-abot-subscription-id"], adaHmac.id);
  assert.equal(hmacHit.body.includes("ada-only"), true);
  assert.equal(hmacHit.body.includes("ada-bearer-two"), false);
  assert.equal(
    await verifyWebhookRequest({
      secret: hmacSecret,
      timestamp: hmacHit.headers["x-abot-timestamp"],
      body: hmacHit.body,
      signature: hmacHit.headers["x-abot-signature"],
      nowMs: NOW,
    }),
    true,
  );
  const bearerHit = seen.get(adaBearer.id);
  assert.equal(bearerHit.headers.authorization, "Bearer ada-bearer-two");
  assert.equal(Object.hasOwn(bearerHit.headers, "x-abot-signature"), false);
  assert.equal(bearerHit.body.includes("ada-only"), true);
  assert.equal(db.prepare("SELECT state FROM deliveries WHERE id = ?").get(deliveries[0].id).state, "succeeded");
});

test("e2e emit and poll filter audience and hide other owners", async () => {
  const { db, env } = sqliteEnv();
  const ada = await register(env, "ada@example.com", { ip: "203.0.113.50" });
  const bea = await register(env, "bea@example.com", { ip: "203.0.113.51", nowMs: NOW + 1000 });
  const adaPoll = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["*"] }, { token: ada }));
  const beaPoll = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["*"] }, { token: bea }));
  unwrap(await mcp(env, "heartbeat", { agent_id: "bot:ada", ttl_seconds: 600 }, { token: ada }));

  const rejectedDue = rpcError(
    await mcp(env, "emit_event", { type: "calendar.due", dedupe_key: "custom" }, { token: ada }),
  );
  assert.equal(rejectedDue.message, "type is not allowed");
  const rejectedWatch = rpcError(
    await mcp(env, "emit_event", { type: "watchdog.heartbeat_stale", dedupe_key: "watchdog.x" }, { token: bea }),
  );
  assert.equal(rejectedWatch.message, "type is not allowed");

  const adaBot = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:ada-bot",
      payload: { who: "ada-bot" },
      audience: "bot",
    }, { token: ada }),
  );
  const adaUser = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.followup",
      dedupe_key: "reminder.followup:ada-user",
      payload: { who: "ada-user" },
      audience: "user",
    }, { token: ada }),
  );
  const beaBot = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:bea-bot",
      payload: { who: "bea-bot" },
      audience: "bot",
    }, { token: bea }),
  );
  const system = unwrap(
    await mcp(env, "emit_event", {
      type: "reminder.medication",
      dedupe_key: "reminder.medication:system",
      payload: { who: "system-bot" },
    }),
  );
  assert.equal(db.prepare("SELECT owner_email, audience FROM events WHERE id = ?").get(adaBot.id).owner_email, "ada@example.com");
  assert.equal(db.prepare("SELECT audience FROM events WHERE id = ?").get(adaUser.id).audience, "user");
  assert.equal(db.prepare("SELECT owner_email FROM events WHERE id = ?").get(system.id).owner_email, null);

  function whos(page) {
    return page.events.map((row) => row.payload.who).sort();
  }
  const adaBots = unwrap(
    await mcp(env, "poll_events", { subscription_id: adaPoll.id, audience: "bot", visibility_seconds: 30 }, { token: ada }),
  );
  assert.deepEqual(whos(adaBots), ["ada-bot", "system-bot"]);
  const adaUsers = unwrap(
    await mcp(env, "poll_events", { subscription_id: adaPoll.id, audience: "user", visibility_seconds: 30 }, { token: ada, nowMs: NOW + 31000 }),
  );
  assert.deepEqual(whos(adaUsers), ["ada-user"]);
  const beaBots = unwrap(
    await mcp(env, "poll_events", { subscription_id: beaPoll.id, audience: "bot", visibility_seconds: 30 }, { token: bea, nowMs: NOW + 62000 }),
  );
  assert.deepEqual(whos(beaBots), ["bea-bot", "system-bot"]);
  assert.equal(JSON.stringify(beaBots).includes("ada-bot"), false);
  assert.equal(JSON.stringify(beaBots).includes("ada-user"), false);
  assert.equal(rpcError(await mcp(env, "poll_events", { subscription_id: adaPoll.id }, { token: bea })).message, "not found");

  const adaLease = adaBots.events.find((row) => row.payload.who === "ada-bot");
  const stolen = rpcError(
    await mcp(env, "ack_event", { id: adaLease.id, lease_token: adaLease.lease_token }, { token: bea }),
  );
  assert.equal(stolen.message, "not found");
  const acked = unwrap(
    await mcp(env, "ack_event", { id: adaLease.id, lease_token: adaLease.lease_token }, { token: ada }),
  );
  assert.equal(acked.status, "acked");
  assert.equal(acked.idempotent, false);
  const again = unwrap(
    await mcp(env, "ack_event", { id: adaLease.id, lease_token: adaLease.lease_token }, { token: ada }),
  );
  assert.equal(again.idempotent, true);
  assert.equal(db.prepare("SELECT status FROM events WHERE id = ?").get(beaBot.id).status, "pending");
  const probe = rpcError(
    await mcp(env, "ack_event", { id: beaBot.id, lease_token: "a".repeat(32) }, { token: ada }),
  );
  assert.equal(probe.message, "not found");
});

test("e2e calendar.due carries the calendar owner and does not leak to other accounts", async () => {
  const { db, env, sent } = sqliteEnv();
  const ada = await register(env, "ada@example.com", { ip: "203.0.113.60" });
  const bea = await register(env, "bea@example.com", { ip: "203.0.113.61", nowMs: NOW + 1000 });
  const adaPoll = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["calendar.*"] }, { token: ada }));
  const beaPoll = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["calendar.*"] }, { token: bea }));
  const legacyPoll = unwrap(await mcp(env, "create_subscription", { mode: "poll", event_types: ["calendar.*"] }));
  const adaHook = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/ada-cal",
      event_types: ["calendar.*"],
    }, { token: ada }),
  );
  const beaHook = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/bea-cal",
      event_types: ["calendar.*"],
    }, { token: bea }),
  );
  const legacyHook = unwrap(
    await mcp(env, "create_subscription", {
      mode: "webhook",
      url: "https://example.com/legacy-cal",
      event_types: ["calendar.*"],
    }),
  );

  const adaDue = unwrap(
    await mcp(env, "create_event", {
      title: "Ada private visit",
      start_utc: "2026-09-29T03:00:00.000Z",
      end_utc: "2026-09-29T03:30:00.000Z",
      location: "ada-clinic",
      notes: "ada-calendar-note-secret",
    }, { token: ada }),
  );
  const beaDue = unwrap(
    await mcp(env, "create_event", {
      title: "Bea private visit",
      start_utc: "2026-09-29T03:10:00.000Z",
      end_utc: "2026-09-29T03:40:00.000Z",
      location: "bea-clinic",
      notes: "bea-calendar-note-secret",
    }, { token: bea }),
  );
  const adaLater = unwrap(
    await mcp(env, "create_event", {
      title: "Ada future",
      start_utc: "2026-09-29T08:00:00.000Z",
      end_utc: "2026-09-29T09:00:00.000Z",
    }, { token: ada }),
  );
  const adaCancelled = unwrap(
    await mcp(env, "create_event", {
      title: "Ada cancelled visit",
      start_utc: "2026-09-29T02:00:00.000Z",
      end_utc: "2026-09-29T02:30:00.000Z",
    }, { token: ada }),
  );
  unwrap(await mcp(env, "delete_event", { id: adaCancelled.id }, { token: ada }));
  const legacyDue = unwrap(
    await mcp(env, "create_event", {
      title: "Legacy clinic",
      start_utc: "2026-09-29T03:20:00.000Z",
      end_utc: "2026-09-29T03:50:00.000Z",
      location: "legacy-clinic",
    }),
  );

  sent.length = 0;
  await handleScheduled({}, env, { nowMs: NOW });
  const dueRows = db.prepare("SELECT id, type, owner_email, payload, source FROM events WHERE type = 'calendar.due'").all();
  const byCalendar = new Map(dueRows.map((row) => [JSON.parse(row.payload).calendar_event_id, row]));
  assert.equal(byCalendar.has(adaLater.id), false);
  assert.equal(byCalendar.has(adaCancelled.id), false);
  const adaBus = byCalendar.get(adaDue.id);
  const beaBus = byCalendar.get(beaDue.id);
  const legacyBus = byCalendar.get(legacyDue.id);
  assert.ok(adaBus);
  assert.ok(beaBus);
  assert.ok(legacyBus);
  assert.equal(adaBus.owner_email, "ada@example.com");
  assert.equal(beaBus.owner_email, "bea@example.com");
  assert.equal(legacyBus.owner_email, null);
  assert.equal(adaBus.source, "detector");
  assert.equal(JSON.parse(adaBus.payload).title, "Ada private visit");
  assert.equal(JSON.parse(adaBus.payload).location, "ada-clinic");
  assert.equal(JSON.parse(adaBus.payload).notes, undefined);
  assert.equal(JSON.parse(adaBus.payload).path, `/cal/${adaDue.id}`);

  function deliverySubs(eventId) {
    return new Set(
      db.prepare("SELECT subscription_id FROM deliveries WHERE event_id = ?").all(eventId).map((row) => row.subscription_id),
    );
  }
  const adaTargets = deliverySubs(adaBus.id);
  const beaTargets = deliverySubs(beaBus.id);
  assert.equal(adaTargets.has(adaHook.id), true);
  assert.equal(adaTargets.has(beaHook.id), false);
  assert.equal(adaTargets.has(legacyHook.id), false);
  assert.equal(beaTargets.has(beaHook.id), true);
  assert.equal(beaTargets.has(adaHook.id), false);
  assert.equal(beaTargets.has(legacyHook.id), false);

  const adaPage = unwrap(
    await mcp(env, "poll_events", { subscription_id: adaPoll.id, audience: "bot" }, { token: ada }),
  );
  const adaSeen = adaPage.events.map((row) => row.payload.title).sort();
  assert.deepEqual(adaSeen, ["Ada private visit", "Legacy clinic"]);
  assert.equal(JSON.stringify(adaPage).includes("Bea private visit"), false);
  assert.equal(JSON.stringify(adaPage).includes("bea-calendar-note-secret"), false);
  const beaPage = unwrap(
    await mcp(env, "poll_events", { subscription_id: beaPoll.id, audience: "bot" }, { token: bea, nowMs: NOW + 130000 }),
  );
  assert.deepEqual(beaPage.events.map((row) => row.payload.title).sort(), ["Bea private visit", "Legacy clinic"]);
  assert.equal(JSON.stringify(beaPage).includes("Ada private visit"), false);
  assert.equal(JSON.stringify(beaPage).includes("ada-clinic"), false);
  assert.equal(JSON.stringify(beaPage).includes("ada-calendar-note-secret"), false);
  const userPage = unwrap(
    await mcp(env, "poll_events", { subscription_id: adaPoll.id, audience: "user" }, { token: ada, nowMs: NOW + 260000 }),
  );
  assert.deepEqual(userPage.events, []);
  const legacyPage = unwrap(
    await mcp(env, "poll_events", { subscription_id: legacyPoll.id }, { nowMs: NOW + 390000 }),
  );
  assert.deepEqual(legacyPage.events.map((row) => row.payload.title).sort(), ["Legacy clinic"]);
  assert.equal(JSON.stringify(legacyPage).includes("Ada private visit"), false);
  assert.equal(JSON.stringify(legacyPage).includes("Bea private visit"), false);

  const adaScheduler = unwrap(
    await mcp(env, "create_event", {
      title: "Ada alarm",
      start_utc: "2026-09-29T03:40:00.000Z",
      end_utc: "2026-09-29T03:55:00.000Z",
      location: "ada-alarm-room",
    }, { token: ada }),
  );
  const forbidden = await handleFetch(
    new Request("https://abot-data.test/internal/scheduler-due", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ triggers: [{ id: `calendar:${adaScheduler.id}`, type: "calendar.due", payload: { eventId: adaScheduler.id } }] }),
    }),
    env,
    { nowMs: NOW },
  );
  assert.equal(forbidden.status, 403);
  const handed = await handleFetch(
    new Request("https://abot-data.test/internal/scheduler-due", {
      method: "POST",
      headers: { "content-type": "application/json", "x-scheduler-secret": "scheduler-secret" },
      body: JSON.stringify({ triggers: [{ id: `calendar:${adaScheduler.id}`, type: "calendar.due", payload: { eventId: adaScheduler.id } }] }),
    }),
    env,
    { nowMs: NOW },
  );
  assert.equal(handed.status, 200);
  const alarm = db.prepare(
    "SELECT owner_email, payload FROM events WHERE dedupe_key = ?",
  ).get(`calendar.due:${adaScheduler.id}:2026-09-29T03:40:00.000Z`);
  assert.equal(alarm.owner_email, "ada@example.com");
  assert.equal(JSON.parse(alarm.payload).title, "Ada alarm");
  const alarmId = db.prepare(
    "SELECT id FROM events WHERE dedupe_key = ?",
  ).get(`calendar.due:${adaScheduler.id}:2026-09-29T03:40:00.000Z`).id;
  const alarmTargets = deliverySubs(alarmId);
  assert.equal(alarmTargets.has(beaHook.id), false);
  assert.equal(alarmTargets.has(adaHook.id), true);

  const bodies = [];
  const alarmDelivery = db.prepare("SELECT id FROM deliveries WHERE event_id = ? AND subscription_id = ?").get(alarmId, adaHook.id);
  await consumeDelivery({ body: { delivery_id: alarmDelivery.id } }, env, {
    nowMs: NOW,
    fetch: async (_url, init) => {
      bodies.push(init.body);
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(bodies[0].includes("Ada alarm"), true);
  assert.equal(bodies[0].includes("ada-alarm-room"), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE event_id = ? AND subscription_id = ?").get(alarmId, beaHook.id).n, 0);
});

test("e2e oauth registration verifies the email and issues an account token", async () => {
  const { db, env } = sqliteEnv();
  const redirect = "https://connector.example/callback";
  const mail = mailFetch();
  const registered = await handleFetch(
    new Request("https://abot-data.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "E2E connector",
        redirect_uris: [redirect],
      }),
    }),
    env,
    { nowMs: NOW },
  );
  assert.equal(registered.status, 200);
  const client = await registered.json();
  assert.match(client.client_id, /^dcr_[0-9a-f]+$/);
  assert.match(client.client_secret, /^[0-9a-f]+$/);
  assert.deepEqual(client.redirect_uris, [redirect]);
  const stored = db.prepare("SELECT client_secret_hash, redirect_uris FROM oauth_clients WHERE client_id = ?").get(client.client_id);
  assert.notEqual(stored.client_secret_hash, client.client_secret);
  assert.equal(stored.client_secret_hash.includes(client.client_secret), false);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    state: "e2e-state",
  });
  const page = await handleFetch(new Request(`https://abot-data.test/oauth/authorize?${params}`), env, { nowMs: NOW });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /绑定邮箱/);

  const send = await handleFetch(
    new Request(`https://abot-data.test/oauth/authorize?${params}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.70" },
      body: new URLSearchParams({ action: "send", email: "Cara@Example.com" }),
    }),
    env,
    { nowMs: NOW, fetch: mail.fetchImpl },
  );
  assert.equal(send.status, 200);
  const sentHtml = await send.text();
  assert.match(sentHtml, /验证码已发送/);
  const emailCode = codeFromMail(mail.sent[0]);
  assert.equal(sentHtml.includes(emailCode), false);
  assert.equal(mail.sent[0].body.to[0], "cara@example.com");

  const verify = await handleFetch(
    new Request(`https://abot-data.test/oauth/authorize?${params}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.70" },
      body: new URLSearchParams({ action: "verify", email: "cara@example.com", code: emailCode }),
    }),
    env,
    { nowMs: NOW },
  );
  assert.equal(verify.status, 302);
  const location = new URL(verify.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, redirect);
  assert.equal(location.searchParams.get("state"), "e2e-state");
  const code = location.searchParams.get("code");
  assert.match(code, /^[0-9a-f]{64}$/);

  const tokenRes = await handleFetch(
    new Request("https://abot-data.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: client.client_id,
        client_secret: client.client_secret,
      }),
    }),
    env,
    { nowMs: NOW },
  );
  assert.equal(tokenRes.status, 200);
  const tokenBody = await tokenRes.json();
  assert.equal(tokenBody.token_type, "Bearer");
  assert.match(tokenBody.access_token, /^ad_[0-9a-f]{32}$/);

  const created = unwrap(
    await mcp(env, "create_contact", { name: "Cara" }, { token: tokenBody.access_token }),
  );
  assert.equal(db.prepare("SELECT owner_email FROM contacts WHERE id = ?").get(created.id).owner_email, "cara@example.com");
  const other = await register(env, "bea@example.com", { ip: "203.0.113.71", nowMs: NOW + 1000 });
  assert.equal(unwrap(await mcp(env, "get_contact", { id: created.id }, { token: other })).found, false);

  const reused = await handleFetch(
    new Request("https://abot-data.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: client.client_id,
        client_secret: client.client_secret,
      }),
    }),
    env,
    { nowMs: NOW + 1000 },
  );
  assert.equal(reused.status, 400);
});
