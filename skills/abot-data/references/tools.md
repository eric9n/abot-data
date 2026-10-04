# abot-data 工具目录

从服务的工具定义摘出：名称、中文描述、必填参数。`additionalProperties` 都是 `false`，下表以外的字段会被拒绝。

## contacts

### create_contact

新建联系人。name 必填。aliases 为字符串数组。返回 {id, url}，id 前缀 ctc_，url 是 canonical URL。created_by 可选：human 或 bot:main。

必填：`name`

其他参数：`aliases`（string[]）、`org`、`title`、`email`、`phone`、`relation`、`notes`、`created_by`（`human` 或 `bot:main`）

### get_contact

按 id 读取一个联系人。命中时带 url。不存在时 found 为 false。

必填：`id`

### list_contacts

列出联系人。query 对 name、aliases、org 做 LIKE。limit 默认 20，最大 100。

必填：无

其他参数：`query`、`limit`（1–100，默认 20）

### update_contact

按 id 更新联系人字段。只改传入的字段。aliases 会整组替换。

必填：`id`

其他参数：`name`、`aliases`（string[]）、`org`、`title`、`email`、`phone`、`relation`、`notes`

### delete_contact

硬删除一个联系人。

必填：`id`

## calendar

日历记录，id 前缀 `cal_`。不是总线事件。

### create_event

新建日历事件。start_utc / end_utc 为 UTC ISO8601，end 必须晚于 start。repeat.freq 为 none、daily、weekly 或 monthly。返回 {id, url}，id 前缀 cal_。不检查 attendee_ids 是否已有联系人。

必填：`title`、`start_utc`、`end_utc`

其他参数：`timezone`（默认 `Asia/Shanghai`）、`all_day`（默认 false）、`repeat`（object）、`attendee_ids`（string[]）、`reminder_minutes`（integer[]）、`location`、`notes`、`created_by`（`human` 或 `bot:main`）

### get_event

按 id 读取一个事件，包括已取消的事件。命中时带 url。

必填：`id`

### list_events

列出与 [start_utc, end_utc) 重叠的事件（start_utc < 窗口结束且 end_utc > 窗口开始）。status 可选 confirmed 或 cancelled；省略则两者都返回。

必填：`start_utc`、`end_utc`

其他参数：`status`（`confirmed` 或 `cancelled`）、`limit`（1–500，默认 100）

### update_event

按 id 更新事件。改时间时仍要求结束晚于开始。

必填：`id`

其他参数：`title`、`start_utc`、`end_utc`、`timezone`、`all_day`、`repeat`（object）、`attendee_ids`（string[]）、`reminder_minutes`（integer[]）、`location`、`notes`、`status`（`confirmed` 或 `cancelled`）

### delete_event

将事件 status 标为 cancelled，保留历史，不物理删除。

必填：`id`

## notes

### create_note

新建笔记。title、body、tags、links 都可选。返回 {id, url}，id 前缀 note_。

必填：无

其他参数：`title`、`body`、`tags`（string[]）、`links`（string[]）、`created_by`（`human` 或 `bot:main`）

### get_note

按 id 读取一条笔记。命中时带 url。不存在时 found 为 false。

必填：`id`

### list_notes

列出笔记。query 对 title 和 body 做 LIKE。tag 精确匹配 tags 数组里的一项。limit 默认 20，最大 100。

必填：无

其他参数：`query`、`tag`、`limit`（1–100，默认 20）

### update_note

按 id 更新笔记。tags 和 links 会整组替换。

必填：`id`

其他参数：`title`、`body`、`tags`（string[]）、`links`（string[]）

### delete_note

硬删除一条笔记。

必填：`id`

## events

总线事件，id 前缀 `evt_`。

### poll_events

按订阅认领可见的 pending 事件。cursor 只翻页，不表示完成。返回 events、next_cursor、has_more、retry_after_seconds。传入 audience 时只返回该受众，不传则返回全部。账户 token 只返回自己的事件和系统事件；系统事件按账户单独租约。别人的订阅、以及没有 owner 的系统订阅，与不存在一样，返回 not found。

必填：`subscription_id`

其他参数：`cursor`、`limit`（1–100，默认 20）、`visibility_seconds`（30–900，默认 120）、`audience`（`bot` 或 `user`）

### ack_event

用 poll 返回的 lease_token 完成一条事件。重复 ack 返回 idempotent true。

必填：`id`、`lease_token`

### emit_event

写入一条总线事件。拒绝 watchdog.* 和 calendar.due。新插入成功才扇出 webhook。audience 可选，只能是 bot 或 user，默认 bot。账户 token 写入的事件属于该邮箱；legacy token 写入的事件属于 legacy，只有 legacy 订阅看得到。

必填：`type`、`dedupe_key`

其他参数：`payload`（object）、`not_before`、`audience`（`bot` 或 `user`，默认 `bot`）

## subscriptions

### create_subscription

创建 poll 或 webhook 订阅。不传 bearer_token 时 webhook 用 HMAC：服务端生成 secret，只在这次响应里出现。传入 bearer_token 时投递带 Authorization: Bearer，token 不回显。bearer_token 仅 webhook 可用，1 到 500 字符，不能含控制字符或换行。订阅记下调用方邮箱；legacy token 创建的订阅没有 owner，视为系统订阅。每个账户最多 20 个订阅，legacy 最多 100 个，超出返回 subscription limit reached。

必填：`mode`（`poll` 或 `webhook`）

其他参数：`url`、`event_types`（string[]）、`watch_heartbeat`、`agent_id`、`bearer_token`（1–500）

### get_subscription

读取一条订阅。返回 webhook_auth，不含密钥。未找到是 not found。

必填：`id`

### list_subscriptions

按 created_at、id 升序列出订阅。limit 默认 20，最大 100。返回 webhook_auth，不含密钥。

必填：无

其他参数：`limit`（1–100，默认 20）

### update_subscription

更新订阅的 url、过滤器、status、心跳监视或 agent_id。不能改 mode。

必填：`id`

其他参数：`url`、`event_types`（string[]）、`status`（`active` 或 `paused`）、`watch_heartbeat`、`agent_id`

### delete_subscription

硬删除订阅，并把未终态投递标成 dead，dead_reason 为 subscription_deleted。

必填：`id`

### rotate_subscription_secret

轮换 webhook 密钥。先看 webhook_auth：hmac 由服务端生成新 secret，只在这次响应里出现；bearer 必须传新的 bearer_token，且不回显。poll 订阅会拒绝。

必填：`id`

其他参数：`bearer_token`（1–500；bearer 订阅轮换时必须带）

## deliveries

没有工具。投递状态在 `deliveries` 表，不通过 MCP 查询。

## accounts

公开工具，不需要 Bearer。已注册邮箱可以再次验证以轮换 token。

### request_account_verification

为邮箱申请 agent 账户验证码。无需 Bearer。同一邮箱 60 分钟最多 3 次，同一 IP 60 分钟最多 10 次。验证码 15 分钟有效，通过邮件发送。返回 {ok:true}，不包含验证码。已注册邮箱可以再次申请以轮换 token。

必填：`email`

### verify_account

提交邮箱验证码。成功返回 {ok:true, token}。token 形如 ad_ 加 32 位十六进制，只出现这一次。已有账户会轮换 token，旧 token 立即失效。验证码错误会计入尝试次数，达到 5 次后拒绝。

必填：`email`、`code`

## heartbeats

### heartbeat

agent 报到。默认 agent_id 为 bot:main，ttl_seconds 默认 600。不修改事件。

必填：无

其他参数：`agent_id`、`ttl_seconds`（120–86400，默认 600）
