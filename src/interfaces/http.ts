import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { startRun } from "../application/start_run"
import { parseSessionEvent } from "../domain/events"
import type { ReplayStore } from "../infrastructure/replay_store"
import { replayStream } from "../infrastructure/replay_store"
import type { StreamPort } from "../infrastructure/stream-port"
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

  res.statusCode = 404
  res.end("not found")
}

// 从 replay 流首订阅即「先回放历史、再续订实时」：replay 流本身就是该 session 的全量历史。
// 统一用传输层 stream id 作续订游标——不再把领域 envelope.cursor 误当 Redis id
// （那会让 Redis 后端 xread 收到非法 id 而静默断流；memory 后端则恰好掩盖了这个 bug）。
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
  let aborted = false
  req.on("close", () => {
    aborted = true
  })

  for await (const item of dependencies.streamPort.subscribe(stream)) {
    if (aborted) break
    res.write(toSseChunk(parseSessionEvent(item.event)))
  }
  res.end()
}
