---
name: "abot-data"
description: "操作 bot 的个人结构化数据层。用户问起 contacts、calendar、notes、事件总线、订阅、poll/ack，或 webhook 推送（HMAC 或 Bearer）时使用。通过 abot-data MCP 读写这些数据；同步和通知不在这个服务里。"
---

# abot-data

## 安装

这个 skill 不是 npm 包。把 `skills/abot-data/` 整个目录复制到你所用 agent 的 skills 目录（例如 Claude Code 的 `~/.claude/skills/`），重启 agent 或等它重新扫描后即可用。

## Purpose

abot-data 是 bot 的个人结构化数据层。MCP 只暴露数据。同步和部署由外部组件做，不要在这个服务里实现。账户验证码是例外：服务会通过 Resend 把 6 位验证码发到注册邮箱。

日历、通讯录和笔记是 bot 自己的记录。事件总线用 `audience` 区分 bot 与 user。

参数明细见同包的 `references/tools.md`。调用不熟悉的工具之前先读那一页。

## Connection

`POST {server}/mcp`。传输是 Streamable HTTP，body 是 JSON-RPC 2.0。

有两种 Bearer：

- 部署方提供的 `DATA_MCP_TOKEN`：legacy 全量访问，行为与以前相同。
- `verify_account` 返回的 `ad_` token：只属于一个邮箱。联系人、日历、笔记按 `owner_email` 隔离，看不到别人的行，也看不到 legacy 的 NULL 行。事件上，这个 token 只能看到自己的事件和 `owner_email` 为空的系统事件；poll 只能用自己的订阅或系统订阅，别人的订阅与不存在一样。

`request_account_verification` 和 `verify_account` 不需要 Bearer。不要把返回的 `ad_` token 写入仓库、日志或这个 skill。

生产地址例如 `https://data.abot.run/mcp`。`GET /health` 公开，不需要 token。正常响应是 `{ "ok": true, "service": "abot-data" }`，例如 `https://data.abot.run/health`。

```http
Authorization: Bearer <部署方提供的 token，或 ad_ token>
Content-Type: application/json
```

