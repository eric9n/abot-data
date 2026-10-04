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

const TABLE_RE = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
const TABLE_CONSTRAINT = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i;

/** Column definitions per table, as written in schema.sql. */
export function schemaColumns(sql) {
  const tables = new Map();
  for (const [, table, body] of sql.matchAll(TABLE_RE)) {
    const columns = [];
    for (const raw of body.split("\n")) {
      const line = raw.replace(/--.*$/, "").trim().replace(/,$/, "");
      if (!line || TABLE_CONSTRAINT.test(line)) continue;
      const name = line.match(/^(\w+)\s/);
      if (name) columns.push({ name: name[1], def: line });
    }
    tables.set(table, columns);
  }
  return tables;
}

/**
 * ALTER statements for columns schema.sql declares but a live table lacks.
 * `CREATE TABLE IF NOT EXISTS` never changes an existing table, and the
 * indexes after it fail on a missing column. Tables that do not exist yet are
 * left to schema.sql. A column SQLite cannot add in place stops the deploy.
 */
export function missingColumnStatements(sql, live) {
  const have = new Map();
  for (const { tbl, col } of live) {
    if (!have.has(tbl)) have.set(tbl, new Set());
    have.get(tbl).add(col);
  }
  const out = [];
  for (const [table, columns] of schemaColumns(sql)) {
    const present = have.get(table);
    if (!present) continue;
    for (const { name, def } of columns) {
      if (present.has(name)) continue;
      const upper = def.toUpperCase();
      if (/\b(PRIMARY KEY|UNIQUE)\b/.test(upper) || (/\bNOT NULL\b/.test(upper) && !/\bDEFAULT\b/.test(upper))) {
        throw new Error(`${table}.${name} is missing and cannot be added in place: ${def}`);
      }
      out.push(`ALTER TABLE ${table} ADD COLUMN ${def};`);
    }
  }
  return out;
}

/**
 * Live columns of the tables schema.sql owns. D1 refuses pragma_table_info on
 * its internal _cf_KV table (SQLITE_AUTH), so this cannot join sqlite_master,
 * and it caps compound SELECTs, so it cannot UNION one SELECT per table.
 */
export function liveColumnsSql(sql) {
  const tables = JSON.stringify([...schemaColumns(sql).keys()]);
  return `SELECT j.value AS tbl, p.name AS col FROM json_each('${tables}') j JOIN pragma_table_info(j.value) p`;
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

function wranglerJson(args) {
  console.log(`$ wrangler ${args.join(" ")}`);
  const res = spawnSync(WRANGLER, args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (res.status !== 0) fail(`wrangler ${args[0]} failed (exit ${res.status ?? res.signal})`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    fail(`wrangler ${args[0]} did not print JSON`);
  }
}

function migrateColumns() {
  const d1 = ["d1", "execute", "DB", "--remote", "--yes", "--config", OUT_CONFIG];
  const schema = readFileSync(join(ROOT, "schema.sql"), "utf8");
  const out = wranglerJson([...d1, "--json", "--command", liveColumnsSql(schema)]);
  const live = (Array.isArray(out) ? out : [out]).flatMap((r) => (r && r.results) || []);
  let statements;
  try {
    statements = missingColumnStatements(schema, live);
  } catch (err) {
    fail(err.message);
  }
  for (const statement of statements) wrangler([...d1, "--command", statement]);
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
  // Both steps are idempotent and run before the code that depends on them goes live.
  migrateColumns();
  wrangler(["d1", "execute", "DB", "--remote", "--yes", "--file", join(ROOT, "schema.sql"), "--config", OUT_CONFIG]);
  wrangler(["deploy", "--config", OUT_CONFIG, "--message", message]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2];
  if (command === "build") build();
  else if (command === "deploy") deploy();
  else fail("usage: node deploy/cloudflare.mjs <build|deploy>");
}
