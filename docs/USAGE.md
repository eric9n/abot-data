# abot-data 使用说明

这份文档给接入方（agent 或开发者）看：怎么调用 MCP、怎么订阅事件、怎么验 webhook。部署、密钥注入和队列配置见 [deploy/ENV.md](../deploy/ENV.md)。

## 1. 服务定位

abot-data 是 bot 的个人结构化数据层。MCP 只暴露数据；同步和通知由外部组件完成，不在这个服务里。

日历、通讯录和笔记是 bot 自己的记录。事件总线用 `audience` 区分 bot 与 user。

## 2. 接入方式

服务暴露两个 HTTP 入口。

- `POST /mcp`：MCP，Streamable HTTP，body 是 JSON-RPC 2.0。需要 Bearer 鉴权，令牌由服务方提供（部署侧的名字是 `DATA_MCP_TOKEN`）。
- `GET /health`：公开，不需要令牌。正常时返回 `{ "ok": true, "service": "abot-data" }`。

请求头：

```http
Authorization: Bearer <接入令牌>
Content-Type: application/json
```

令牌缺失或错误时，服务在读 body 之前返回 HTTP 401：`{ "ok": false, "error": "unauthorized" }`。

常用方法：

| 方法 | 作用 |
| --- | --- |
| `initialize` | 协议版本 `2025-06-18`，服务名 `abot-data-mcp` |
| `tools/list` | 返回全部工具和各自的 `inputSchema` |
| `tools/call` | 调用一个工具，参数放在 `params.arguments` |
| `notifications/*` | 通知，无 id。成功时 HTTP 202，空 body |

`tools/call` 的成功结果在 `result.content[0].text` 里，是一段 JSON 文本，需要再解析一次。JSON-RPC 错误仍是 HTTP 200，错误在 `error` 对象里。

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

创建联系人、日历或笔记时，响应里的 `url` 可以用同一个 Bearer 令牌做 GET：`/ctc/{id}`、`/cal/{id}`、`/note/{id}`。这是记录的 canonical 读取，不是 MCP。

这里的 Bearer 是调用 MCP 的接入令牌。Webhook 投递上的 Bearer 是订阅方自己的 token，两者不是同一个密钥。

## 3. 工具总览

一共 25 个工具。`additionalProperties` 都是 `false`，多传字段会得到 `-32602`。

### contacts

| 工具 | 说明 |
| --- | --- |
| `create_contact` | 新建联系人，`name` 必填，返回 `{id, url}`，id 前缀 `ctc_`。 |
| `get_contact` | 按 id 读取；不存在时 `found` 为 false。 |
| `list_contacts` | 列出联系人；`query` 匹配 name、aliases、org。`limit` 默认 20，最大 100。 |
| `update_contact` | 按 id 更新传入的字段；`aliases` 整组替换。 |
| `delete_contact` | 硬删除一个联系人。 |

### calendar

这些是日历记录（id 前缀 `cal_`），不是第 4 节的总线事件。

| 工具 | 说明 |
| --- | --- |
| `create_event` | 新建日历事件。`start_utc` / `end_utc` 为 UTC ISO8601，结束必须晚于开始。返回 `{id, url}`。 |
| `get_event` | 按 id 读取，包括已取消的事件。 |
| `list_events` | 列出与 `[start_utc, end_utc)` 重叠的事件。`limit` 默认 100，最大 500。 |
| `update_event` | 按 id 更新；改时间时仍然要求结束晚于开始。 |
| `delete_event` | 把 `status` 标为 `cancelled`，保留记录，不物理删除。 |

### notes

| 工具 | 说明 |
| --- | --- |
| `create_note` | 新建笔记。title、body、tags、links 都可选。返回 `{id, url}`，id 前缀 `note_`。 |
| `get_note` | 按 id 读取；不存在时 `found` 为 false。 |
| `list_notes` | 列出笔记。`query` 匹配 title 和 body，`tag` 精确匹配 tags 里的一项。 |
| `update_note` | 按 id 更新；`tags` 和 `links` 整组替换。 |
| `delete_note` | 硬删除一条笔记。 |

### events

总线事件，id 前缀 `evt_`。和日历工具不是同一张表。

| 工具 | 说明 |
| --- | --- |
| `emit_event` | 写入一条总线事件。新插入成功才扇出 webhook。不能写 `watchdog.*` 和 `calendar.due`。 |
| `poll_events` | 按订阅认领可见的 pending 事件。`cursor` 只翻页，不表示完成。 |
| `ack_event` | 用 poll 返回的 `lease_token` 完成一条事件。重复 ack 返回 `idempotent: true`。 |

### subscriptions

