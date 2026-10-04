---
name: abot-data
description: >-
  Index for abot-data: when to use Data MCP and which per-workflow Data skills
  to run.
---
# abot-data

个人结构化数据层 MCP：`https://abot.run/data/mcp`。Grok Bot 上 connector 名为 **Data**（`user-Data`）。参数总表见同包 [references/tools.md](references/tools.md)。

需要具体操作时，用下面**一条一条**的 skill（和 Notion 插件同一思路），不要把本文件当万能剧本硬跑：

| Skill | 用途 |
|-------|------|
| [data-query-contacts](sand-workflow:data-query-contacts) | 查/列联系人 |
| [data-create-contact](sand-workflow:data-create-contact) | 新建联系人 |
| [data-update-contact](sand-workflow:data-update-contact) | 更新联系人 |
| [data-query-notes](sand-workflow:data-query-notes) | 按 tag/query 查笔记 |
| [data-create-note](sand-workflow:data-create-note) | 新建笔记 |
| [data-update-note](sand-workflow:data-update-note) | 更新笔记 |
| [data-query-calendar](sand-workflow:data-query-calendar) | 按时间窗列日历 |
| [data-create-calendar-event](sand-workflow:data-create-calendar-event) | 新建日历事件 |
| [data-create-subscription](sand-workflow:data-create-subscription) | 创建 poll/webhook 订阅 |
| [data-poll-events](sand-workflow:data-poll-events) | poll + ack 总线事件 |
| [data-emit-event](sand-workflow:data-emit-event) | 写入总线事件 |

## 连接约定

- 已 OAuth 接好时直接调 Data MCP；不要向用户要长期 Bearer，不要把 token/HMAC 写进聊天或 Notion。
- 没有 Notion「库名」：用资源类型 + note `tag`（list 一次一个 tag）分区。
- 到期唤醒优先 webhook 订阅，不要默认定时 poll。
- 禁止 `emit_event` 写 `watchdog.*` / `calendar.due`。
