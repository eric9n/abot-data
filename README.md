# abot-data

abot-data 是 bot 的个人结构化数据层，跑在 Cloudflare Workers + D1 上，对外以 MCP 协议提供服务。

给 agent 用的操作指南在 [skills/abot-data/](skills/abot-data/SKILL.md)。

## 架构

MCP 只做数据暴露。同步逻辑在外部组件，不在本仓库。

Worker 是多模块：主模块 `src/worker.js`，辅助模块 `src/phase2.js`。D1 表结构在 `schema.sql`（16 张表、19 个索引）。投递队列是 `abot-deliver`，死信队列是 `abot-deliver-dlq`。

- **calendar / contacts / notes**：bot 自己的日历、通讯录和笔记，不是用户个人数据的代理。`DATA_MCP_TOKEN` 仍看全部行。`ad_` 账户 token 只看 `owner_email` 等于自己的行。
- **accounts**：一个邮箱一个 agent 账户。`request_account_verification` 和 `verify_account` 不需要 Bearer；验证码经 Resend 发出，token 只在验证成功时返回一次。
- **oauth**：connector 用 authorization code 绑定同一个账户。`GET /oauth/authorize` 渲染邮箱验证页，可以额外带 `code_challenge` 和 `code_challenge_method=S256`（只支持 S256；带了 challenge 但 method 不是 S256 会拒绝）。表单 POST 回同一地址发码、验码，通过后 302 回 `redirect_uri`，challenge 记在这条授权码上。`POST /oauth/token` 换 `ad_` token：登记了 secret 的客户端仍要校验 `client_secret`；授权码绑了 challenge 时必须带 `code_verifier`，S256（无填充的 base64url(SHA-256)）不一致就拒绝，并且不消耗授权码。`client_secret_hash` 为空字符串表示公开客户端，不校验 secret，授权时必须带 S256 challenge。不带 challenge 的 secret 流程保持可用。客户端登记在 `oauth_clients`（secret 只存 SHA-256，`redirect_uris` 是精确匹配的 JSON 数组）。授权码 10 分钟、一次性，库里只存 SHA-256。换到的 access token 是该邮箱在这个客户端下的 `ad_` token（存在 `account_tokens`），同一客户端再次授权只轮换它自己的 token，不影响 `verify_account` 拿到的主 token 和其它客户端。
- **events**：事件总线，用 audience 标签区分 bot 与 user。`ad_` token 写入的事件属于该邮箱，poll 只能看到自己的事件和 `owner_email` 为空的系统事件。系统事件按账户单独租约，一个账户 poll 或 ack 不会挡住其他账户。`DATA_MCP_TOKEN` 写入的事件属于 `legacy`（不是邮箱，任何账户都匹配不到），只有 legacy 订阅看得到和收得到；legacy poll 看到自己的事件和系统事件。系统事件只剩库里历史上 `owner_email` 为空的行。`calendar.due` 带日历行的 `owner_email`，无主日历行归 `legacy`，都不会当成系统事件广播。去重按 owner 分开。`not_before` 超过 7 天仍未 ack 的事件由 cron 标成 `expired`；已 ack 或已过期超过 30 天的事件连同租约和终态投递一起删除。
- **subscriptions**：外部订阅，webhook 推送支持 HMAC 与 Bearer 两种鉴权。创建时记下调用方邮箱；legacy 创建的订阅 `owner_email` 为空，只有 legacy token 能读、改、删、轮换和 poll。`ad_` token 不能把这种订阅当成总线旁路。别人的订阅与不存在一样，返回 not found。有 owner 的事件只投递给同一个 owner 的 webhook。
- **heartbeats**：心跳，按账户（或 legacy）分开记录和检测，见 `owner_heartbeats`。

## Webhook 鉴权

`subscriptions.webhook_auth` 决定投递怎么鉴权，默认 `hmac`。两种模式都把密钥密封进 `secret_sealed`（密钥由 secret `SUBSCRIPTION_SEAL` 封装）。`get_subscription` 和 `list_subscriptions` 返回 `webhook_auth` 与 `has_secret`，不返回密钥本身。已经建好的 `subscriptions` 表在下次读取或投递时会补上这一列，旧行按 `hmac` 处理。

- **hmac**（不传 `bearer_token`）：服务端生成 secret，只在 `create_subscription` 或 `rotate_subscription_secret` 的响应里出现一次。投递头保持 `x-abot-signature: v1=<hmac>`，并带 `user-agent`、`x-abot-timestamp`、`x-abot-event-id`、`x-abot-subscription-id`。
- **bearer**（订阅方提供 `bearer_token`）：仅 webhook 模式。token 为 1～500 字符，拒绝控制字符和换行，以免注入投递头。响应不回显 token。投递头为 `Authorization: Bearer <token>`，保留上面四个头，不带 `x-abot-signature`。poll 传入 `bearer_token` 会拒绝。轮换 bearer 订阅时必须再提供新 token，同样不回显；hmac 订阅仍由服务端生成。

生产 secrets（`DATA_MCP_TOKEN`、`SUBSCRIPTION_SEAL`、`RESEND_API_KEY`、`SCHEDULER_SECRET`）和真实 D1 `database_id` 不进入仓库。普通变量 `PUBLIC_ORIGIN`（对外地址 `https://abot.run/data`）和 `WEBHOOK_DENY_DOMAINS`（webhook 禁止指向的本账户域名）由部署脚本写入，见 `deploy/ENV.md`。

## 部署

唯一的发布方式是 Cloudflare 控制台里 `abot-data` 的 Workers Builds：推到 `main` 后自动执行 `npm test && node deploy/cloudflare.mjs build`，再执行 `node deploy/cloudflare.mjs deploy`（先跑幂等的 `schema.sql`，再 `wrangler deploy`）。脚本在 Workers Builds 之外直接退出，根目录 `wrangler.toml` 只用于本地开发。详见 [deploy/ENV.md](deploy/ENV.md)。
