import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleFetch } from "../src/worker.js";
import { Scheduler } from "../src/scheduler.js";

const TOKEN = "test-data-token";
const NOW = Date.parse("2026-09-29T04:00:00.000Z");

function d1(db) {
  return {
    prepare(sql) {
      const make = (params) => ({
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        first: async () => db.prepare(sql).get(...params) ?? null,
        run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...params).changes } }),
      });
      return { ...make([]), bind: (...params) => make(params) };
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

function fakeState() {
  const data = new Map();
  const state = {
    alarmAt: null,
    storage: {
      async get(key) { return data.get(key); },
      async put(key, value) { data.set(key, structuredClone(value)); },
      async setAlarm(ms) { state.alarmAt = ms; },
      async deleteAlarm() { state.alarmAt = null; },
    },
  };
  return state;
}

function setup({ selfStatus } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const calls = [];
  const env = {
    DATA_MCP_TOKEN: TOKEN,
    SUBSCRIPTION_SEAL: Buffer.alloc(32, 7).toString("base64"),
    SCHEDULER_SECRET: "scheduler-secret",
    DELIVER_QUEUE: { async send() {} },
    DB: d1(db),
  };
  env.SELF = {
    async fetch(request) {
      calls.push(new URL(request.url).pathname);
      if (selfStatus) return new Response("", { status: selfStatus });
      return handleFetch(request, env, { nowMs: NOW });
    },
  };
  const state = fakeState();
  return { db, env, calls, state, scheduler: new Scheduler(state, env) };
}

async function createEvent(env) {
  const res = await handleFetch(
    new Request("https://abot-data.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_event",
          arguments: { title: "Alarm", start_utc: "2026-09-29T03:40:00.000Z", end_utc: "2026-09-29T03:55:00.000Z" },
        },
      }),
    }),
    env,
    { nowMs: NOW },
  );
  return JSON.parse((await res.json()).result.content[0].text).id;
}

test("alarm hands due triggers to the worker route and emits calendar.due", async () => {
  const { db, env, calls, state, scheduler } = setup();
  const id = await createEvent(env);
  await scheduler.schedule(`calendar:${id}`, Date.now() - 1000, "calendar.due", { eventId: id });
  await scheduler.schedule("calendar:later", Date.now() + 3_600_000, "calendar.due", { eventId: "later" });

  await scheduler.alarm();

  assert.deepEqual(calls, ["/internal/scheduler-due"]);
  const row = db.prepare("SELECT type FROM events WHERE dedupe_key LIKE ?").get(`calendar.due:${id}:%`);
  assert.equal(row.type, "calendar.due");
  const left = await scheduler.getTriggers();
  assert.deepEqual([...left.keys()], ["calendar:later"]);
  assert.equal(state.alarmAt, left.get("calendar:later").dueTimeMs);
});

test("a failed handoff keeps the trigger and retries later", async () => {
  const { calls, state, scheduler } = setup({ selfStatus: 503 });
  await scheduler.schedule("calendar:x", Date.now() - 1000, "calendar.due", { eventId: "x" });

  const before = Date.now();
  await scheduler.alarm();

  assert.equal(calls.length, 1);
  assert.deepEqual([...(await scheduler.getTriggers()).keys()], ["calendar:x"]);
  assert.ok(state.alarmAt >= before + 60_000);
});
