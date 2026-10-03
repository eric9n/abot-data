# Abot Data — Integration Guide

Abot Data is a personal structured data layer for AI agents: calendar, contacts,
notes, and an event bus, exposed via MCP (Model Context Protocol) over
Streamable HTTP.

- Production MCP endpoint: `https://data.abot.run/mcp`
- Health check (public): `https://data.abot.run/health`

## Authentication

Every agent gets its own account, identified by email. Data is isolated per
account: you only see rows that belong to your email (plus system-level rows).

There are two ways to get a token. Both end up with the same kind of token.
OAuth is a generic standard — it is not Muse-specific. Any agent can use it.

### Option A: OAuth 2.0 Authorization Code + PKCE (recommended for interactive clients)

Standard OAuth 2.0 flow (RFC 6749 + RFC 7636). Best when your client can open
a browser for the user.

**Endpoints**

| | |
|---|---|
| Authorize | `https://data.abot.run/oauth/authorize` |
| Token | `https://data.abot.run/oauth/token` |
| Dynamic client registration (RFC 7591) | `https://data.abot.run/oauth/register` |

**Step 0 — Register your client (one time, optional)**

If you don't have a pre-registered `client_id`, register dynamically:

```http
POST https://data.abot.run/oauth/register
Content-Type: application/json

{
  "redirect_uris": ["https://your-app.example.com/oauth/callback"],
  "client_name": "My Agent"
}
```

Response:

```json
{
  "client_id": "dcr_...",
  "client_secret": "...",
  "redirect_uris": ["https://your-app.example.com/oauth/callback"],
  "token_endpoint_auth_method": "client_secret_post"
}
```

Use the returned `client_id`/`client_secret` in the steps below. You can also
skip registration and use any `client_id` string with PKCE (public client),
but then `redirect_uri` must be pre-allowlisted.

**Step 1 — Redirect the user to the authorize URL**

```
https://data.abot.run/oauth/authorize?
  response_type=code
  &client_id=<your-client-id>
  &redirect_uri=<your-callback-url>
  &state=<random-state>
  &code_challenge=<pkce-challenge>
  &code_challenge_method=S256
  &login_hint=<user-email>        # optional: pre-fills the email field
```

- `client_id`: the ID from Step 0, or any string matching
  `[A-Za-z0-9._:-]{1,128}` for public PKCE clients.
- `redirect_uri`: must be an exact match of a URI registered in Step 0
  (or a pre-allowlisted URI).
- `login_hint`: optional. When present, the email field is pre-filled. The
  page shows `client_id` and `redirect_uri` for the user to confirm. A GET
  does not send a verification code and does not issue an authorization code;
  the user submits the form to send the code.

**Step 2 — User verifies email**

The page asks for an email address, sends a 6-digit code (15 minutes valid),
and the user enters it. This proves ownership of the email.

**Step 3 — Handle the callback**

On success the server redirects (302, with an HTML fallback page) to:

```
<redirect_uri>?code=<authorization-code>&state=<state>
```

Verify `state` matches what you sent.

**Step 4 — Exchange the code for a token**

```
POST https://data.abot.run/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<authorization-code>
&redirect_uri=<same-as-step-1>
&client_id=<same-as-step-1>
&code_verifier=<pkce-verifier>
```

Response:

```json
{ "access_token": "ad_<...>", "token_type": "Bearer" }
```

- Codes are single-use and expire after 10 minutes.
- The access token is bound to the verified email. Re-issuing rotates it and
  invalidates the previous one.

### Option B: Manual token via MCP tools (for headless/programmatic agents)

If your agent cannot open a browser (e.g. a background daemon or CLI), call
these MCP tools directly (no Bearer token needed for these two):

1. `request_account_verification` with `{"email": "..."}` — sends a 6-digit
   code to the email (rate-limited: 3/hour per email).
2. `verify_account` with `{"email": "...", "code": "..."}` — returns
   `{"ok": true, "token": "ad_<...>"}`.

The token is shown **once**. Store it securely; never log it or commit it.

## Making MCP calls

```http
POST https://data.abot.run/mcp
Authorization: Bearer ad_<your-token>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "list_contacts",
    "arguments": {}
  }
}
```

- Transport is Streamable HTTP, body is JSON-RPC 2.0.
- Tool results come back in `result.content[0].text` as a JSON string (parse it
  a second time).
- JSON-RPC errors return HTTP 200 with an `error` object; check `error.code`.
- `tools/list` returns all 27 tools with their schemas.
- Protocol version for `initialize`: `2025-06-18`.

Without a token (or with a wrong one) you get HTTP 401, except for
`request_account_verification` and `verify_account` which are public.

## Data isolation

- An `ad_` token only reads/writes rows where `owner_email` equals its own
  email, plus system rows where `owner_email` is null.
- Events: `poll_events` returns your account's events plus system-level events.
  You cannot see other accounts' events.
- Dedupe keys are scoped per account.

## Tool overview

27 tools across: accounts (2), contacts (5), calendar (5), notes (5),
events (4), subscriptions (4), heartbeats (1), plus `tools/list`.

Full schemas: call `tools/list`, or read `skills/abot-data/references/tools.md`
in this repo.

## Rate limits

- Verification emails: 3 per hour per email, 10 per hour per IP.
- Verification codes: 15 minutes valid, 5 wrong attempts lock the code.
