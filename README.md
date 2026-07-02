# kokoro-session

Kokoro 三仓里的**会话/传输层**：浏览器面向的 SSE 归属者。消费 kokoro-agent 的原始执行事件 →
归一化成 AGUI 信封（去重、补归属、派生 render `seq`、确定性 `event_id`）→ **持久落 DB（长期真源）+ 发布
redis live 总线（有界实时）** → SSE = **DB 历史回放 + live tail** + `Last-Event-ID` 增量续订。
持久与实时分层后，redis 只留有界 live 窗口、不再无界堆历史。**只编排，不执行 agent，不渲染。**

> 全局架构与起栈见 [根 README](../README.md)。

## 分层（四层 DDD）

```
src/
├── domain/          agent-event.ts（入站契约）/ session-event.ts（出站 AGUI 契约）/ run-request.ts
├── application/     normalize（13-kind → AGUI 信封）/ dispatch-relays / relay-run / start-run / ports
├── infrastructure/  message-store（mongo 默认/memory 测试，持久真源）/ live-bus（redis 有界实时）/ sse / stream（memory + redis）
└── interfaces/      http.ts（POST /messages + GET /events）/ sse-endpoint / main.ts
```

`domain/agent-event.ts` 与 `domain/session-event.ts` 由 [`contract/generate.py`](../contract/events.yaml) **生成**（`DO NOT EDIT`）；改契约改根 `contract/events.yaml`。

## 运行

```bash
npm install
KOKORO_STREAM_BACKEND=redis KOKORO_REDIS_URL=redis://127.0.0.1:6379/10 npm run dev
# 默认 :3001；POST /sessions/:id/messages 开 run，GET /sessions/:id/events 订阅 SSE
```

**实时总线** `KOKORO_STREAM_BACKEND`：`memory`（默认，单机）/ `redis`（`KOKORO_REDIS_URL`）。

**历史持久库** `KOKORO_MESSAGE_STORE_BACKEND`：
- `mongo`（默认，跨 pod，`KOKORO_MESSAGE_STORE_MONGO_URL` + `KOKORO_MESSAGE_STORE_MONGO_DB`）
- `memory`（易失，仅测试用）

Session runtime 不提供 SQLite 策略，避免本地文件库成为第二套事实源。本地开发应通过 Docker/Compose 起 Mongo；
单元测试使用 `memory` fake，Mongo 行为用集成测试覆盖。

`KOKORO_WEB_ORIGIN` 配 CORS 放通的浏览器源（默认 `http://127.0.0.1:3000` + `localhost:3000`）。

## 门禁

```bash
npm test                  # 单元 + 集成（redis/mongo 集成不可达则 skip，不 fail）
npm run typecheck
npm run lint
```

## 关键不变量

- **strict 拒收**：入站 zod `.strict()`，缺字段/多余键/未知 kind 抛，绝不污染历史。
- **幂等**：`event_id` 确定性派生（去重锚），重启/多副本/relay 重投收敛；MessageStore 按 `event_id` 落库去重（保首条 cursor 稳定）。
- **持久/实时分层**：DB 是长期真源、redis live 有界；SSE 正确性不依赖 redis 保留时长——裁掉的历史由 DB 补全。
- **续订**：合法传输游标 `afterCursor` 增量；畸形/缺失 → 全量重放 + web `event_id` 去重兜底，绝不静默空流。
- **终态关流**：`run.completed`/`run.failed` 收束。

测试用例总账见 [测试总目录](../docs/superpowers/specs/2026-06-13-test-case-catalog.md) §4；协议见 [docs/protocol](../docs/protocol/)。
