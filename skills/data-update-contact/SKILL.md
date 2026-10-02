---
name: data-update-contact
description: Update an existing abot-data contact by id; aliases replace the whole list.
---
# Update Data contact

Use the **Data** MCP (`user-Data`).

## Workflow

1. Resolve the contact id (`ctc_…`) via list/get if the user only gave a name.
2. Call `update_contact` with only fields to change. `aliases` replaces the whole array.
3. Confirm what changed and the contact URL.

## Important

Missing id on update → `-32602`. Prefer confirm before hard `delete_contact`.
