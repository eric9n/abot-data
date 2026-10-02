---
name: data-create-subscription
description: Create a poll or webhook subscription on the abot-data event bus.
---
# Create Data webhook subscription

Use the **Data** MCP (`user-Data`). Prefer webhook over timed poll for due wakeups.

## Workflow

1. Mode `webhook` needs an https `url` (e.g. a Grok Bot routine webhook URL). Mode `poll` must not pass url/bearer.
2. Set `event_types` explicitly when needed (default is often `watchdog.*` + `calendar.*` only).
3. Auth: omit `bearer_token` → HMAC (secret returned **once**); or pass subscriber `bearer_token` (never echoed; ≠ MCP token).
4. Tell the user the subscription id and auth mode. Surface the HMAC secret only if they must store it — prefer a one-time secure handoff, never Notion/git/chat logs.

## Important

Do not schedule a cron to poll Data when a webhook subscription + routine already covers the need.
