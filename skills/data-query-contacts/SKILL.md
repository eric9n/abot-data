---
name: data-query-contacts
description: 'List or look up contacts in abot-data (data.abot.run) by name, alias, or org.'
---
# Query Data contacts

Use the **Data** MCP (`user-Data` → `https://data.abot.run/mcp`).

## Workflow

1. Call `list_contacts` with optional `query` (matches name, aliases, org) and `limit` (default 20, max 100).
2. If the user names a person and list is ambiguous, ask which contact before updating.
3. Present a compact table: name, relation, email/phone if any, Data URL (`https://data.abot.run/ctc/...`).
4. For one id, use `get_contact`. Missing id returns `{ found: false }`.

## Important

Do not dump raw JSON. Never paste MCP tokens into chat.
