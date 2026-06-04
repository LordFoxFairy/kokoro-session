# kokoro-session overlay

Use the parent `Kokoro/CLAUDE.md` as the global governance source of truth. This file only adds repo-local guidance.

## Repo purpose
- `kokoro-session` is the browser-facing session service: a thin HTTP + SSE bridge between `kokoro-web` and the agent runtime.
- It owns the browser replay contract. Raw agent events are normalized here into session/replay/SSE events before anything reaches the browser.

## Critical boundaries
- Keep `domain` / `application` / `infrastructure` / `interfaces` responsibilities clean; do not let HTTP, SSE, or Redis details leak upward.
- `src/main.ts` stays wiring-only: select adapters, start relay dispatch, and start the server. Move logic elsewhere.
- Define protocol shapes once and reuse them across layers. Browser-facing session events live in `src/domain/events.ts`; raw agent events and run requests live in `src/domain/agent-events.ts`.
- Do not pass raw agent events through to the browser or duplicate session protocol shapes in interface code, tests, or downstream consumers.

## Where code belongs
- `src/domain/`: Zod schemas and contract types for raw agent input, run requests, and browser-facing session events.
- `src/application/`: orchestration such as `startRun`, `relayRun`, and `Normalizer`; this is where raw agent streams become replayable session events.
- `src/infrastructure/`: stream backends, replay persistence, and SSE serialization details.
- `src/interfaces/`: HTTP routes, request parsing, CORS, and SSE endpoint behavior.
- `tests/`: contract-focused coverage for schemas, normalization, replay/stream adapters, and HTTP/SSE flow.

## Verification checklist
- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun test`.
- If contract shapes change, also check the matching Kokoro spec docs and confirm `kokoro-web` still parses and renders the updated session stream behavior.

## Local pitfalls
- The default backend is in-memory; Redis behavior is only exercised when `KOKORO_STREAM_BACKEND=redis` / `KOKORO_REDIS_URL` are configured, and `tests/stream-port.redis.test.ts` skips entirely if Redis is unavailable.
- Browser access is intentionally narrow: `src/interfaces/http.ts` only allows the configured local web origins by default.
- Replay snapshotting and live SSE continuation both depend on `StreamPort` cursors. If you change event ordering or cursor shape, verify snapshot and live resume behavior together.
