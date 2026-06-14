import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { ZodError } from "zod"

import type { ReplayStore, StreamPort } from "../application/ports"
import { sendRunControl, startRun } from "../application/start-run"
import { parseSessionEvent } from "../domain/session-event"
import { replayStream } from "../infrastructure/replay-store"
import { toSseChunk } from "../infrastructure/sse"

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
}

function sessionIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean)
  if (segments.length !== 3 || segments[0] !== "sessions") {
    return null
  }
  return segments[1] || null
}

export function buildServer(dependencies: BuildServerDependencies) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, dependencies).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      // ZodError 来自入参 schema 校验：客户端错误归 400，不让其穿透成 500。
      if (error instanceof ZodError) {
        res.statusCode = 400
        res.setHeader("content-type", "application/json")
        const detail = error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")
        res.end(JSON.stringify({ error: detail || "invalid request" }))
        return
      }
      res.statusCode = 500
      res.end(error instanceof Error ? error.message : "internal error")
    })
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: BuildServerDependencies,
): Promise<void> {
  applyBrowserHeaders(req, res)

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
    const result = await startRun(
      {
        sessionId,
        conversationId: requestUrl.searchParams.get("conversation_id") ?? undefined,
        input,
        executionStyle: requestUrl.searchParams.get("execution_style") ?? undefined,
        permissionMode: requestUrl.searchParams.get("permission_mode") ?? undefined,
      },
      { streamPort: dependencies.streamPort },
    )
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(result))
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

  // HITL 反向通道：web 批准/拒绝待批工具(approve/reject) 或放弃整个 run(cancel) → 写 control 流。
  const controlRunId = requestUrl.pathname.match(
    /^\/sessions\/[^/]+\/runs\/([^/]+)\/control$/,
  )?.[1]
  if (req.method === "POST" && controlRunId) {
    const decision = requestUrl.searchParams.get("decision")
    if (decision !== "approve" && decision !== "reject" && decision !== "cancel") {
      res.statusCode = 400
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({ error: "decision must be approve, reject or cancel" }),
      )
      return
    }
    await sendRunControl(
      { runId: controlRunId, decision },
      { streamPort: dependencies.streamPort },
    )
    res.statusCode = 202
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ ok: true }))
    return
  }

  res.statusCode = 404
  res.end("not found")
}

// Last-Event-ID 仅当是传输层游标（memory 纯数字 / redis "ms-seq"）才作续点；域 cursor 或畸形值
// 一律忽略、退回全量重放（reducer 端 eventId 去重兜底），避免升级过渡期静默空流。
export function resumeCursor(lastEventId: string | string[] | undefined): string | undefined {
  if (typeof lastEventId !== "string") return undefined
  return /^\d+(-\d+)?$/.test(lastEventId) ? lastEventId : undefined
}

// 续订：带 Last-Event-ID（= 上次 SSE id = replay 流 transport cursor）则从该续点增量续传；
// 否则从流首全量回放（先历史后实时）。transport cursor 全局单调、可作续点，区别于 per-run 域 cursor。
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

  const stream = replayStream(sessionId)
  const fromCursor = resumeCursor(req.headers["last-event-id"])
  let aborted = false
  req.on("close", () => {
    aborted = true
  })

  for await (const item of dependencies.streamPort.subscribe(stream, fromCursor)) {
    if (aborted) break
    res.write(toSseChunk(item.cursor, parseSessionEvent(item.event)))
  }
  res.end()
}
