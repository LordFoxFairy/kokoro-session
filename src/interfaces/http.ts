import { createServer } from "node:http"

import type { SessionReplayStore } from "../application/ports"
import { startRun } from "../application/start_run"
import { memoryReplayStore } from "../infrastructure/replay_store"
import { toSseChunk } from "../infrastructure/sse"

const allowedBrowserOrigins = new Set([
  process.env.KOKORO_WEB_ORIGIN ?? "http://127.0.0.1:3000",
  "http://localhost:3000",
])

function applyBrowserHeaders(
  req: Parameters<typeof createServer>[0] extends (
    req: infer Request,
    res: unknown,
  ) => unknown
    ? Request
    : never,
  res: Parameters<typeof createServer>[0] extends (
    req: unknown,
    res: infer Response,
  ) => unknown
    ? Response
    : never,
) {
  // 开发态只显式放通本地 web 源，避免把 session 端口无界暴露给其它来源。
  const requestOrigin = req.headers.origin

  if (requestOrigin && allowedBrowserOrigins.has(requestOrigin)) {
    res.setHeader("access-control-allow-origin", requestOrigin)
    res.setHeader("vary", "origin")
  }

  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  res.setHeader("access-control-allow-headers", "content-type")
}

export type BuildServerDependencies = {
  replayStore: SessionReplayStore
}

const defaultDependencies: BuildServerDependencies = {
  replayStore: memoryReplayStore,
}

function sessionIdFromPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean)
  if (segments.length !== 3) {
    return null
  }

  if (segments[0] !== "sessions") {
    return null
  }

  return segments[1] || null
}

export function buildServer(
  dependencies: BuildServerDependencies = defaultDependencies,
) {
  return createServer(async (req, res) => {
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
      const result = await startRun({
        sessionId,
        conversationId: requestUrl.searchParams.get("conversation_id") ?? sessionId,
        input: requestUrl.searchParams.get("input") ?? "hello kokoro",
        executionStyle: requestUrl.searchParams.get("execution_style") ?? "default",
      })
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(result))
      return
    }

    if (
      req.method === "GET" &&
      sessionId &&
      requestUrl.pathname === `/sessions/${sessionId}/stream`
    ) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })

      for (const event of dependencies.replayStore.read(sessionId)) {
        res.write(toSseChunk(event))
      }
      res.end()
      return
    }

    res.statusCode = 404
    res.end("not found")
  })
}
