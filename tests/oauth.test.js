import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { handleFetch } from "../src/worker.js";

const TOKEN = "test-data-token";
const RESEND_KEY = "test-resend-key";
const NOW = Date.parse("2026-09-29T04:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const AUTH_CODE_TTL = 10 * 60 * 1000;
const CLIENT = "connector";
const SECRET = "client-secret-value";
const OTHER = "other-app";
const OTHER_SECRET = "other-secret-value";
const REDIRECT = "https://connector.example/callback";
const OTHER_REDIRECT = "https://other.example/callback";
const STATE = "a b&c=d";

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function insertClient(db, { clientId, secret, redirects, name }) {
  const hash = secret == null ? "" : sha256(secret);
  db.prepare(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, redirect_uris, name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(clientId, hash, JSON.stringify(redirects), name, "2026-09-29T04:00:00.000Z");
}

function authorizeUrl(overrides = {}) {
  const params = new URLSearchParams({
    response_type: overrides.response_type ?? "code",
    client_id: overrides.client_id ?? CLIENT,
    redirect_uri: overrides.redirect_uri ?? REDIRECT,
    state: overrides.state ?? STATE,
  });
  if (overrides.scope) params.set("scope", overrides.scope);
  if (Object.hasOwn(overrides, "code_challenge") && overrides.code_challenge != null) {
    params.set("code_challenge", overrides.code_challenge);
  }
  if (Object.hasOwn(overrides, "code_challenge_method") && overrides.code_challenge_method != null) {
    params.set("code_challenge_method", overrides.code_challenge_method);
  }
  return `https://abot-data.test/oauth/authorize?${params}`;
}

// RFC 7636 appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const PUBLIC_CLIENT = "muse";

function mailFetch() {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  return { sent, fetchImpl };
}

function codeFromMail(body) {
  const match = String(body.text).match(/(\d{6})/);
  assert.ok(match, JSON.stringify(body));
  return match[1];
}

async function readJson(res) {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function postAuthorize(env, fields, opts = {}) {
  return handleFetch(
    new Request(opts.url ?? authorizeUrl(opts.query), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": opts.ip ?? "203.0.113.40",
        ...(opts.headers ?? {}),
      },
      body: new URLSearchParams(fields),
    }),
    env,
    { nowMs: opts.nowMs ?? NOW, fetch: opts.fetch },
  );
}

async function exchange(env, fields, opts = {}) {
  const payload = { grant_type: "authorization_code", ...fields };
  const body = opts.form ? new URLSearchParams(payload) : JSON.stringify(payload);
  const res = await handleFetch(
    new Request("https://abot-data.test/oauth/token", {
      method: "POST",
      headers: {
        "content-type": opts.form ? "application/x-www-form-urlencoded" : "application/json",
      },
      body,
    }),
    env,
    { nowMs: opts.nowMs ?? NOW },
  );
  return readJson(res);
}

async function sendCode(env, email, opts = {}) {
  const { sent, fetchImpl } = mailFetch();
  const res = await postAuthorize(env, { action: "send", email }, { ...opts, fetch: fetchImpl });
  const html = await res.text();
  return { status: res.status, html, sent };
}

async function issueAuthCode(env, email, opts = {}) {
  const sent = await sendCode(env, email, opts);
  assert.equal(sent.status, 200, sent.html);
  const emailCode = codeFromMail(sent.sent[0]);
  assert.equal(sent.html.includes(emailCode), false);
  const res = await postAuthorize(
    env,
    { action: "verify", email, code: emailCode },
    { nowMs: opts.nowMs ?? NOW, ip: opts.ip, url: opts.url, query: opts.query },
  );
  assert.equal(res.status, 302, await res.text());
  const location = new URL(res.headers.get("location"));
  return { emailCode, code: location.searchParams.get("code"), location };
}

async function mcp(env, name, args, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token === undefined ? TOKEN : opts.token}`;
  const res = await handleFetch(
    new Request("https://abot-data.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args ?? {} },
      }),
    }),
    env,
    { nowMs: opts.nowMs ?? NOW, fetch: opts.fetch },
  );
  return readJson(res);
}

test("oauth tables reapply and keep inserted clients", () => {
  const sql = schemaSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_clients \([\s\S]*client_id TEXT PRIMARY KEY/);
  assert.match(sql, /client_secret_hash TEXT NOT NULL/);
  assert.match(sql, /redirect_uris TEXT NOT NULL/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS oauth_codes \([\s\S]*code_hash TEXT PRIMARY KEY/);
  assert.match(sql, /used_at TEXT/);
  assert.match(sql, /code_challenge TEXT/);
  assert.equal(/\bcode_challenge TEXT NOT NULL\b/.test(sql), false);
  assert.equal(/\bdrop\s+table\b/i.test(sql), false);
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  db.exec(sql);
  insertClient(db, { clientId: CLIENT, secret: SECRET, redirects: [REDIRECT], name: "Connector" });
  db.exec(sql);
  const row = db.prepare("SELECT client_id, redirect_uris FROM oauth_clients").get();
  assert.equal(row.client_id, CLIENT);
  assert.deepEqual(JSON.parse(row.redirect_uris), [REDIRECT]);
  assert.equal(db.prepare("SELECT name FROM pragma_table_info('oauth_codes') WHERE name = 'code'").get(), undefined);
});

test("authorize rejects a redirect_uri that is not an exact registered match", async () => {
  const { db, env } = sqliteEnv();
  insertClient(db, {
    clientId: CLIENT,
    secret: SECRET,
    redirects: [REDIRECT, "https://connector.example/alt"],
    name: "Connector",
  });

  const evil = await readJson(await handleFetch(new Request(authorizeUrl({ redirect_uri: "https://evil.example/callback" })), env));
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.get("location"), null);
  assert.deepEqual(evil.body.error, { code: -32602, message: "redirect_uri mismatch" });

  const slash = await readJson(await handleFetch(new Request(authorizeUrl({ redirect_uri: `${REDIRECT}/` })), env));
  assert.equal(slash.status, 400);
  assert.deepEqual(slash.body.error, { code: -32602, message: "redirect_uri mismatch" });

  const query = await readJson(
    await handleFetch(new Request(authorizeUrl({ redirect_uri: `${REDIRECT}?next=1` })), env),
  );
  assert.equal(query.status, 400);
  assert.deepEqual(query.body.error, { code: -32602, message: "redirect_uri mismatch" });

  const unknown = await readJson(await handleFetch(new Request(authorizeUrl({ client_id: "missing" })), env));
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body.error, { code: -32602, message: "unknown client_id" });

  const tokenType = await readJson(await handleFetch(new Request(authorizeUrl({ response_type: "token" })), env));
  assert.equal(tokenType.status, 400);
  assert.equal(tokenType.body.error.code, -32602);

  const page = await handleFetch(new Request(authorizeUrl({ scope: "email", state: "<script>" })), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(html, /发送验证码/);
  assert.match(html, /验证并继续/);
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;|%3Cscript%3E/);
});

test("oauth codes reject misuse, expiry, and reuse", async () => {
  const { db, env } = sqliteEnv();
  insertClient(db, { clientId: CLIENT, secret: SECRET, redirects: [REDIRECT], name: "Connector" });
  insertClient(db, { clientId: OTHER, secret: OTHER_SECRET, redirects: [OTHER_REDIRECT], name: "Other" });

  const issued = await issueAuthCode(env, "ada@example.com", { ip: "203.0.113.50" });
  assert.match(issued.code, /^[0-9a-f]{64}$/);
  const stored = db.prepare("SELECT code_hash, client_id, redirect_uri, email, used_at FROM oauth_codes").get();
  assert.equal(stored.code_hash, sha256(issued.code));
  assert.equal(stored.client_id, CLIENT);
  assert.equal(stored.redirect_uri, REDIRECT);
  assert.equal(stored.email, "ada@example.com");
  assert.equal(stored.used_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_codes").get().n, 0);

  const wrongRedirect = await exchange(env, {
    code: issued.code,
    redirect_uri: "https://connector.example/alt",
    client_id: CLIENT,
    client_secret: SECRET,
  });
  assert.equal(wrongRedirect.status, 400);
  assert.deepEqual(wrongRedirect.body.error, { code: -32602, message: "redirect_uri mismatch" });

  const wrongClient = await exchange(env, {
    code: issued.code,
    redirect_uri: OTHER_REDIRECT,
    client_id: OTHER,
    client_secret: OTHER_SECRET,
  });
  assert.equal(wrongClient.status, 400);
  assert.deepEqual(wrongClient.body.error, { code: -32602, message: "authorization code mismatch" });

  const wrongSecret = await exchange(env, {
    code: issued.code,
    redirect_uri: REDIRECT,
    client_id: CLIENT,
    client_secret: "nope",
  });
  assert.equal(wrongSecret.status, 400);
  assert.deepEqual(wrongSecret.body.error, { code: -32602, message: "invalid client_secret" });
  assert.equal(db.prepare("SELECT used_at FROM oauth_codes WHERE email = 'ada@example.com'").get().used_at, null);

  const expired = await exchange(
    env,
    { code: issued.code, redirect_uri: REDIRECT, client_id: CLIENT, client_secret: SECRET },
    { nowMs: NOW + AUTH_CODE_TTL },
  );
  assert.equal(expired.status, 400);
  assert.deepEqual(expired.body.error, { code: -32602, message: "authorization code expired" });
  assert.equal(db.prepare("SELECT used_at FROM oauth_codes WHERE email = 'ada@example.com'").get().used_at, null);

  const fresh = await issueAuthCode(env, "bea@example.com", { ip: "203.0.113.51", nowMs: NOW + 1000 });
  const ok = await exchange(
    env,
    { code: fresh.code, redirect_uri: REDIRECT, client_id: CLIENT, client_secret: SECRET },
    { nowMs: NOW + 1000, form: true },
  );
  assert.equal(ok.status, 200);
  assert.match(ok.body.access_token, /^ad_[0-9a-f]{32}$/);
  assert.equal(ok.body.token_type, "Bearer");
  const again = await exchange(
    env,
    { code: fresh.code, redirect_uri: REDIRECT, client_id: CLIENT, client_secret: SECRET },
    { nowMs: NOW + 1000 },
  );
  assert.equal(again.status, 400);
  assert.deepEqual(again.body.error, { code: -32602, message: "authorization code already used" });
  assert.ok(db.prepare("SELECT used_at FROM oauth_codes WHERE email = 'bea@example.com'").get().used_at);
  assert.equal(db.prepare("SELECT token_hash FROM accounts WHERE email = 'bea@example.com'").get().token_hash, sha256(ok.body.access_token));
});

test("oauth authorization-code happy path returns the account token", async () => {
  const { db, env } = sqliteEnv();
  insertClient(db, { clientId: CLIENT, secret: SECRET, redirects: [REDIRECT], name: "Connector" });

  const firstMail = mailFetch();
  const requested = await mcp(env, "request_account_verification", { email: "ada@example.com" }, {
    token: null,
    fetch: firstMail.fetchImpl,
  });
  assert.equal(requested.status, 200);
  const previousCode = codeFromMail(firstMail.sent[0]);
  const verified = await mcp(env, "verify_account", { email: "ada@example.com", code: previousCode }, { token: null });
  const previousToken = JSON.parse(verified.body.result.content[0].text).token;
  assert.match(previousToken, /^ad_[0-9a-f]{32}$/);

  const page = await handleFetch(new Request(authorizeUrl({ scope: "email" })), env, { nowMs: NOW });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /name="email"/);

  const sent = await sendCode(env, "Ada@Example.com", { ip: "203.0.113.60", nowMs: NOW + 1000 });
  assert.equal(sent.status, 200);
  assert.match(sent.html, /验证码已发送/);
  assert.match(sent.html, /value="ada@example.com"/);
  const emailCode = codeFromMail(sent.sent[0]);
  assert.equal(sent.html.includes(emailCode), false);

  const wrong = await postAuthorize(
    env,
    { action: "verify", email: "ada@example.com", code: emailCode === "000000" ? "000001" : "000000" },
    { ip: "203.0.113.60", nowMs: NOW + 1000 },
  );
  assert.equal(wrong.status, 400);
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /invalid verification code/);
  assert.equal(db.prepare("SELECT attempts FROM verification_codes").get().attempts, 1);

  const verifiedPage = await postAuthorize(
    env,
    { action: "verify", email: "ada@example.com", code: emailCode },
    { ip: "203.0.113.60", nowMs: NOW + 1000 },
  );
  assert.equal(verifiedPage.status, 302);
  const location = new URL(verifiedPage.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get("state"), STATE);
  const code = location.searchParams.get("code");
  assert.match(code, /^[0-9a-f]{64}$/);
  assert.notEqual(code, emailCode);
  assert.equal(db.prepare("SELECT code_hash FROM oauth_codes").get().code_hash, sha256(code));
  assert.equal(db.prepare("SELECT code_challenge FROM oauth_codes").get().code_challenge, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_codes").get().n, 0);

  const token = await exchange(
    env,
    { code, redirect_uri: REDIRECT, client_id: CLIENT, client_secret: SECRET },
    { nowMs: NOW + 1000 },
  );
  assert.equal(token.status, 200);
  assert.deepEqual(Object.keys(token.body).sort(), ["access_token", "token_type"]);
  assert.equal(token.body.token_type, "Bearer");
  assert.match(token.body.access_token, /^ad_[0-9a-f]{32}$/);
  assert.notEqual(token.body.access_token, previousToken);
  assert.equal(
    db.prepare("SELECT token_hash FROM accounts WHERE email = 'ada@example.com'").get().token_hash,
    sha256(token.body.access_token),
  );
  assert.ok(db.prepare("SELECT used_at FROM oauth_codes").get().used_at);

  const stale = await mcp(env, "list_contacts", {}, { token: previousToken, nowMs: NOW + 1000 });
  assert.equal(stale.status, 401);
  const listed = await mcp(env, "list_contacts", {}, { token: token.body.access_token, nowMs: NOW + 1000 });
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.body.result.content[0].text), []);

  const justBefore = await issueAuthCode(env, "bea@example.com", { ip: "203.0.113.61", nowMs: NOW + 2000 });
  const stillValid = await exchange(
    env,
    { code: justBefore.code, redirect_uri: REDIRECT, client_id: CLIENT, client_secret: SECRET },
    { nowMs: NOW + 2000 + AUTH_CODE_TTL - 1 },
  );
  assert.equal(stillValid.status, 200, JSON.stringify(stillValid.body));
});

test("authorize shows the client and callback, and login_hint does not send a code", async () => {
  const { db, env } = sqliteEnv();
  insertClient(db, { clientId: CLIENT, secret: SECRET, redirects: [REDIRECT], name: "Connector" });
  const { sent, fetchImpl } = mailFetch();
  const url = `${authorizeUrl()}&login_hint=Ada@Example.com`;
  const res = await handleFetch(new Request(url), env, { nowMs: NOW, fetch: fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
  const html = await res.text();
  assert.match(html, /<dt>客户端<\/dt>/);
  assert.match(html, /<dt>回调地址<\/dt>/);
  assert.match(html, new RegExp(`<code>${CLIENT}</code>`));
  assert.match(html, new RegExp(`<code>${REDIRECT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</code>`));
  assert.match(html, /value="ada@example.com"/);
  assert.doesNotMatch(html, /验证码已发送/);
  assert.equal(sent.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_codes").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get().n, 0);
});

test("oauth send reuses the verification rate limit", async () => {
  const { db, env } = sqliteEnv();
  insertClient(db, { clientId: CLIENT, secret: SECRET, redirects: [REDIRECT], name: "Connector" });
  for (let i = 0; i < 3; i++) {
    const sent = await sendCode(env, "ada@example.com", { ip: "203.0.113.70", nowMs: NOW + i });
    assert.equal(sent.status, 200, sent.html);
  }
  const blocked = await sendCode(env, "ada@example.com", { ip: "203.0.113.70", nowMs: NOW + 3 });
  assert.equal(blocked.status, 400);
  assert.match(blocked.html, /too many verification requests/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM verification_requests").get().n, 3);

  const later = await sendCode(env, "ada@example.com", { ip: "203.0.113.70", nowMs: NOW + HOUR + 1 });
  assert.equal(later.status, 200, later.html);
});

test("pkce test vector is the RFC 7636 S256 example", () => {
  assert.equal(createHash("sha256").update(VERIFIER).digest("base64url"), CHALLENGE);
});

test("pkce S256 happy path issues a token without client_secret", async () => {
  const { db, env } = sqliteEnv();
  db.exec("ALTER TABLE oauth_codes DROP COLUMN code_challenge");
  insertClient(db, { clientId: PUBLIC_CLIENT, secret: null, redirects: [REDIRECT], name: "Muse" });
  assert.equal(db.prepare("SELECT name FROM pragma_table_info('oauth_codes') WHERE name = 'code_challenge'").get(), undefined);

  const query = {
    client_id: PUBLIC_CLIENT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  };
  const page = await handleFetch(new Request(authorizeUrl(query)), env, { nowMs: NOW });
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM/);
  assert.match(pageHtml, /code_challenge_method=S256/);

  const sent = await sendCode(env, "Ada@Example.com", { ip: "203.0.113.80", query });
  assert.equal(sent.status, 200, sent.html);
  assert.match(sent.html, /code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM/);
  assert.match(sent.html, /value="ada@example.com"/);
  const emailCode = codeFromMail(sent.sent[0]);
  assert.equal(sent.html.includes(emailCode), false);

  const verified = await postAuthorize(
    env,
    { action: "verify", email: "ada@example.com", code: emailCode },
    { ip: "203.0.113.80", query },
  );
  assert.equal(verified.status, 302, await verified.clone().text());
  const location = new URL(verified.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get("state"), STATE);
  assert.equal(location.searchParams.get("code_challenge"), null);
  const code = location.searchParams.get("code");
  assert.match(code, /^[0-9a-f]{64}$/);
  const stored = db.prepare("SELECT code_challenge, used_at, email FROM oauth_codes").get();
  assert.equal(stored.code_challenge, CHALLENGE);
  assert.equal(stored.used_at, null);
  assert.equal(stored.email, "ada@example.com");
  assert.equal(
    db.prepare("SELECT name FROM pragma_table_info('oauth_codes') WHERE name = 'code_challenge'").get().name,
    "code_challenge",
  );

  const token = await exchange(
    env,
    { code, redirect_uri: REDIRECT, client_id: PUBLIC_CLIENT, code_verifier: VERIFIER },
    { form: true },
  );
  assert.equal(token.status, 200, JSON.stringify(token.body));
  assert.deepEqual(Object.keys(token.body).sort(), ["access_token", "token_type"]);
  assert.equal(token.body.token_type, "Bearer");
  assert.match(token.body.access_token, /^ad_[0-9a-f]{32}$/);
  const listed = await mcp(env, "list_contacts", {}, { token: token.body.access_token });
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.body.result.content[0].text), []);

  const again = await exchange(env, {
    code,
    redirect_uri: REDIRECT,
    client_id: PUBLIC_CLIENT,
    code_verifier: VERIFIER,
  });
  assert.equal(again.status, 400);
  assert.deepEqual(again.body.error, { code: -32602, message: "authorization code already used" });
});

test("pkce rejects a wrong or missing code_verifier without consuming the code", async () => {
  const { db, env } = sqliteEnv();
  insertClient(db, { clientId: PUBLIC_CLIENT, secret: null, redirects: [REDIRECT], name: "Muse" });
  const query = {
    client_id: PUBLIC_CLIENT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  };
  const issued = await issueAuthCode(env, "ada@example.com", { ip: "203.0.113.81", query });

  const wrong = await exchange(env, {
    code: issued.code,
    redirect_uri: REDIRECT,
    client_id: PUBLIC_CLIENT,
    code_verifier: `${VERIFIER.slice(0, -1)}a`,
  });
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body.error, { code: -32602, message: "invalid code_verifier" });
  assert.equal(db.prepare("SELECT used_at FROM oauth_codes").get().used_at, null);

  const missing = await exchange(env, {
    code: issued.code,
    redirect_uri: REDIRECT,
    client_id: PUBLIC_CLIENT,
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.error, { code: -32602, message: "code_verifier is required" });
  assert.equal(db.prepare("SELECT used_at FROM oauth_codes").get().used_at, null);

  const short = await exchange(env, {
    code: issued.code,
    redirect_uri: REDIRECT,
    client_id: PUBLIC_CLIENT,
    code_verifier: "too-short",
  });
  assert.equal(short.status, 400);
  assert.deepEqual(short.body.error, { code: -32602, message: "invalid code_verifier" });
  assert.equal(db.prepare("SELECT used_at FROM oauth_codes").get().used_at, null);

  const ok = await exchange(env, {
    code: issued.code,
    redirect_uri: REDIRECT,
    client_id: PUBLIC_CLIENT,
    code_verifier: VERIFIER,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("authorize rejects a missing challenge or a non-S256 method", async () => {
  const { db, env } = sqliteEnv();
  insertClient(db, { clientId: PUBLIC_CLIENT, secret: null, redirects: [REDIRECT], name: "Muse" });
  insertClient(db, { clientId: CLIENT, secret: SECRET, redirects: [REDIRECT], name: "Connector" });

  const publicMissing = await readJson(await handleFetch(new Request(authorizeUrl({ client_id: PUBLIC_CLIENT })), env));
  assert.equal(publicMissing.status, 400);
  assert.deepEqual(publicMissing.body.error, { code: -32602, message: "code_challenge is required" });

  const plain = await readJson(
    await handleFetch(new Request(authorizeUrl({ code_challenge: CHALLENGE, code_challenge_method: "plain" })), env),
  );
  assert.equal(plain.status, 400);
  assert.deepEqual(plain.body.error, { code: -32602, message: "code_challenge_method must be S256" });

  const noMethod = await readJson(await handleFetch(new Request(authorizeUrl({ code_challenge: CHALLENGE })), env));
  assert.equal(noMethod.status, 400);
  assert.deepEqual(noMethod.body.error, { code: -32602, message: "code_challenge_method must be S256" });

  const methodOnly = await readJson(await handleFetch(new Request(authorizeUrl({ code_challenge_method: "S256" })), env));
  assert.equal(methodOnly.status, 400);
  assert.deepEqual(methodOnly.body.error, { code: -32602, message: "code_challenge is required" });

  const plainOnly = await readJson(await handleFetch(new Request(authorizeUrl({ code_challenge_method: "plain" })), env));
  assert.equal(plainOnly.status, 400);
  assert.deepEqual(plainOnly.body.error, { code: -32602, message: "code_challenge_method must be S256" });

  const badChallenge = await readJson(
    await handleFetch(new Request(authorizeUrl({ code_challenge: "not-a-challenge", code_challenge_method: "S256" })), env),
  );
  assert.equal(badChallenge.status, 400);
  assert.deepEqual(badChallenge.body.error, { code: -32602, message: "code_challenge is invalid" });

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get().n, 0);
  const secretPage = await handleFetch(new Request(authorizeUrl()), env);
  assert.equal(secretPage.status, 200);
});

test("confidential client pkce still requires client_secret", async () => {
  const { db, env } = sqliteEnv();
  insertClient(db, { clientId: CLIENT, secret: SECRET, redirects: [REDIRECT], name: "Connector" });
  const query = { code_challenge: CHALLENGE, code_challenge_method: "S256" };
  const issued = await issueAuthCode(env, "ada@example.com", { ip: "203.0.113.82", query });
  assert.equal(db.prepare("SELECT code_challenge FROM oauth_codes").get().code_challenge, CHALLENGE);

  const noSecret = await exchange(env, {
    code: issued.code,
    redirect_uri: REDIRECT,
    client_id: CLIENT,
    code_verifier: VERIFIER,
  });
  assert.equal(noSecret.status, 400);
  assert.deepEqual(noSecret.body.error, { code: -32602, message: "client_secret is required" });
  assert.equal(db.prepare("SELECT used_at FROM oauth_codes").get().used_at, null);

  const wrongSecret = await exchange(env, {
    code: issued.code,
    redirect_uri: REDIRECT,
    client_id: CLIENT,
    client_secret: "nope",
    code_verifier: VERIFIER,
  });
  assert.equal(wrongSecret.status, 400);
  assert.deepEqual(wrongSecret.body.error, { code: -32602, message: "invalid client_secret" });
  assert.equal(db.prepare("SELECT used_at FROM oauth_codes").get().used_at, null);

  const verifierWithoutSecretCheck = await exchange(env, {
    code: issued.code,
    redirect_uri: REDIRECT,
    client_id: CLIENT,
    client_secret: SECRET,
    code_verifier: `${VERIFIER.slice(0, -1)}b`,
  });
  assert.equal(verifierWithoutSecretCheck.status, 400);
  assert.deepEqual(verifierWithoutSecretCheck.body.error, { code: -32602, message: "invalid code_verifier" });
  assert.equal(db.prepare("SELECT used_at FROM oauth_codes").get().used_at, null);

  const ok = await exchange(env, {
    code: issued.code,
    redirect_uri: REDIRECT,
    client_id: CLIENT,
    client_secret: SECRET,
    code_verifier: VERIFIER,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.access_token, /^ad_[0-9a-f]{32}$/);
});

test("the consent page cannot be framed and rejects cross-site posts", async () => {
  const { db, env } = sqliteEnv();
  insertClient(db, { clientId: CLIENT, secret: SECRET, redirects: [REDIRECT], name: "Evil <b>Corp</b>" });
  const page = await handleFetch(new Request(authorizeUrl()), env, { nowMs: NOW });
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const body = await page.text();
  assert.match(body, /Evil &lt;b&gt;Corp&lt;\/b&gt;/);
  assert.match(body, new RegExp(`<strong>${new URL(REDIRECT).host.replace(/\./g, "\\.")}</strong>`));

  const { sent, fetchImpl } = mailFetch();
  for (const headers of [
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { origin: "https://evil.example" },
  ]) {
    const res = await postAuthorize(env, { action: "send", email: "ada@example.com" }, { headers, fetch: fetchImpl });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.match(await res.text(), /cross-site request rejected/);
  }
  assert.equal(sent.length, 0);
  for (const headers of [{ "sec-fetch-site": "same-origin", origin: "null" }, { origin: "https://abot-data.test" }]) {
    const ok = await postAuthorize(env, { action: "send", email: "ada@example.com" }, { headers, fetch: fetchImpl });
    assert.equal(ok.status, 200, JSON.stringify(headers));
  }
  env.PUBLIC_ORIGIN = "https://abot.run/data";
  const viaGateway = await postAuthorize(
    env,
    { action: "send", email: "bea@example.com" },
    { url: authorizeUrl().replace("https://abot-data.test", "https://backend.internal"), headers: { origin: "https://abot.run" }, fetch: fetchImpl },
  );
  assert.equal(viaGateway.status, 200);
});

test("dynamic client registration is limited per IP", async () => {
  const { db, env } = sqliteEnv();
  const register = (ip) =>
    handleFetch(
      new Request("https://abot-data.test/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ client_name: "x", redirect_uris: ["https://client.example/cb"] }),
      }),
      env,
      { nowMs: NOW },
    );
  for (let i = 0; i < 10; i++) assert.equal((await register("198.51.100.1")).status, 200);
  const blocked = await readJson(await register("198.51.100.1"));
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.message, "too many client registrations");
  assert.equal((await register("198.51.100.2")).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get().n, 11);
});
