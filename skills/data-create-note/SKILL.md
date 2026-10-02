---
name: data-create-note
description: 'Create a note in abot-data with optional title, body, tags, and links.'
---
# Create Data note

Use the **Data** MCP (`user-Data`).

## Workflow

1. Gather optional title, body, tags (string array), links (URLs to contacts/pages).
2. For mirrored domains, always include a stable collection tag (e.g. `家庭病历`) plus type tags.
3. Call `create_note` with `created_by: "bot:main"` when the bot authors it.
4. Confirm title, id (`note_…`), tags, and URL.

## Important

`tags`/`links` on update replace the whole array. Never put secrets in body.
