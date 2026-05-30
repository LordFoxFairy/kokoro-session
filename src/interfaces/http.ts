import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { startRun } from "../application/start_run"
import { parseSessionEvent } from "../domain/events"
import type { ReplayStore } from "../infrastructure/replay_store"
import { readReplaySnapshot, replayStream } from "../infrastructure/replay_store"
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

// 先回放快照，再从末游标续订（SSE）。断连时清理订阅，避免泄漏。
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

  const snapshot = await readReplaySnapshot(dependencies.streamPort, sessionId)
  let lastCursor = ""
  for (const event of snapshot) {
    res.write(toSseChunk(event))
    lastCursor = event.cursor
  }

  const stream = replayStream(sessionId)
  let aborted = false
  req.on("close", () => {
    aborted = true
  })

  for await (const item of dependencies.streamPort.subscribe(stream, lastCursor)) {
    if (aborted) break
    res.write(toSseChunk(parseSessionEvent(item.event)))
  }
  res.end()
}
