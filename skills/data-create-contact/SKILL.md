---
name: data-create-contact
description: >-
  Create a new contact in abot-data with name and optional email, phone,
  relation, notes.
---
# Create Data contact

Use the **Data** MCP (`user-Data`).

## Workflow

1. Parse name (required) plus optional aliases, org, title, email, phone, relation, notes.
2. Call `create_contact` with `created_by: "bot:main"` when the bot writes it.
3. Confirm with name, id (`ctc_…`), and URL.

## Important

Do not invent emails or phones. Schema-extra fields cause `-32602`.
