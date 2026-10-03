---
name: data
description: >-
  读写 abot 的联系人、日历、笔记、事件总线、订阅或心跳时使用。经网关 abot.run，
  用 abot-mcp CLI 调用 Data MCP。参数以 references/tools.md 为准。
---

# data

## 服务简介

abot-data 是 bot 的个人结构化数据层，跑在 Cloudflare Workers + D1 上，对外以 MCP（Streamable HTTP，JSON-RPC 2.0）提供服务。Worker 里的服务名是 `abot-data-mcp`。日历、通讯录和笔记是 bot 自己的数据；事件总线用 `audience`（`bot` 或 `user`）区分受众。

| 资源 | 内容 | id 前缀 |
|------|------|---------|
| contacts | 联系人 | `ctc_` |
| calendar | 日历事件（不是总线事件） | `cal_` |
| notes | 笔记 | `note_` |
| events | 事件总线 | `evt_` |
| subscriptions | poll 或 webhook 订阅 | `sub_` |
| heartbeats | agent 报到，不修改事件 | — |
| accounts | 邮箱验证开户的两个公开工具 | — |

账户调用只看到 `owner_email` 等于自己的行，以及 `owner_email` 为空的系统行。工具名、中文描述和参数见 [references/tools.md](references/tools.md)。每个工具的 `additionalProperties` 都是 `false`，参数表以外的字段会被拒绝。

## 认证

经网关 **abot.run**，用 **abot-mcp** CLI 调用，服务名是 `data`。

网关通过 Service Binding 进入本 Worker，并带上 `X-Abot-Owner-Email`。该头是合法邮箱时，这次调用按该账户隔离数据（`src/worker.js` 的 `bindingOwnerIdentity`）。同时出现的 `Authorization` 不改这个身份；`X-Internal-Token` 不参与判定。

日常读写使用网关已经绑定的账户。`request_account_verification` 与 `verify_account` 是直连 MCP 的开户工具，返回的 `ad_` token 只出现一次；本 skill 的调用路径不申请、不打印该 token，也不把 `DATA_MCP_TOKEN`、webhook secret 或订阅 `bearer_token` 写进命令、聊天或仓库。

## 使用示例

最后一个参数是工具的 JSON 参数，字段以 [references/tools.md](references/tools.md) 为准，带 `*` 的必填。

列出联系人（`query` 匹配 name、aliases、org）：

```bash
abot-mcp --gateway https://abot.run data list_contacts '{"query":"Ada","limit":20}'
```

新建联系人：

```bash
abot-mcp --gateway https://abot.run data create_contact '{"name":"Ada Lovelace","email":"ada@example.com","created_by":"bot:main"}'
```

列出与 `[start_utc, end_utc)` 重叠的日历：

```bash
abot-mcp --gateway https://abot.run data list_events '{"start_utc":"2026-10-03T00:00:00Z","end_utc":"2026-10-04T00:00:00Z"}'
```

写入一条用户侧总线事件。源码会拒绝 `watchdog.*` 和 `calendar.due`：

```bash
abot-mcp --gateway https://abot.run data emit_event '{"type":"reminder.medication","dedupe_key":"reminder.medication:2026-10-03","audience":"user"}'
```

认领订阅上的 pending 事件，再用 poll 返回的 `lease_token` 完成：

```bash
abot-mcp --gateway https://abot.run data poll_events '{"subscription_id":"sub_abcdefghijkl"}'
abot-mcp --gateway https://abot.run data ack_event '{"id":"evt_abcdefghijkl","lease_token":"<poll 返回的 lease_token>"}'
```

CLI 打印的是工具返回值 JSON。
