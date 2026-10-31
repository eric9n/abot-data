# 部署契约

本仓库不含生产密钥。根目录 `wrangler.toml` 只用于本地开发：D1 `database_id` 是占位符，没有 Durable Object、服务绑定、cron 和 queue consumer。

## 部署流程

生产发布只有一条路径：Cloudflare 控制台里 `abot-data` 的 Workers Builds（Settings > Build），连接 GitHub 仓库 `eric9n/abot-data`，生产分支 `main`（2026-10-21 起；此前连的是 Origin 仓库 `dagow/abot-data`，GitHub 合并不会触发构建）。`list_contacts` 的 `phone` 参数（末 11 位匹配）随本次构建上线。

| 项 | 值 |
| --- | --- |
| Build command | `npm test && node deploy/cloudflare.mjs build` |
| Deploy command | `node deploy/cloudflare.mjs deploy` |
| Root directory | `/` |
| Build variable | `D1_DATABASE_ID`：生产 D1 库 `abot-data` 的 UUID |

`deploy/cloudflare.mjs` 只在 Workers Builds 里运行（检查 `WORKERS_CI=1`），在本地执行会直接退出。

- `build`：从 `wrangler.toml` 取 `name`、`main`、`compatibility_date`，加上本文件的生产绑定生成 `dist/wrangler.json`（不入库），再用 `wrangler deploy --dry-run` 打包校验。测试不过不会进入这一步。
- `deploy`，分支是 `main`：先读线上 `schema.sql` 各表的列，对缺的列执行 `ALTER TABLE … ADD COLUMN`（`CREATE TABLE IF NOT EXISTS` 不会给旧表加列，后面的索引会因此失败；加不了的列，比如没有默认值的 `NOT NULL`，直接中止部署），再 `wrangler d1 execute DB --remote --file schema.sql`（幂等，失败则不发布代码），最后 `wrangler deploy`，版本备注是 `分支@提交 build <uuid>`。
- `deploy`，其它分支（手动触发的构建）：只做 `wrangler versions upload`，校验绑定，不切生产流量。

wrangler 版本锁在 `package.json`。Workers Builds 的 API token 除默认的 Workers Scripts 编辑权限外，还要有 **D1 Edit**（执行 schema）和 **Queues Edit**（更新 consumer）。回滚用控制台 Deployments 页选旧版本，或者 revert 后推到 `main`。

## Worker

wrangler 打包成单文件。源码是多模块：

- 主模块 `src/worker.js`（`fetch`、`scheduled`、`queue`）
- 辅助模块 `src/phase2.js`（由主模块 `import "./phase2.js"`）
- Durable Object `src/scheduler.js`（类 `Scheduler`，SQLite 存储，由主模块导出）

生产绑定（`deploy/cloudflare.mjs` 生成）：

- `DB`：D1 `abot-data`
- `SCHEDULER`：Durable Object `Scheduler`，用 `exports` 声明，不写 `migrations`
- `SELF`：指向 `abot-data` 自己的服务绑定，Scheduler 回调 `/internal/scheduler-due` 用
- `DELIVER_QUEUE`：队列 `abot-deliver`；`RULE_EVENTS`：队列 `rule-events`（消费方是 `abot-rules`）
- `workers_dev = false`、`preview_urls = false`：没有公网入口，只经服务绑定访问
- 普通变量 `PUBLIC_ORIGIN = https://abot.run/data`：记录链接和 OAuth 元数据用的对外地址（gateway 去掉 `/data` 前缀后经服务绑定转发）
- 普通变量 `WEBHOOK_DENY_DOMAINS`：逗号分隔，webhook 不能指向这些域名及其子域（本账户自己的 Worker 域名）。localhost、IP、`.internal`、`.local`、`.localhost`、`.localdomain`、`.home.arpa`、`.test`、`.invalid` 和单段主机名总是拒绝，末尾的点会先去掉。投递前会再检查一次，命中则标成 dead，`dead_reason` 为 `url_blocked`

`compatibility_date` 为 `2026-09-01`。

Service Binding 是网关入口。请求带合法的 `X-Abot-Owner-Email` 时按该账户隔离，邮箱不合法则 401。`X-Internal-Token` 不参与鉴权。不带 owner 头时继续走 Bearer。

## D1