| 工具 | 说明 |
| --- | --- |
| `create_subscription` | 创建 poll 或 webhook 订阅。HMAC 的 secret 只在这次响应里出现；Bearer token 不回显。 |
| `get_subscription` | 读取一条订阅，含 `webhook_auth`，不含密钥。 |
| `list_subscriptions` | 按 `created_at`、`id` 升序列出订阅。`limit` 默认 20，最大 100。 |
| `update_subscription` | 更新 url、过滤器、status、心跳监视或 `agent_id`。不能改 mode。 |
| `delete_subscription` | 硬删除订阅，并把未终态投递标成 `dead`（`dead_reason` 为 `subscription_deleted`）。 |
| `rotate_subscription_secret` | 轮换 webhook 密钥。hmac 由服务端生成并返回一次；bearer 必须传入新 token，且不回显。 |

### deliveries

投递没有 MCP 工具。每次 webhook 推送记在 `deliveries` 表里，字段包括 `state`、`attempts`、`next_attempt_at`、`last_error`、`dead_reason`。状态含义见第 4 节。

### heartbeats

| 工具 | 说明 |
| --- | --- |
| `heartbeat` | agent 报到。默认 `agent_id` 为 `bot:main`，`ttl_seconds` 默认 600（范围 120～86400）。不直接写事件。 |

订阅的 `watch_heartbeat` 默认为 true。心跳过期后，服务会自己写入 `watchdog.heartbeat_stale`（`audience` 为 `bot`）。接入方不能用 `emit_event` 写 `watchdog.*`。

## 4. 核心模式

### audience

每条总线事件带 `audience`，只能是 `bot` 或 `user`，默认 `bot`。

- `emit_event` 省略 `audience` 时写成 `bot`。
- `poll_events` 传入 `audience` 时只返回该受众；不传则 `bot` 和 `user` 都返回。
- 只有与用户相关的事件才标 `user`。bot 内部的提醒、检测结果保持 `bot`。
- 服务自己写入的 `calendar.due`、`watchdog.heartbeat_stale`、`watchdog.queue_dlq` 都是 `audience: bot`。

### dedupe_key

`emit_event` 的必填去重键。长度 1～200，字符集是 `A-Za-z0-9:._-`。不能以 `watchdog.` 或 `calendar.due:` 开头。

同一条 `dedupe_key` 在还有 pending 行时再次 emit，返回原来的 id，且 `created` 为 false，已存的 payload 不会被覆盖。ack 之后，同一个键可以再插入一条新事件。

### 事件类型

类型写成 `xxx.yyy`，至少两段，用点分隔。每段以小写字母开头，后面是小写字母、数字或下划线，每段最多 31 个字符，整段最长 64。例如 `calendar.due`、`reminder.medication`、`watchdog.heartbeat_stale`。

订阅过滤器 `event_types`：

- 精确类型：`reminder.medication`
- 前缀：`reminder.*`、`watchdog.*`
- 全部：`*`

省略 `event_types` 时默认 `["watchdog.*", "calendar.*"]`。`reminder.*` 不在默认过滤器里，poll 和 webhook 都不会收到，除非创建订阅时写上。

`emit_event` 拒绝 `watchdog.*` 和 `calendar.due`。这两类由服务的检测逻辑写入。`payload` 是对象，稳定序列化后不超过 4096 字节；键名或字符串里带密钥（如 `token`、`password`、`whsec_`）会被拒绝。

可选 `not_before` 是 UTC ISO8601，默认现在。在这个时间之前，poll 看不到，webhook 也不会立刻投递。允许范围大约是过去 7 天到未来 366 天。

### 订阅：poll 与 webhook

`create_subscription` 的 `mode` 为 `poll` 或 `webhook`。poll 不能带 `url`，也不能带 `bearer_token`。webhook 必须带 https URL（不能是 IP、localhost，也不能带用户名、密码或非 443 端口）。

**poll。** 用 `poll_events` 认领，处理完调用 `ack_event`。

1. `poll_events` 需要 `subscription_id`。可选 `cursor`、`limit`（默认 20，最大 100）、`visibility_seconds`（默认 120，范围 30～900）、`audience`。
2. 返回的每条事件带 `lease_token` 和 `leased_until`。租约期内其他 poll 看不到它。
3. `cursor` 只表示翻页位置。不传 cursor 不会把事件标完成，漏 ack 的事件在租约到期后还会再次出现。
4. 处理完成后 `ack_event`，传入事件 `id` 和这次的 `lease_token`。成功时 `status` 为 `acked`，`idempotent` 为 false。
5. 用同一个 id 再次 ack 返回 `idempotent: true`。pending 期间用错的 `lease_token` 是 `lease mismatch`。
6. 订阅 `status` 为 `paused` 时，poll 被拒绝。

