import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"

import { ZodError } from "zod"

import { startRun } from "../application/start_run"
import { A2uiProjector } from "../application/a2ui-projector"
import { parseSessionEvent, type SessionEvent } from "../domain/events"
import { permissionDecisionBodySchema, permissionRequestIdForRun } from "../domain/permissions"
import type { ReplayStore } from "../infrastructure/replay_store"
import { replayStream } from "../infrastructure/replay_store"
import type { StreamPort } from "../infrastructure/stream-port"
import { toA2uiSseChunk } from "../infrastructure/sse"

const allowedBrowserOrigins = new Set([
  process.env.KOKORO_WEB_ORIGIN ?? "http://127.0.0.1:3000",
  "http://localhost:3000",
])

// 开发态只显式放通本地 web 源，避免把 session 端口无界暴露给其它来源。
function applyBrowserHeaders(req: IncomingMessage, res: ServerResponse): void {
  const requestOrigin = req.headers.origin
  if (requestOrigin && allowedBrowserOrigins.has(requestOrigin)) {
    res.setHeader("access-control-allow-origin", requestOrigin)
    res.setHeader("vary", "origin")
  }
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  res.setHeader("access-control-allow-headers", "content-type")
}

export type BuildServerDependencies = {
  streamPort: StreamPort
  replayStore: ReplayStore
  newEventId?: () => string
  now?: () => Date
}

function sessionIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean)
  if (segments[0] !== "sessions") {
    return null
  }
  return segments[1] || null
}

function defaultEventId(): string {
  return randomUUID()
}

function defaultNow(): Date {
  return new Date()
}

function defaultRunId(): string {
  return `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`
}

const permissionDecisionQueues = new Map<string, Promise<void>>()

async function withPermissionDecisionQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = permissionDecisionQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => current)
  permissionDecisionQueues.set(key, queued)

  await previous
  try {
    return await work()
  } finally {
    release()
    if (permissionDecisionQueues.get(key) === queued) {
      permissionDecisionQueues.delete(key)
    }
  }
}

export function buildServer(dependencies: BuildServerDependencies) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, dependencies).catch((error: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : "internal error")
      } else {
        res.end()
      }
    })
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: BuildServerDependencies,
): Promise<void> {
  applyBrowserHeaders(req, res)
  const newEventId = dependencies.newEventId ?? defaultEventId
  const now = dependencies.now ?? defaultNow

  if (req.method === "OPTIONS") {
    res.statusCode = 204
    res.end()
    return
  }

  if (!req.url) {
    res.statusCode = 400
    res.end("missing url")
    return
  }

  const requestUrl = new URL(req.url, "http://127.0.0.1")
  const sessionId = sessionIdFromPath(requestUrl.pathname)

  if (
    req.method === "POST" &&
    sessionId &&
    requestUrl.pathname === `/sessions/${sessionId}/runs`
  ) {
    const input = requestUrl.searchParams.get("input")
    if (!input) {
      res.statusCode = 400
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: "missing input" }))
      return
    }

    const fixture = requestUrl.searchParams.get("fixture")
    if (fixture === "permission") {
      const runId = defaultRunId()
      await appendPermissionFixture({
        sessionId,
        conversationId: requestUrl.searchParams.get("conversation_id") ?? sessionId,
        runId,
        replayStore: dependencies.replayStore,
        newEventId,
        now,
      })
      res.statusCode = 200
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ runId }))
      return
    }

    const result = await startRun(
      {
        sessionId,
        conversationId: requestUrl.searchParams.get("conversation_id") ?? undefined,
        input,
        executionStyle: requestUrl.searchParams.get("execution_style") ?? undefined,
      },
      { streamPort: dependencies.streamPort },
    )
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(result))
    return
  }

  const segments = requestUrl.pathname.split("/").filter(Boolean)
  if (
    req.method === "POST" &&
    sessionId &&
    segments.length === 5 &&
    segments[0] === "sessions" &&
    segments[1] === sessionId &&
    segments[2] === "permissions" &&
    segments[4] === "decision"
  ) {
    await decidePermission(req, res, dependencies, sessionId, segments[3] ?? "", newEventId, now)
    return
  }

  if (
    req.method === "GET" &&
    sessionId &&
    requestUrl.pathname === `/sessions/${sessionId}/stream`
  ) {
    await streamSession(req, res, dependencies, sessionId)
    return
  }

  res.statusCode = 404
  res.end("not found")
}

