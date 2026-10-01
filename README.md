# abot-data

abot-data 是 bot 的个人结构化数据层，跑在 Cloudflare Workers + D1 上，对外以 MCP 协议提供服务。

## 架构

MCP 只做数据暴露。同步逻辑在外部组件，不在本仓库。

Worker 是多模块：主模块 `src/worker.js`，辅助模块 `src/phase2.js`。D1 表结构在 `schema.sql`（7 张表、11 个索引）。投递队列是 `abot-deliver`，死信队列是 `abot-deliver-dlq`。

- **calendar / contacts / notes**：bot 自己的日历、通讯录和笔记，不是用户个人数据的代理。
- **events**：事件总线，用 audience 标签区分 bot 与 user。
- **subscriptions**：外部订阅，包含 webhook 推送模式。
- **heartbeats**：心跳。

生产 secrets（`DATA_MCP_TOKEN`、`SUBSCRIPTION_SEAL`）和真实 D1 `database_id` 由部署方注入，不进入仓库。部署约定见 [deploy/ENV.md](deploy/ENV.md)。
