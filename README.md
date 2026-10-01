# abot-data

abot-data 是 bot 的个人结构化数据层，跑在 Cloudflare Workers + D1 上，对外以 MCP 协议提供服务。

## 架构

MCP 只做数据暴露。同步逻辑在外部组件，不在本仓库。

Worker 是多模块：主模块 `src/worker.js`，辅助模块 `src/phase2.js`。D1 表结构在 `schema.sql`（7 张表、11 个索引）。投递队列是 `abot-deliver`，死信队列是 `abot-deliver-dlq`。

- **calendar / contacts / notes**：bot 自己的日历、通讯录和笔记，不是用户个人数据的代理。
- **events**：事件总线，用 audience 标签区分 bot 与 user。
- **subscriptions**：外部订阅，webhook 推送支持 HMAC 与 Bearer 两种鉴权。
- **heartbeats**：心跳。

## Webhook 鉴权

`subscriptions.webhook_auth` 决定投递怎么鉴权，默认 `hmac`。两种模式都把密钥密封进 `secret_sealed`（密钥由部署方注入的 `SUBSCRIPTION_SEAL` 封装）。`get_subscription` 和 `list_subscriptions` 返回 `webhook_auth` 与 `has_secret`，不返回密钥本身。已经建好的 `subscriptions` 表在下次读取或投递时会补上这一列，旧行按 `hmac` 处理。

- **hmac**（不传 `bearer_token`）：服务端生成 secret，只在 `create_subscription` 或 `rotate_subscription_secret` 的响应里出现一次。投递头保持 `x-abot-signature: v1=<hmac>`，并带 `user-agent`、`x-abot-timestamp`、`x-abot-event-id`、`x-abot-subscription-id`。
- **bearer**（订阅方提供 `bearer_token`）：仅 webhook 模式。token 为 1～500 字符，拒绝控制字符和换行，以免注入投递头。响应不回显 token。投递头为 `Authorization: Bearer <token>`，保留上面四个头，不带 `x-abot-signature`。poll 传入 `bearer_token` 会拒绝。轮换 bearer 订阅时必须再提供新 token，同样不回显；hmac 订阅仍由服务端生成。

生产 secrets（`DATA_MCP_TOKEN`、`SUBSCRIPTION_SEAL`）和真实 D1 `database_id` 由部署方注入，不进入仓库。部署约定见 [deploy/ENV.md](deploy/ENV.md)。
