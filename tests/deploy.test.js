import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { DatabaseSync } from "node:sqlite";

import {
  liveColumnsSql,
  missingColumnStatements,
  productionConfig,
  readBaseConfig,
  schemaColumns,
} from "../deploy/cloudflare.mjs";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function liveColumns(db) {
  return db.prepare(liveColumnsSql(schema)).all();
}
const DB_ID = "bb648d2d-e0e6-4d42-87ea-ed2e50cfcc3f";

test("production config keeps the deploy contract from deploy/ENV.md", () => {
  const base = readBaseConfig(toml);
  const config = productionConfig(base, { databaseId: DB_ID });

  assert.equal(config.name, "abot-data");
  assert.equal(config.main, "../src/worker.js");
  assert.equal(config.compatibility_date, base.compatibility_date);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.keep_vars, true);
  assert.equal(config.vars.PUBLIC_ORIGIN, "https://abot.run/data");
  assert.match(config.vars.WEBHOOK_DENY_DOMAINS, /(^|,)abot\.run(,|$)/);
  assert.match(config.vars.WEBHOOK_DENY_DOMAINS, /(^|,)boliam\.workers\.dev(,|$)/);
  // X-Abot-Owner-Email is trusted on internal hostnames; never add a public entry.
  for (const key of ["route", "routes"]) assert.equal(key in config, false);
  assert.deepEqual(config.d1_databases, [{ binding: "DB", database_name: "abot-data", database_id: DB_ID }]);
  assert.deepEqual(config.durable_objects.bindings, [{ name: "SCHEDULER", class_name: "Scheduler" }]);
  assert.deepEqual(config.exports, { Scheduler: { type: "durable-object", storage: "sqlite" } });
  assert.deepEqual(config.services, [{ binding: "SELF", service: "abot-data" }]);
  assert.deepEqual(config.triggers.crons, ["*/5 * * * *"]);
  assert.deepEqual(
    config.queues.producers.map((p) => [p.binding, p.queue]),
    [["DELIVER_QUEUE", "abot-deliver"], ["RULE_EVENTS", "rule-events"]],
  );
  const [deliver, dlq] = config.queues.consumers;
  assert.deepEqual(deliver, {
    queue: "abot-deliver",
    max_batch_size: 5,
    max_retries: 3,
    max_batch_timeout: 1,
    dead_letter_queue: "abot-deliver-dlq",
  });
  assert.equal(dlq.queue, "abot-deliver-dlq");
  assert.equal(dlq.max_batch_size, 1);
  assert.equal(JSON.stringify(config).includes("TOKEN"), false);
});

test("production config rejects a missing or placeholder D1 id", () => {
  const base = readBaseConfig(toml);
  for (const databaseId of [undefined, "", "abot-data", "00000000-0000-0000-0000-000000000000"]) {
    assert.throws(() => productionConfig(base, { databaseId }), /D1_DATABASE_ID/);
  }
});

test("build and deploy refuse to run outside Workers Builds", () => {
  for (const command of ["build", "deploy"]) {
    const env = { ...process.env, D1_DATABASE_ID: DB_ID };
    delete env.WORKERS_CI;
    const res = spawnSync(process.execPath, ["deploy/cloudflare.mjs", command], {
      cwd: new URL("..", import.meta.url),
      env,
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /outside Cloudflare Workers Builds/);
  }
});

test("deploy adds columns an existing table lacks, then schema.sql applies cleanly", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', org TEXT, title TEXT,
    email TEXT, phone TEXT, relation TEXT, notes TEXT, source TEXT NOT NULL DEFAULT 'manual',
    created_by TEXT NOT NULL DEFAULT 'human', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE deliveries (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, subscription_id TEXT NOT NULL, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, queued_at TEXT, inflight_at TEXT,
    last_error TEXT, dead_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(event_id, subscription_id)
  )`);
  assert.throws(() => db.exec(schema), /owner_email/);
  const statements = missingColumnStatements(schema, liveColumns(db));
  assert.deepEqual(statements, [
    "ALTER TABLE contacts ADD COLUMN owner_email TEXT;",
    "ALTER TABLE deliveries ADD COLUMN reported_at TEXT;",
  ]);
  for (const statement of statements) db.exec(statement);
  db.exec(schema);
  assert.deepEqual(missingColumnStatements(schema, liveColumns(db)), []);
  for (const [table, columns] of schemaColumns(schema)) {
    const live = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
    assert.deepEqual(live, columns.map((c) => c.name), table);
  }
});

test("deploy stops on a missing column SQLite cannot add in place", () => {
  const sql = "CREATE TABLE IF NOT EXISTS t (\n  id TEXT PRIMARY KEY,\n  must TEXT NOT NULL\n);";
  assert.throws(() => missingColumnStatements(sql, [{ tbl: "t", col: "id" }]), /t\.must is missing/);
  assert.deepEqual(missingColumnStatements(sql, []), []);
});

test("the live column query names only schema tables", () => {
  const query = liveColumnsSql(schema);
  assert.doesNotMatch(query, /sqlite_master|_cf_KV|UNION/);
  assert.deepEqual(JSON.parse(query.match(/json_each\('([^']+)'\)/)[1]), [...schemaColumns(schema).keys()]);
});
