// Workers Builds entry point. The Cloudflare dashboard trigger for abot-data runs
//   build command:  npm test && node deploy/cloudflare.mjs build
//   deploy command: node deploy/cloudflare.mjs deploy
// This is the only supported way to publish abot-data. See deploy/ENV.md.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "dist");
const OUT_CONFIG = join(OUT_DIR, "wrangler.json");
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");

export const PRODUCTION_BRANCH = "main";
const PLACEHOLDER_DB_ID = "00000000-0000-0000-0000-000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readBaseConfig(toml) {
  const pick = (key) => {
    const m = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
    if (!m) throw new Error(`wrangler.toml is missing ${key}`);
    return m[1];
  };
  return { name: pick("name"), main: pick("main"), compatibility_date: pick("compatibility_date") };
}

export function productionConfig(base, { databaseId }) {
  if (!UUID.test(databaseId || "") || databaseId === PLACEHOLDER_DB_ID) {
    throw new Error("D1_DATABASE_ID must be the production D1 database UUID");
  }
  return {
    name: base.name,
    main: `../${base.main}`,
    compatibility_date: base.compatibility_date,
    // Reachable only through service bindings (abot-gateway).
    workers_dev: false,
    preview_urls: false,
    // Plain vars such as WRITE_RATE_LIMIT are managed in the dashboard.
    keep_vars: true,
    vars: {
      PUBLIC_ORIGIN: "https://abot.run/data",
      // Hosts served from this Cloudflare account. A webhook there could call
      // our own Workers with the delivery's signature or bearer.
      WEBHOOK_DENY_DOMAINS: "abot.run,dagou.one,dagow.me,botu.dev,boliam.workers.dev",
    },
    d1_databases: [{ binding: "DB", database_name: "abot-data", database_id: databaseId }],
    durable_objects: { bindings: [{ name: "SCHEDULER", class_name: "Scheduler" }] },
    // Declarative and compared against what is deployed. The live class is SQLite-backed.
    exports: { Scheduler: { type: "durable-object", storage: "sqlite" } },
    services: [{ binding: "SELF", service: base.name }],
    queues: {
      producers: [
        { binding: "DELIVER_QUEUE", queue: "abot-deliver" },
        { binding: "RULE_EVENTS", queue: "rule-events" },
      ],
      consumers: [
        {
          queue: "abot-deliver",
          max_batch_size: 5,
          max_retries: 3,
          max_batch_timeout: 1,
          dead_letter_queue: "abot-deliver-dlq",
        },
        { queue: "abot-deliver-dlq", max_batch_size: 1, max_retries: 3, max_batch_timeout: 1 },
      ],
    },
    triggers: { crons: ["*/5 * * * *"] },
  };
}

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

function requireWorkersBuilds() {
  if (process.env.WORKERS_CI !== "1") {
    fail("refusing to run outside Cloudflare Workers Builds (WORKERS_CI=1). Push to main instead.");
  }
}

function wrangler(args) {
  console.log(`$ wrangler ${args.join(" ")}`);
  const res = spawnSync(WRANGLER, args, { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) fail(`wrangler ${args[0]} failed (exit ${res.status ?? res.signal})`);
}

function build() {
  requireWorkersBuilds();
  const base = readBaseConfig(readFileSync(join(ROOT, "wrangler.toml"), "utf8"));
  let config;
  try {
    config = productionConfig(base, { databaseId: process.env.D1_DATABASE_ID });
  } catch (err) {
    fail(`${err.message}. Set it under Settings > Build > Variables and secrets.`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_CONFIG, JSON.stringify(config, null, 2) + "\n");
  console.log(`wrote ${relative(ROOT, OUT_CONFIG)}`);
  wrangler(["deploy", "--dry-run", "--config", OUT_CONFIG, "--outdir", join(OUT_DIR, "bundle")]);
}

function deploy() {
  requireWorkersBuilds();
  if (!existsSync(OUT_CONFIG)) fail("dist/wrangler.json not found; the build command must run first");
  const branch = process.env.WORKERS_CI_BRANCH || "";
  const sha = (process.env.WORKERS_CI_COMMIT_SHA || "").slice(0, 12);
  const message = `${branch}@${sha} build ${process.env.WORKERS_CI_BUILD_UUID || ""}`.trim();

  if (branch !== PRODUCTION_BRANCH) {
    // Validates bindings against the account without moving production traffic.
    wrangler(["versions", "upload", "--config", OUT_CONFIG, "--message", message]);
    return;
  }
  // schema.sql is idempotent; run it before the code that depends on it goes live.
  wrangler(["d1", "execute", "DB", "--remote", "--yes", "--file", join(ROOT, "schema.sql"), "--config", OUT_CONFIG]);
  wrangler(["deploy", "--config", OUT_CONFIG, "--message", message]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2];
  if (command === "build") build();
  else if (command === "deploy") deploy();
  else fail("usage: node deploy/cloudflare.mjs <build|deploy>");
}
