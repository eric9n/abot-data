---
name: data-create-calendar-event
description: >-
  Create a calendar event in abot-data with start/end times and optional
  reminders.
---
# Create Data calendar event

Use the **Data** MCP (`user-Data`).

## Workflow

1. Require title, `start_utc`, `end_utc` (end after start). Optional timezone (default Asia/Shanghai), all_day, repeat, attendees, reminders, location, notes.
2. Call `create_event` with `created_by: "bot:main"` when the bot writes it.
3. Confirm title, local times, id (`cal_…`), URL.
4. To cancel later, use `delete_event` (soft cancel) or `update_event` status — not a hard delete.

## Important

Due reminders come from the service as bus `calendar.due` via webhook/poll; do not `emit_event` that type yourself.
