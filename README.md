# kokoro-session

Kokoro 三仓里的**会话/传输层**：浏览器面向的 SSE/replay 归属者。消费 kokoro-agent 的原始
执行事件 → 归一化成 AGUI 信封（去重、补归属、透传 `seq`、确定性 `event_id`）→ 写 per-session
replay 流 → SSE fan-out + `Last-Event-ID` 增量续订。**只编排，不执行 agent，不渲染。**

> 全局架构与起栈见 [根 README](../README.md)。

## 分层（四层 DDD）

```
src/
├── domain/          agent-event.ts（入站契约）/ session-event.ts（出站 AGUI 契约）/ run-request.ts
├── application/     normalize（13-kind → AGUI 信封）/ dispatch-relays / start-run / ports（抽象）
├── infrastructure/  replay-store / sse / stream-port（memory + redis 双后端）
└── interfaces/      http.ts（POST /runs + GET /stream）/ main.ts
```

`domain/agent-event.ts` 与 `domain/session-event.ts` 由 [`contract/generate.py`](../contract/events.yaml) **生成**（`DO NOT EDIT`）；改契约改根 `contract/events.yaml`。

## 运行

```bash
bun install
KOKORO_STREAM_BACKEND=redis KOKORO_REDIS_URL=redis://127.0.0.1:6379/10 bun run src/main.ts
# 默认 :3001；POST /sessions/:id/runs?input=... 开 run，GET /sessions/:id/stream 订阅 SSE
```

`KOKORO_WEB_ORIGIN` 配 CORS 放通的浏览器源（默认 `http://127.0.0.1:3000` + `localhost:3000`）。

## 门禁

```bash
bun test            # 单元 + 集成（http / normalize / start-run / stream-port；redis 集成不可达则 skip）
bun run typecheck
bun run lint
```

## 关键不变量

- **strict 拒收**：入站 zod `.strict()`，缺字段/多余键/未知 kind 抛，绝不污染 replay。
- **幂等**：`(run_id, seq)` 去重；`event_id` 确定性派生，重启/多副本重放收敛。
- **续订**：合法传输游标增量续传；畸形/缺失 → 全量重放 + 去重兜底，绝不静默空流。
- **终态关流**：`run.completed`/`run.failed` 收束。

测试用例总账见 [测试总目录](../docs/superpowers/specs/2026-06-13-test-case-catalog.md) §4；协议见 [docs/protocol](../docs/protocol/)。
