# kokoro-session

Kokoro 三仓里的**会话/传输层**：浏览器面向的 SSE 归属者。
它消费 kokoro-agent 的原始执行事件，归一化成 AGUI 信封，持久落 DB，
再发布 redis live 总线。持久与实时分层后，redis 只保留有界 live 窗口。
本仓只编排，不执行 agent，不渲染。

> 全局架构与起栈见 [根 README](../README.md)。

## 分层（四层 DDD）

```text
src/
├── domain/          agent-event / session-event / run-request
├── application/     normalize / dispatch-relays / relay-run / start-run
├── infrastructure/  session-store / live-bus / sse / stream
└── interfaces/      http.ts（POST /messages + GET /stream）/ sse-endpoint / main.ts
```

`domain/agent-event.ts` 与 `domain/session-event.ts` 由
[`contract/generate.py`](../contract/events.yaml) 生成；改契约改根
`contract/events.yaml`。

## 运行

```bash
npm install
KOKORO_STREAM_BACKEND=redis KOKORO_REDIS_URL=redis://127.0.0.1:6379/10 npm run start
# 默认 :3001；POST /messages 开 run，GET /stream 订阅 SSE
```

**实时总线** `KOKORO_STREAM_BACKEND`：
`memory`（默认，单机）/ `redis`（`KOKORO_REDIS_URL`）。

**历史持久库** `KOKORO_SESSION_STORE_BACKEND`：

- `mongo`（默认，跨 pod，`KOKORO_SESSION_STORE_MONGO_URL` + `KOKORO_SESSION_STORE_MONGO_DB`）
- `memory`（易失，仅测试用）

Session runtime 不提供 SQLite 策略，避免本地文件库成为第二套事实源。
本地开发应通过 Docker/Compose 起 Mongo；单元测试使用 `memory` fake，
Mongo 行为用集成测试覆盖。

`KOKORO_WEB_ORIGIN` 配 CORS 放通的浏览器源。

## 门禁

```bash
npm test                  # 单元 + 集成（redis/mongo 集成不可达则 skip，不 fail）
npm run typecheck
npm run lint
```

## 关键不变量

- **strict 拒收**：入站 zod `.strict()`，缺字段/多余键/未知 kind 抛，绝不污染历史。
- **幂等**：`event_id` 确定性派生；SessionStore 按 `event_id` 落库去重。
- **持久/实时分层**：DB 是长期真源，redis live 有界。
- **续订**：SSE `Last-Event-ID` 使用 opaque `event_id`；
  缺失或未知时全量重放，web 用 `event_id` 去重。
- **终态关流**：`run.completed`/`run.failed` 收束。

测试用例总账见
[测试总目录](../docs/superpowers/specs/2026-06-13-test-case-catalog.md) §4；
协议见 [docs/protocol](../docs/protocol/)。
