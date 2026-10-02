---
name: data-emit-event
description: >-
  Emit an event on the abot-data bus with type, dedupe_key, and optional
  payload.
---
# Emit Data bus event

Use the **Data** MCP (`user-Data`).

## Workflow

1. Require `type` (`xxx.yyy`) and `dedupe_key`. Optional payload object, `not_before`, `audience` (`bot` default / `user`).
2. Call `emit_event`. New insert fans out to matching webhooks; duplicate pending key returns same id with `created: false` and does not fan out again.
3. Confirm type, id (`evt_…`), and whether it was newly created.

## Important

Never emit `watchdog.*` or `calendar.due`. No secrets in payload. Dedupe key charset `A-Za-z0-9:._-`, length 1–200.
