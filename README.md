# abot-data

abot-data 是 bot 的个人结构化数据层，跑在 Cloudflare Workers + D1 上，对外以 MCP 协议提供服务。

给 agent 用的操作指南在 [skills/abot-data/](skills/abot-data/SKILL.md)。

## 架构

MCP 只做数据暴露。同步逻辑在外部组件，不在本仓库。

Worker 是多模块：主模块 `src/worker.js`，辅助模块 `src/phase2.js`。D1 表结构在 `schema.sql`（12 张表、17 个索引）。投递队列是 `abot-deliver`，死信队列是 `abot-deliver-dlq`。

- **calendar / contacts / notes**：bot 自己的日历、通讯录和笔记，不是用户个人数据的代理。`DATA_MCP_TOKEN` 仍看全部行。`ad_` 账户 token 只看 `owner_email` 等于自己的行。
- **accounts**：一个邮箱一个 agent 账户。`request_account_verification` 和 `verify_account` 不需要 Bearer；验证码经 Resend 发出，token 只在验证成功时返回一次。
- **oauth**：connector 用 authorization code 绑定同一个账户。`GET /oauth/authorize` 渲染邮箱验证页，可以额外带 `code_challenge` 和 `code_challenge_method=S256`（只支持 S256；带了 challenge 但 method 不是 S256 会拒绝）。表单 POST 回同一地址发码、验码，通过后 302 回 `redirect_uri`，challenge 记在这条授权码上。`POST /oauth/token` 换 `ad_` token：登记了 secret 的客户端仍要校验 `client_secret`；授权码绑了 challenge 时必须带 `code_verifier`，S256（无填充的 base64url(SHA-256)）不一致就拒绝，并且不消耗授权码。`client_secret_hash` 为空字符串表示公开客户端，不校验 secret，授权时必须带 S256 challenge。不带 challenge 的 secret 流程保持可用。客户端登记在 `oauth_clients`（secret 只存 SHA-256，`redirect_uris` 是精确匹配的 JSON 数组）。授权码 10 分钟、一次性，库里只存 SHA-256。换到的 access token 就是该邮箱的 `ad_` token，再次签发会轮换并使旧 token 失效。
- **events**：事件总线，用 audience 标签区分 bot 与 user。`ad_` token 写入的事件属于该邮箱，poll 只能看到自己的事件和 `owner_email` 为空的系统事件。`DATA_MCP_TOKEN` 写入系统事件，poll 看到全部。去重按账户分开。
- **subscriptions**：外部订阅，webhook 推送支持 HMAC 与 Bearer 两种鉴权。创建时记下调用方邮箱；legacy 创建的订阅 `owner_email` 为空。poll 只能使用自己的订阅或系统订阅，否则与不存在的订阅一样返回 not found。
- **heartbeats**：心跳。

## Webhook 鉴权

`subscriptions.webhook_auth` 决定投递怎么鉴权，默认 `hmac`。两种模式都把密钥密封进 `secret_sealed`（密钥由部署方注入的 `SUBSCRIPTION_SEAL` 封装）。`get_subscription` 和 `list_subscriptions` 返回 `webhook_auth` 与 `has_secret`，不返回密钥本身。已经建好的 `subscriptions` 表在下次读取或投递时会补上这一列，旧行按 `hmac` 处理。

- **hmac**（不传 `bearer_token`）：服务端生成 secret，只在 `create_subscription` 或 `rotate_subscription_secret` 的响应里出现一次。投递头保持 `x-abot-signature: v1=<hmac>`，并带 `user-agent`、`x-abot-timestamp`、`x-abot-event-id`、`x-abot-subscription-id`。
- **bearer**（订阅方提供 `bearer_token`）：仅 webhook 模式。token 为 1～500 字符，拒绝控制字符和换行，以免注入投递头。响应不回显 token。投递头为 `Authorization: Bearer <token>`，保留上面四个头，不带 `x-abot-signature`。poll 传入 `bearer_token` 会拒绝。轮换 bearer 订阅时必须再提供新 token，同样不回显；hmac 订阅仍由服务端生成。

生产 secrets（`DATA_MCP_TOKEN`、`SUBSCRIPTION_SEAL`、`RESEND_API_KEY`）和真实 D1 `database_id` 由部署方注入，不进入仓库。部署约定见 [deploy/ENV.md](deploy/ENV.md)。