除上述两个账户工具外，token 缺失或错误时返回 HTTP 401：`{ "ok": false, "error": "unauthorized" }`。带了错误 Bearer 时，即使调用的是账户工具也是 401。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "emit_event",
    "arguments": { "type": "reminder.medication", "dedupe_key": "reminder.medication:med-1" }
  }
}
```

成功时工具结果在 `result.content[0].text`，是一段 JSON 文本，要再解析一次。JSON-RPC 错误仍是 HTTP 200，看 `error.code`。`tools/list` 返回全部工具的 schema。`initialize` 的协议版本是 `2025-06-18`。

创建联系人、日历或笔记返回的 `url` 可以用同一个 Bearer token 做 GET：`/ctc/{id}`、`/cal/{id}`、`/note/{id}`。

调用 MCP 的 Bearer token 和 webhook 投递里的 Bearer token 不是同一个。后者由订阅方在创建 webhook 时自己提供。

## 工具总览

共 27 个工具。多传 schema 里没有的字段会得到 `-32602`。

### contacts

- `create_contact`：新建联系人，`name` 必填，返回 `{id, url}`，id 前缀 `ctc_`。
- `get_contact`：按 id 读取；不存在时 `found` 为 false。
- `list_contacts`：列出联系人；`query` 匹配 name、aliases、org。
- `update_contact`：按 id 更新传入的字段；`aliases` 整组替换。
- `delete_contact`：硬删除一个联系人。

### calendar

这些是日历记录（id 前缀 `cal_`），不是总线事件。

- `create_event`：新建日历事件。`end_utc` 必须晚于 `start_utc`，返回 `{id, url}`。
- `get_event`：按 id 读取，包括已取消的事件。
- `list_events`：列出与给定时间窗重叠的日历事件。
- `update_event`：按 id 更新；改时间时仍然要求结束晚于开始。
- `delete_event`：把 `status` 标为 `cancelled`，保留记录。

### notes

- `create_note`：新建笔记，字段都可选，返回 `{id, url}`，id 前缀 `note_`。
- `get_note`：按 id 读取；不存在时 `found` 为 false。
- `list_notes`：列出笔记。`query` 匹配 title 和 body，`tag` 精确匹配一项 tag。
- `update_note`：按 id 更新；`tags` 和 `links` 整组替换。
- `delete_note`：硬删除一条笔记。

### events

总线事件，id 前缀 `evt_`。

- `emit_event`：写入一条总线事件。新插入成功才扇出 webhook。不能写 `watchdog.*` 和 `calendar.due`。
- `poll_events`：按订阅认领可见的 pending 事件。`cursor` 只翻页，不表示完成。
- `ack_event`：用 poll 返回的 `lease_token` 完成一条事件。重复 ack 返回 `idempotent: true`。

### subscriptions

- `create_subscription`：创建 poll 或 webhook 订阅。HMAC secret 只在这次响应出现；Bearer token 不回显。
- `get_subscription`：读取一条订阅，含 `webhook_auth`，不含密钥。
- `list_subscriptions`：按创建时间列出订阅，不含密钥。
- `update_subscription`：更新 url、过滤器、status、心跳监视或 `agent_id`。不能改 mode。
- `delete_subscription`：硬删除订阅，并把未终态投递标成 `dead`。
- `rotate_subscription_secret`：轮换 webhook 密钥。hmac 返回新 secret 一次；bearer 必须传入新 token，且不回显。

### deliveries

没有 MCP 工具。每次 webhook 推送记在 `deliveries` 表：`state`、`attempts`、`next_attempt_at`、`last_error`、`dead_reason`。状态见下面的投递语义。

### accounts

一个邮箱一个账户。不需要事先有 Bearer。

- `request_account_verification`：向邮箱发送 6 位验证码。同一邮箱 60 分钟最多 3 次，同一 IP 60 分钟最多 10 次。15 分钟有效。返回 `{ok:true}`，响应里没有验证码。已注册邮箱可以再申请，用来轮换 token。
- `verify_account`：提交邮箱和验证码。成功返回 `{ok:true, token}`。token 形如 `ad_` 加 32 位十六进制，只出现这一次。错误验证码最多尝试 5 次。

用 `ad_` token 调用时，`create_*` 把 `owner_email` 写成这个邮箱；`get_*`、`list_*`、`update_*`、`delete_*` 只作用于自己的行。看不到别人的行，也看不到 legacy 的 NULL 行。`created_by` 仍然只能是 `human` 或 `bot:main`。

### heartbeats

- `heartbeat`：agent 报到。默认 `agent_id` 为 `bot:main`，`ttl_seconds` 默认 600。不直接写事件。

订阅的 `watch_heartbeat` 默认为 true。心跳过期后服务会写入 `watchdog.heartbeat_stale`（`audience` 为 `bot`）。不要自己 emit `watchdog.*`。

## 核心用法模式

### audience

每条总线事件的 `audience` 只能是 `bot` 或 `user`，默认 `bot`。

省略 `audience` 就写成 `bot`。`poll_events` 传入 `audience` 时只返回该受众；不传则两种都返回。只有与用户相关的事件才标 `user`。bot 内部的提醒和检测结果保持 `bot`。服务自己写入的 `calendar.due`、`watchdog.heartbeat_stale`、`watchdog.queue_dlq` 都是 `bot`。

### dedupe_key

`emit_event` 必填。长度 1～200，字符集 `A-Za-z0-9:._-`。不能以 `watchdog.` 或 `calendar.due:` 开头。

同一账户下，同一键仍有 pending 行时再次 emit，返回原 id，`created` 为 false，已存 payload 不变。ack 之后同一个键可以插入新事件。去重范围是 `(owner_email, dedupe_key)`：两个账户用同一个键各有一行；`owner_email` 为空的系统事件之间仍然互相去重。

### 事件命名

类型是 `xxx.yyy`，至少两段。每段以小写字母开头，后面只含小写字母、数字或下划线，每段最多 31 个字符。例如 `reminder.medication`、`calendar.due`、`watchdog.heartbeat_stale`。

订阅过滤器 `event_types`：精确类型、前缀（`reminder.*`）或 `*`。省略时默认 `["watchdog.*", "calendar.*"]`。要收到 `reminder.*` 必须在创建订阅时写上。

`emit_event` 拒绝 `watchdog.*` 和 `calendar.due`。`payload` 是对象，稳定序列化后不超过 4096 字节。键名或字符串里带密钥材料会被拒绝。可选 `not_before` 是 UTC ISO8601，默认现在；在此之前 poll 看不到，webhook 也不会立刻投递。

### poll 与 webhook

`create_subscription` 的 `mode` 为 `poll` 或 `webhook`。poll 不能带 `url` 或 `bearer_token`。webhook 必须是 https URL。

**poll**

1. `poll_events` 必填 `subscription_id`。可选 `cursor`、`limit`（默认 20）、`visibility_seconds`（默认 120 秒）、`audience`。账户 token 看不到其他账户的事件。系统事件（`owner_email` 为空）谁都能 poll 到。订阅若属于别的账户，返回 not found。
2. 每条事件带 `lease_token`。租约期内其他 poll 看不到它。
3. `cursor` 只翻页。不 ack 的事件在租约到期后还会再次出现。
4. 处理完调用 `ack_event`，传入事件 `id` 和这次的 `lease_token`。
5. 重复 ack 得到 `idempotent: true`。pending 期间用错 token 是 `lease mismatch`。
6. 订阅 `paused` 时 poll 被拒绝。

**webhook**

新插入且类型匹配的事件会 POST 到订阅 URL。`created: false` 的重复 emit 不会再次扇出。`watchdog.queue_dlq` 不扇出。webhook 订阅也可以 poll；ack 完成的是总线事件，不会取消已经排队的 HTTP 投递。

### webhook 两种鉴权

`webhook_auth` 默认 `hmac`。`get_subscription` 和 `list_subscriptions` 只返回 `webhook_auth` 与 `has_secret`。

两种模式都带这些头：`content-type: application/json; charset=utf-8`、`user-agent: abot-data-webhook/1`、`x-abot-timestamp`（Unix 秒）、`x-abot-event-id`、`x-abot-subscription-id`。body 是键已排序的稳定 JSON。验签使用原始 body，不要解析后再序列化。

**HMAC。** 创建或轮换时不传 `bearer_token`。服务端生成的 secret 只在当次响应的 `secret` 字段出现一次。投递另带 `x-abot-signature: v1=<hex>`。

验签：timestamp 与当前时间相差超过 300 秒则拒绝；`HMAC-SHA256(secret, timestamp + "." + rawBody)` 得到小写 hex；期望值是 `v1=` 加这段 hex，与签名头整段做常量时间比较。

```javascript
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyAbotHmac({ secret, timestamp, rawBody, signature, nowMs = Date.now() }) {
  if (!/^\d+$/.test(String(timestamp))) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > 300) return false;
  const hex = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expected = Buffer.from(`v1=${hex}`);
  const got = Buffer.from(String(signature));
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
```

**Bearer。** 仅 webhook。创建时由订阅方提供 `bearer_token`（1～500 字符，不能含控制字符或换行）。响应不回显。轮换必须再传新 token，不传是 `-32602`。投递头是 `Authorization: Bearer <token>`，没有 `x-abot-signature`。接收端把 `Bearer ` 后面的值与自己保存的 token 做常量时间比较。这个 token 不能用来调用 MCP。

hmac 订阅轮换时不要传 `bearer_token`。服务端会生成新 secret，并在当次响应里返回一次。

### 投递重试

| 结果 | 行为 |
| --- | --- |
| 2xx | `succeeded` |
| 408、429、500–599，以及超时、网络错误 | 按 60 秒、120 秒、240 秒退避 |
| 其他 HTTP 状态 | `dead`，`dead_reason` 为 `http_status` |
| 密钥解不开 | 立刻 `dead`，`dead_reason` 为 `seal_error` |

第四次失败进入 DLQ：`state` 为 `dead`，`dead_reason` 为 `retries_exhausted`。总线事件仍是 pending。除删除订阅造成的 dead 以外，服务会写一条 `watchdog.queue_dlq`，且不再扇出。

### 常见错误码

| 码 | 含义 |
| --- | --- |
| `-32602` | 参数错误。缺字段、类型不对、多余字段、url 不合法、`bearer_token` 不合格、poll 传了 `bearer_token`、bearer 轮换没带新 token、租约不匹配、订阅暂停、记录不存在（消息 `not found`）都在这里。改参数再调，不要原样重试。 |
| `-32603` | 内部错误。消息是 `internal error`，或 webhook 密封未配置时的 `subscription seal is not configured`。不要用同一调用空转。 |

联系人、日历、笔记的 `get_*` 在 id 合法但不存在时返回 `{ "found": false }`。更新或删除不存在的记录才是 `-32602`。HTTP 401 是 MCP 鉴权失败，不是这两个码。未知工具是 `-32601`。

## Operating rules

- 只通过 MCP 读写数据。不要在这里做同步、通知或部署。
- 调用前核对 `references/tools.md`。schema 之外的字段会失败。
- `audience` 默认 `bot`。只有与用户相关的事件才标 `user`。
- poll 之后用当次 `lease_token` 调用 `ack_event`。`cursor` 不是完成标记。
- HMAC 的 `secret` 只出现一次。转达给调用方之后不要写入文件、日志或仓库。
- `verify_account` 的 `token` 也只出现一次。不要写入文件、日志或仓库，也不要在其他工具参数里回传。
- webhook 的 Bearer token 由订阅方提供，响应里没有它。不要把它和 MCP 的接入 token 混用，也不要写进仓库或日志。
- `payload` 里不要放密钥、口令或签名材料。
- 不要 `emit_event` 写 `watchdog.*` 或 `calendar.due`。
- 收到 `-32602` 就改参数。收到 `-32603` 就停下来说明原因，不要原样重试。
