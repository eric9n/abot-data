# 部署契约

本仓库不含生产密钥。`wrangler.toml` 的 Worker 名是 `abot-data`，但直接执行 `wrangler deploy` 不允许发布生产：没有生产路由，D1 `database_id` 是占位符，cron 和 queue consumer 由部署方按本文件注入。

## Worker

无构建。Worker 是多模块：

- 主模块 `src/worker.js`（`fetch`、`scheduled`、`queue`）
- 辅助模块 `src/phase2.js`（由主模块 `import "./phase2.js"`）

`compatibility_date` 为 `2026-09-01`。

## D1

- Binding 名固定为 `DB`。
- 表结构来自仓库根目录的 `schema.sql`，可重复执行：12 张表（`contacts`、`calendar_events`、`notes`、`events`、`subscriptions`、`deliveries`、`heartbeats`、`accounts`、`verification_codes`、`verification_requests`、`oauth_clients`、`oauth_codes`），17 个索引。
- `oauth_clients.redirect_uris` 是 JSON 数组文本，回调地址按字符串精确匹配。`client_secret_hash` 和 `oauth_codes.code_hash` 都是 SHA-256 十六进制，明文不入库。`client_secret_hash` 为空字符串表示公开客户端（不校验 secret，授权必须带 S256 PKCE）。`oauth_codes.code_challenge` 可空，存的是 S256 challenge 原文。已经建好、还没有这一列的 `oauth_codes` 会在下一次签发授权码或换 token 时自动补上。客户端行由部署方写入，本仓库没有注册接口。
- `contacts`、`calendar_events`、`notes` 有可空列 `owner_email`。新建库执行 `schema.sql` 即可，未写入该列的旧行保持 NULL。已经建好、还没有这一列的库要先补列（这三句只跑一次，`schema.sql` 本身不包含它们，因为重复执行 `ADD COLUMN` 会失败）：

```sql
ALTER TABLE contacts ADD COLUMN owner_email TEXT;
ALTER TABLE calendar_events ADD COLUMN owner_email TEXT;
ALTER TABLE notes ADD COLUMN owner_email TEXT;
```
- `events` 和 `subscriptions` 也有可空列 `owner_email`。NULL 表示系统级。新建库执行 `schema.sql` 即可，未写入该列的旧行保持 NULL。已经建好的库不用手跑 ALTER：下次 `emit_event`、`poll_events`、`create_subscription` 或定时检测会补上这两列，并在需要时把 `idx_events_dedupe_open` 改成按 `COALESCE(owner_email, '')` 与 `dedupe_key` 去重。这两步可以重复执行。
- `wrangler.toml` 里的 `database_id` 是占位符。生产库 id 由部署方注入，不写入仓库。

## Cron

部署方注入 cron `*/5 * * * *`。`scheduled` 做日历到期检测、心跳过期检测、死信检测，以及投递修复（到期投递重新入队、卡住的 inflight 回收）。

```toml
[triggers]
crons = ["*/5 * * * *"]
```

## Queues

Producer 写在 `wrangler.toml`：binding `DELIVER_QUEUE`，队列 `abot-deliver`。

Consumer 由部署方注入，不写进默认 `wrangler.toml`：

- 队列 `abot-deliver`：batch_size 5，max_retries 3，max_wait_time_ms 1000，死信队列 `abot-deliver-dlq`
- 死信队列 `abot-deliver-dlq`：batch_size 1

```toml
[[queues.consumers]]
queue = "abot-deliver"
max_batch_size = 5
max_retries = 3
max_wait_time_ms = 1000
dead_letter_queue = "abot-deliver-dlq"

[[queues.consumers]]
queue = "abot-deliver-dlq"
max_batch_size = 1
```

Worker 用 batch 的 `queue` 名区分：`abot-deliver-dlq` 记死信，其余投递 webhook。

## Secrets

生产 secrets 由部署方注入，绝不进仓库：

- `DATA_MCP_TOKEN`：`POST /mcp` 与 canonical GET 的 legacy Bearer。它仍然能读写全部行，`owner_email` 写成 NULL。
- `SUBSCRIPTION_SEAL`：订阅 webhook secret 的封装密钥
- `RESEND_API_KEY`：账户验证码邮件。Worker 只从该环境变量读取，值不进仓库、不进日志。发件人是 `abot-data@abot.run`。

本地密钥文件（`.prod-token`、`.kek_b64`、`.dev.vars`、`.env`、`.env.*`、`*.pem`、`*.key`）已列入 `.gitignore`。
