# 部署契约

本仓库不含生产密钥。`wrangler.toml` 的 Worker 名是 `abot-data`，但直接执行 `wrangler deploy` 不允许发布生产：没有生产路由，D1 `database_id` 是占位符，cron 和 queue consumer 由部署方按本文件注入。

## Worker

无构建。Worker 是多模块：

- 主模块 `src/worker.js`（`fetch`、`scheduled`、`queue`）
- 辅助模块 `src/phase2.js`（由主模块 `import "./phase2.js"`）

`compatibility_date` 为 `2026-09-01`。

## D1

- Binding 名固定为 `DB`。
- 表结构来自仓库根目录的 `schema.sql`，可重复执行：7 张表（`contacts`、`calendar_events`、`notes`、`events`、`subscriptions`、`deliveries`、`heartbeats`），11 个索引。
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

- `DATA_MCP_TOKEN`：`POST /mcp` 与 canonical GET 的 Bearer
- `SUBSCRIPTION_SEAL`：订阅 webhook secret 的封装密钥

本地密钥文件（`.prod-token`、`.kek_b64`、`.dev.vars`、`.env`、`.env.*`、`*.pem`、`*.key`）已列入 `.gitignore`。
