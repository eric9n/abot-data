---
name: data-poll-events
description: Poll pending abot-data bus events for a subscription and ack with lease_token.
---
# Poll and ack Data events

Use the **Data** MCP (`user-Data`).

## Workflow

1. Call `poll_events` with `subscription_id`. Optional cursor, limit, visibility_seconds, audience (`bot`/`user`).
2. Process each event; then `ack_event` with that event’s `id` and `lease_token`.
3. `cursor` only pages — unacked events reappear after the lease.
4. Duplicate ack → `idempotent: true`. Wrong token while pending → lease mismatch (`-32602`).

## Important

Paused subscriptions reject poll. Webhook deliveries are separate from bus ack.
