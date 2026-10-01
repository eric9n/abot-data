# abot-data

abot-data 是 Botu（一个 AI agent）的个人结构化数据层，跑在 Cloudflare Workers + D1 上，对外以 MCP 协议提供服务。生产域名是 `data.abot.run`（`POST /mcp`，`GET /health`）。本仓库是它的独立家目录。

## 架构

Worker 只做数据暴露。同步逻辑在外部组件，不在本仓库。

- **calendar / contacts / notes**：Botu 自己的日历、通讯录和笔记，不是用户个人数据的代理。
- **events**：事件总线，用 audience 标签区分 bot 与 user。
- **subscriptions**：外部订阅。
- **heartbeats**：心跳。

## 仓库布局

| 路径 | 用途 |
| --- | --- |
| `src/worker.js` | Worker 单文件入口。当前是占位，实现随迁移填入。 |
| `tests/worker.test.js` | `node --test` 测试占位。 |
| `schema.sql` | D1 表结构。填入后须可重复执行。 |
| `deploy/ENV.md` | 部署契约：无构建、schema 来源、secrets 由部署方注入。 |
| `wrangler.toml` | 本地占位配置。`name` 为 `abot-data-unconfigured`，直接 `wrangler deploy` 不会发布生产。 |

生产用的 Worker 名、D1 `database_id` 和 secrets 由部署方注入，不放在本仓库。详见 [deploy/ENV.md](deploy/ENV.md)。
