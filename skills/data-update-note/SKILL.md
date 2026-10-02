---
name: data-update-note
description: Update an existing abot-data note by id; tags and links replace whole arrays.
---
# Update Data note

Use the **Data** MCP (`user-Data`).

## Workflow

1. Resolve note id (`note_…`) if needed via `list_notes` / `get_note`.
2. Call `update_note` with fields to change. `tags` and `links` replace the whole arrays.
3. Confirm title/tags and URL.

## Important

Missing id on update → `-32602`. Prefer confirm before hard `delete_note`.