- Binding 名固定为 `DB`。
- 表结构来自仓库根目录的 `schema.sql`，可重复执行：16 张表（`contacts`、`calendar_events`、`notes`、`events`、`event_claims`、`write_quotas`、`subscriptions`、`deliveries`、`heartbeats`、`owner_heartbeats`、`accounts`、`account_tokens`、`verification_codes`、`verification_requests`、`oauth_clients`、`oauth_codes`），19 个索引。`event_claims` 是系统事件的按账户租约，已经建好的库会在账户第一次 `poll_events` 或 `ack_event` 时补上。`write_quotas` 是鉴权后的写频率计数，第一次写操作时补上。`owner_heartbeats` 是按 owner 分开的心跳（旧 `heartbeats` 的行作为 legacy 拷入），第一次 `heartbeat` 或 cron 时补上。
- `oauth_clients.redirect_uris` 是 JSON 数组文本，回调地址按字符串精确匹配。`client_secret_hash` 和 `oauth_codes.code_hash` 都是 SHA-256 十六进制，明文不入库。`client_secret_hash` 为空字符串表示公开客户端（不校验 secret，授权必须带 S256 PKCE）。`oauth_codes.code_challenge` 可空，存的是 S256 challenge 原文。已经建好、还没有这一列的 `oauth_codes` 会在下一次签发授权码或换 token 时自动补上。客户端可以由部署方直接写入，也可以通过动态注册 `POST /oauth/register` 创建（每个 IP 每小时 10 个，全局每小时 200 个，记录在 `oauth_client_registrations`）。
- `contacts`、`calendar_events`、`notes` 有可空列 `owner_email`。新建库执行 `schema.sql` 即可，未写入该列的旧行保持 NULL。已经建好、还没有这一列的库要先补列（这三句只跑一次，`schema.sql` 本身不包含它们，因为重复执行 `ADD COLUMN` 会失败）：

```sql
ALTER TABLE contacts ADD COLUMN owner_email TEXT;
ALTER TABLE calendar_events ADD COLUMN owner_email TEXT;
ALTER TABLE notes ADD COLUMN owner_email TEXT;
```
- `events` 和 `subscriptions` 也有可空列 `owner_email`。NULL 表示系统级。新建库执行 `schema.sql` 即可，未写入该列的旧行保持 NULL。已经建好的库不用手跑 ALTER：下次 `emit_event`、`poll_events`、`create_subscription` 或定时检测会补上这两列，并在需要时把 `idx_events_dedupe_open` 改成按 `COALESCE(owner_email, '')` 与 `dedupe_key` 去重。这两步可以重复执行。
- `wrangler.toml` 里的 `database_id` 是占位符。生产库 id 只放在 Workers Builds 的构建变量 `D1_DATABASE_ID`，不写入仓库。
- 生产库 `abot-data` 同时放着其它 Worker 的表（如 `abot-health`、`abot-gateway`、邮件归档）。`schema.sql` 只用 `IF NOT EXISTS`，不碰这些表。

## Cron

`deploy/cloudflare.mjs` 写入 cron `*/5 * * * *`。`scheduled` 做日历到期检测、心跳过期检测、死信检测，以及投递修复（到期投递重新入队、卡住的 inflight 回收）。

## Queues

Producer：`DELIVER_QUEUE` → `abot-deliver`，`RULE_EVENTS` → `rule-events`。

Consumer 由 `deploy/cloudflare.mjs` 写入：

- 队列 `abot-deliver`：`max_batch_size` 5，`max_retries` 3，`max_batch_timeout` 1 秒，死信队列 `abot-deliver-dlq`
- 死信队列 `abot-deliver-dlq`：`max_batch_size` 1，`max_retries` 3，`max_batch_timeout` 1 秒

Worker 用 batch 的 `queue` 名区分：`abot-deliver-dlq` 记死信，其余投递 webhook。

## Secrets

生产 secrets 在控制台 Settings > Variables and Secrets 里维护，绝不进仓库。`wrangler deploy` 保留已有 secret；配置带 `keep_vars`，控制台设的普通变量（如 `WRITE_RATE_LIMIT`）也不会被部署清掉。

- `DATA_MCP_TOKEN`：`POST /mcp` 与 canonical GET 的 legacy Bearer。它仍然能读写联系人、日历和笔记的全部行，`owner_email` 写成 NULL。总线上它写入的事件属于 `legacy`，poll 看到 legacy 事件和库里历史上的系统事件（`owner_email` 为空），不能借此读到账户事件。
- `SUBSCRIPTION_SEAL`：订阅 webhook secret 的封装密钥
- `RESEND_API_KEY`：账户验证码邮件。Worker 只从该环境变量读取，值不进仓库、不进日志。发件人是 `abot-data@abot.run`。
- `SCHEDULER_SECRET`：Durable Object 回调 `POST /internal/scheduler-due` 的 `X-Scheduler-Secret`。Worker 用恒定时间比较（`timingSafeEqual`）核对这个头。
- `INTERNAL_TOKEN`：线上存在这个 secret，但代码不读取它（`X-Internal-Token` 不参与鉴权）。
- `WRITE_RATE_LIMIT`：可选。鉴权后每个身份每 60 秒的写操作上限，默认 120。读操作不计数。身份是账户邮箱，legacy token 共用 `legacy`。

本地密钥文件（`.prod-token`、`.kek_b64`、`.dev.vars`、`.env`、`.env.*`、`*.pem`、`*.key`）已列入 `.gitignore`。
