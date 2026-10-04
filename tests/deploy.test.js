import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { productionConfig, readBaseConfig } from "../deploy/cloudflare.mjs";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
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
