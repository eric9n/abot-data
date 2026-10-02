---
name: data-query-notes
description: List or search notes in abot-data by tag or title/body query.
---
# Query Data notes

Use the **Data** MCP (`user-Data`).

## Workflow

1. Prefer `list_notes` with a single `tag` when the user names a collection (e.g. `家庭病历`). One call = one tag; tags on a note are an array, but the filter is singular.
2. Or use `query` for title/body LIKE search. Combine with `limit` (default 20, max 100).
3. Need AND across multiple tags? Pull by the strongest tag, then filter locally.
4. Render readable cards: title, date/severity if in body, linked contacts, note URL. Avoid raw JSON dumps.

## Important

There is no Notion-style database name. Partition with tags and resource type.
