---
name: data-query-calendar
description: List calendar events in abot-data that overlap a UTC time window.
---
# Query Data calendar

Use the **Data** MCP (`user-Data`). These are calendar rows (`cal_…`), not bus events.

## Workflow

1. Require a time window: `list_events` needs `start_utc` and `end_utc` (UTC ISO8601). Default timezone for creates is Asia/Shanghai; convert for the user.
2. Optional `status`: `confirmed` or `cancelled`; omit for both.
3. Present title, local time range, location, status, URL.
4. Single id → `get_event` (includes cancelled).

## Important

Overlaps the half-open window `[start_utc, end_utc)`. Do not confuse with `poll_events` / `calendar.due`.