返回里还有 `next_cursor`、`has_more`、`retry_after_seconds`。当前没有可认领事件、也没有更多页时，`retry_after_seconds` 提示下一条仍在租约中的匹配事件大约何时可见。

**webhook。** 新插入且类型匹配的事件会 POST 到订阅 URL。重复 emit（`created: false`）不会再次扇出。`watchdog.queue_dlq` 不扇出，避免死信再投死信。webhook 订阅也可以 `poll_events`；`ack_event` 完成的是总线事件，不会取消已经排队的 HTTP 投递。

暂停订阅会把未终态投递标为 `paused`；恢复为 `active` 后再回到 `due`。

### webhook 的两种鉴权

由 `webhook_auth` 决定，默认 `hmac`。两种模式都把密钥密封保存。`get_subscription` 和 `list_subscriptions` 只给 `webhook_auth` 和 `has_secret`，不给密钥。

共同的请求头：

- `content-type: application/json; charset=utf-8`
- `user-agent: abot-data-webhook/1`
- `x-abot-timestamp`：Unix 秒
- `x-abot-event-id`
- `x-abot-subscription-id`

body 是稳定 JSON：对象键按字母排序。验签和比对时使用原始 body 字节，不要 `JSON.parse` 之后再自己 `stringify`。字段为 `id`、`type`、`dedupe_key`、`created_at`、`not_before`、`payload`。

**HMAC。** 创建或轮换时不传 `bearer_token`。服务端生成 `whsec_...`，只在当次响应的 `secret` 字段出现一次，之后读不到。

投递额外带 `x-abot-signature: v1=<hex>`。验签与 `verifyWebhookRequest` 一致：

1. `x-abot-timestamp` 必须是十进制秒。与当前时间相差超过 300 秒则拒绝。
2. 计算 `HMAC-SHA256(secret, timestamp + "." + rawBody)`，得到小写 hex。
3. 期望值是 `v1=` 加上这段 hex，与 `x-abot-signature` 整段做常量时间比较。

**Bearer。** 只在 webhook 创建时传入 `bearer_token`（1～500 字符，不能含控制字符或换行）。响应不回显 token，调用方自己保管。轮换时必须再传一个新 token，同样不回显；不传是 `-32602`。

投递头是 `Authorization: Bearer <token>`，没有 `x-abot-signature`。接收端把 `Bearer ` 后面的值和自己保存的 token 做常量时间比较。

hmac 订阅轮换时不要传 `bearer_token`，服务端会生成新 secret 并在响应里返回一次。

### 投递语义

webhook 的 HTTP 结果决定 `deliveries.state`：

| 结果 | 行为 |
| --- | --- |
| 2xx | `succeeded`，不再投 |
| 408、429、500–599，以及超时、网络错误 | 退避重试 |
| 其他 HTTP 状态（含 3xx、4xx） | `dead`，`dead_reason` 为 `http_status` |
| 密钥解不开 | 立刻 `dead`，`dead_reason` 为 `seal_error` |

失败按 **60 秒 → 120 秒 → 240 秒** 重试。第四次失败（`attempts` 达到 4）进入死信：`state` 为 `dead`，`dead_reason` 为 `retries_exhausted`。死信队列名是 `abot-deliver-dlq`。原事件仍是 pending，不会因为投递失败被 ack。

除 `subscription_deleted` 以外的 dead 投递，服务会写一条 `watchdog.queue_dlq`（不再次扇出）。删除订阅造成的 dead 不会写这条事件。

查状态看 `deliveries` 表：`due`（待投）、`inflight`（正在投）、`paused`、`succeeded`、`dead`。`last_error` 形如 `http_500`、`http_404`、`timeout`、`network`。

## 5. 错误码

工具参数错误走 JSON-RPC，HTTP 仍是 200。传输层错误用 HTTP 状态。

| 码 | 何时出现 |
| --- | --- |
| `-32700` | body 不是 JSON。HTTP 400，`Parse error`。 |
| `-32600` | 请求不合法：不是 JSON-RPC 2.0、缺少 method 或 id。`Content-Type` 不是 `application/json` 时 HTTP 415；body 超过 1_000_000 字节时 HTTP 413。 |
| `-32601` | 方法不存在，或 `tools/call` 的工具名不存在。 |
| `-32602` | 参数错误。缺字段、类型不对、多出来的字段、url 不合法、`bearer_token` 空/超长/含换行、poll 传了 `bearer_token`、bearer 轮换没带新 token、租约不匹配、订阅暂停、记录不存在（消息为 `not found`）都在这里。 |
| `-32603` | 内部错误，消息为 `internal error`。webhook 密封密钥未配置时消息为 `subscription seal is not configured`。 |