// 先回放快照，再从末游标续订（SSE）。每个连接独立 projector 把 SessionEvent 投影成 A2UI op。
async function streamSession(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: BuildServerDependencies,
  sessionId: string,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })

  const projector = new A2uiProjector(sessionId)
  const writeEvent = (event: SessionEvent): void => {
    projector.project(event).forEach((op, i) => {
      res.write(toA2uiSseChunk(op, `${event.cursor}:${i}`))
    })
  }

  // 用 readAll 拿快照：StreamItem.cursor 是后端原生流位置（redis 流 ID / 内存序号），
  // 续订必须用它，而不是 SessionEvent.cursor（归一化游标 run_id:NNNN）——后者非法会让
  // redis XREAD 抛错、提前结束 SSE，导致浏览器反复重连重放。
  const stream = replayStream(sessionId)
  const snapshot = await dependencies.streamPort.readAll(stream)
  let lastStreamId: string | undefined = undefined
  for (const item of snapshot) {
    writeEvent(parseSessionEvent(item.event))
    lastStreamId = item.cursor
  }

  let aborted = false
  req.on("close", () => {
    aborted = true
  })

  for await (const item of dependencies.streamPort.subscribe(stream, lastStreamId)) {
    if (aborted) break
    writeEvent(parseSessionEvent(item.event))
  }
  res.end()
}

async function appendPermissionFixture(opts: {
  sessionId: string
  conversationId: string
  runId: string
  replayStore: ReplayStore
  newEventId: () => string
  now: () => Date
}): Promise<void> {
  const requestId = permissionRequestIdForRun(opts.runId)
  const timestamp = opts.now().toISOString()
  await opts.replayStore.append(opts.sessionId, [
    {
      event: "session.created",
      event_id: opts.newEventId(),
      session_id: opts.sessionId,
      conversation_id: opts.conversationId,
      run_id: opts.runId,
      cursor: `${opts.runId}:0001`,
      timestamp,
      payload: {
        session_id: opts.sessionId,
        conversation_id: opts.conversationId,
        owner_id: "kokoro-session",
      },
    },
    {
      event: "run.created",
      event_id: opts.newEventId(),
      session_id: opts.sessionId,
      conversation_id: opts.conversationId,
      run_id: opts.runId,
      cursor: `${opts.runId}:0002`,
      timestamp,
      payload: { run_id: opts.runId },
    },
    {
      event: "permission.required",
      event_id: opts.newEventId(),
      session_id: opts.sessionId,
      conversation_id: opts.conversationId,
      run_id: opts.runId,
      cursor: `${opts.runId}:0003`,
      timestamp,
      payload: {
        request_id: requestId,
        decision: "ask",
        scope: "session",
        message: "我想访问这个外部资源，可以吗？",
        options: ["once", "session", "deny"],
        kind: "permission",
      },
    },
  ])
}

async function decidePermission(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: BuildServerDependencies,
  sessionId: string,
  requestId: string,
  newEventId: () => string,
  now: () => Date,
): Promise<void> {
  try {
    const body = permissionDecisionBodySchema.parse(await readJson(req))
    const payload = await withPermissionDecisionQueue(`${sessionId}:${requestId}`, async () => {
      const stream = replayStream(sessionId)
      const snapshot = await dependencies.streamPort.readAll(stream)
      const current = snapshot
        .map((item) => parseSessionEvent(item.event))
        .filter((event) => event.event === "permission.required" && event.payload.request_id === requestId)
        .at(-1)

      if (!current) {
        return { kind: "not_found" as const }
      }

      if (current.payload.decision !== "ask") {
        return { kind: "resolved" as const, payload: current.payload }
      }

      const runEvents = snapshot
        .map((item) => parseSessionEvent(item.event))
        .filter((event) => event.run_id === current.run_id)
      const nextSeq = runEvents
        .map((event) => Number(event.cursor.split(":").at(-1) ?? 0))
        .reduce((max, n) => Math.max(max, Number.isFinite(n) ? n : 0), 0) + 1

      const nextPayload = body.decision === "allow"
        ? {
            request_id: requestId,
            decision: "allow" as const,
            scope: body.scope,
            message: body.scope === "session"
              ? "本会话内同类动作已允许继续。"
              : "这一步已经允许继续了。",
            kind: current.payload.kind,
          }
        : {
            request_id: requestId,
            decision: "deny" as const,
            message: "这一步未被允许继续。",
            kind: current.payload.kind,
          }

      await dependencies.replayStore.append(sessionId, [{
        event: "permission.required",
        event_id: newEventId(),
        session_id: current.session_id,
        conversation_id: current.conversation_id,
        run_id: current.run_id,
        cursor: `${current.run_id}:${String(nextSeq).padStart(4, "0")}`,
        timestamp: now().toISOString(),
        payload: nextPayload,
      }])

      return { kind: "appended" as const, payload: nextPayload }
    })

    if (payload.kind === "not_found") {
      res.statusCode = 404
      res.end("unknown permission request")
      return
    }

    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(payload.payload))
  } catch (error: unknown) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      res.statusCode = 400
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ error: "invalid decision payload" }))
      return
    }
    throw error
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : {}
}
