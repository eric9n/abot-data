# 部署契约

本仓库是 abot-data 的部署约定。这里没有生产密钥，`wrangler.toml` 也不能直接发布生产。

## Worker

- 入口是单个文件 `src/worker.js`，没有构建步骤。
- `wrangler.toml` 的 Worker 名是占位 `abot-data-unconfigured`，且没有 `data.abot.run` 路由。直接执行 `wrangler deploy` 不会发布生产。
- 生产 Worker 名、路由和其他运行配置由部署方在发布时注入。

## D1

- Binding 名固定为 `DB`。
- 表结构来自仓库根目录的 `schema.sql`。
- `schema.sql` 必须可以重复执行。当前文件只有占位注释，真实语句在迁移时写入。
- `wrangler.toml` 里的 `database_id` 是占位符。生产库 id 由部署方注入，不写入仓库。

## Secrets

生产 secrets 由部署方注入，例如 `DATA_MCP_TOKEN`。密钥值不进入 git。本地密钥文件（`.prod-token`、`.kek_b64`、`.dev.vars`、`.env` 等）已列入 `.gitignore`。