联系人、日历、笔记的 `get_*` 在 id 合法但不存在时返回 `{ "found": false }`，不报错。更新或删除一条不存在的记录才是 `-32602` / `not found`。

MCP 鉴权失败是 HTTP 401，不是上面的 JSON-RPC 码。

## 6. 端到端示例

下面的 `text` 都是 `result.content[0].text` 解析后的对象。请求都发到 `POST /mcp`，并带接入令牌。

### emit → poll → ack

先建一个能看见 `reminder.*` 的 poll 订阅。默认过滤器只有 `watchdog.*` 和 `calendar.*`，不写 `event_types` 的话这次 emit 不会被 poll 到。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_subscription",
    "arguments": { "mode": "poll", "event_types": ["reminder.*"] }
  }
}
```

```json
{ "id": "sub_abcdefghijkl", "mode": "poll", "status": "active" }
```

写入事件。`audience` 省略，即为 `bot`。

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "emit_event",
    "arguments": {
      "type": "reminder.medication",
      "dedupe_key": "reminder.medication:med-1:2026-09-30T00:00:00.000Z",
      "payload": { "name": "药" }
    }
  }
}
```

```json
{ "id": "evt_abcdefghijkl", "created": true }
```

认领。

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "poll_events",
    "arguments": { "subscription_id": "sub_abcdefghijkl" }
  }
}
```

```json
{
  "events": [
    {
      "id": "evt_abcdefghijkl",
      "type": "reminder.medication",
      "payload": { "name": "药" },
      "dedupe_key": "reminder.medication:med-1:2026-09-30T00:00:00.000Z",
      "lease_token": "0123456789abcdef0123456789abcdef",
      "poll_count": 1
    }
  ],
  "next_cursor": "v1....",
  "has_more": false,
  "retry_after_seconds": 0
}
```

处理完再 ack。`lease_token` 必须是这一次 poll 返回的值。

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "ack_event",
    "arguments": {
      "id": "evt_abcdefghijkl",
      "lease_token": "0123456789abcdef0123456789abcdef"
    }
  }
}
```

```json
{
  "id": "evt_abcdefghijkl",
  "status": "acked",
  "idempotent": false,
  "ack_cursor": "v1...."
}
```

同一 `dedupe_key` 在 ack 之前再 emit，会得到同一个 id 且 `created` 为 false。ack 之后再 emit，才会有新 id。

### 创建 webhook 并验签

**HMAC。** 创建时不传 token。把响应里的 `secret` 存下来，以后的读取接口不会再给。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_subscription",
    "arguments": {
      "mode": "webhook",
      "url": "https://example.com/hooks/abot",
      "event_types": ["reminder.*"]
    }
  }
}
```

```json
{
  "id": "sub_hmacexample1",
  "mode": "webhook",
  "status": "active",
  "secret": "whsec_example_save_this_once"
}
```

之后匹配的新事件会 POST 到该 URL。接收端用原始 body 验签（伪代码，逻辑对齐 `verifyWebhookRequest`）：

```javascript
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyAbotHmac({ secret, timestamp, rawBody, signature, nowMs = Date.now() }) {
  if (!/^\d+$/.test(String(timestamp))) return false;
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false;
  const hex = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expected = Buffer.from(`v1=${hex}`);
  const got = Buffer.from(String(signature));
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

// timestamp = 请求头 x-abot-timestamp
// signature = 请求头 x-abot-signature
// rawBody   = 原始 body，不要重新序列化
const ok = verifyAbotHmac({
  secret: savedSecret,
  timestamp: headers["x-abot-timestamp"],
  rawBody,
  signature: headers["x-abot-signature"],
});
```

验过之后返回 2xx。返回 404 或其他非重试状态会把这条投递标死；返回 500 会按 60s、120s、240s 重试。

**Bearer。** 创建时自己提供 token。响应里没有 `secret`，也没有 token。

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "create_subscription",
    "arguments": {
      "mode": "webhook",
      "url": "https://example.com/hooks/n8n",
      "event_types": ["reminder.*"],
      "bearer_token": "n8n-hook-token"
    }
  }
}
```

```json
{ "id": "sub_bearerexampl", "mode": "webhook", "status": "active" }
```

推送带 `Authorization: Bearer n8n-hook-token`，不带 `x-abot-signature`。接收端比对的是创建时自己提供的 token（伪代码）：

```javascript
import { timingSafeEqual } from "node:crypto";

function verifyAbotBearer(authorization, token) {
  const match = /^Bearer (.+)$/.exec(authorization || "");
  if (!match) return false;
  const got = Buffer.from(match[1]);
  const want = Buffer.from(token);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

const ok = verifyAbotBearer(headers.authorization, "n8n-hook-token");
```

这个 token 只属于该 webhook 订阅。它不能用来调用 `POST /mcp`。
