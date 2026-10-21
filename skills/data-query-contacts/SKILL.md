---
name: data-query-contacts
description: 'List or look up contacts in abot-data (abot.run/data) by name, alias, or org.'
---
# Query Data contacts

Use the **Data** MCP (`user-Data` → `https://abot.run/data/mcp`).

## Workflow

1. Call `list_contacts` with optional `query` (matches name, aliases, org), optional `phone` (last 11 digits, +86/spaces/dashes ignored) and `limit` (default 20, max 100).
2. If the user names a person and list is ambiguous, ask which contact before updating.
3. Present a compact table: name, relation, email/phone if any, Data URL (`https://abot.run/data/ctc/...`).
4. For one id, use `get_contact`. Missing id returns `{ found: false }`.

## Important

Do not dump raw JSON. Never paste MCP tokens into chat.
