import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { z, ZodError } from "zod"

import type { ReplayStore, StreamProtocol } from "../application/event-stream"
import { sendRunControl, startRun } from "../application/start-run"
import { parseRunControlArgs, parseRunControlDecision } from "../domain/run-control"
import { streamSession } from "./sse-endpoint"

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
  bus: StreamProtocol
  replayStore: ReplayStore
}

// 入站 query 在 interfaces 层一次性 Zod 解析：空 input → ZodError → 顶层 400；.strip 兜底滤未知键。
const startRunQuerySchema = z
  .object({
    input: z.string().min(1),
    conversation_id: z.string().optional(),
    execution_style: z.string().optional(),
    permission_mode: z.string().optional(),
  })
  .strip()

type Route = {
  method: "GET" | "POST"
  // 命名捕获组 sessionId / runId 提供路径参数。
  pattern: RegExp
  handle: (ctx: RouteContext) => Promise<void>
}

type RouteContext = {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  deps: BuildServerDependencies
}

const routes: Route[] = [
  {
    method: "POST",
    pattern: /^\/sessions\/(?<sessionId>[^/]+)\/runs$/,
    handle: handleStartRun,
  },
  {
    method: "GET",
    pattern: /^\/sessions\/(?<sessionId>[^/]+)\/stream$/,
    handle: (ctx) => streamSession(ctx.req, ctx.res, ctx.deps.bus, ctx.params.sessionId!),
  },
  {
    method: "POST",
    pattern: /^\/sessions\/[^/]+\/runs\/(?<runId>[^/]+)\/control$/,
    handle: handleRunControl,
  },
]

async function handleStartRun(ctx: RouteContext): Promise<void> {
  // 逐键取首值（与 URLSearchParams.get 一致）：重复键退化为最后值会悄悄换语义；null→undefined 交 .optional。
  const params = ctx.url.searchParams
  const query = startRunQuerySchema.parse({
    input: params.get("input") ?? undefined,
    conversation_id: params.get("conversation_id") ?? undefined,
    execution_style: params.get("execution_style") ?? undefined,
    permission_mode: params.get("permission_mode") ?? undefined,
  })
  const result = await startRun(
    {
      sessionId: ctx.params.sessionId!,
      conversationId: query.conversation_id,
      input: query.input,
      executionStyle: query.execution_style,
      permissionMode: query.permission_mode,
    },
    { bus: ctx.deps.bus },
  )
  ctx.res.statusCode = 200
  ctx.res.setHeader("content-type", "application/json")
  ctx.res.end(JSON.stringify(result))
}

// HITL 反向通道：web 批准/拒绝待批工具(approve/reject) 或放弃整个 run(cancel) → 写 control 流。
async function handleRunControl(ctx: RouteContext): Promise<void> {
  // 非法/缺失 decision、非法 args（urlencoded JSON，仅 approve 有意义）经 Zod 抛 ZodError → 顶层 400。
  const decision = parseRunControlDecision(ctx.url.searchParams.get("decision"))
  const args = parseRunControlArgs(ctx.url.searchParams.get("args"))
  await sendRunControl(
    { runId: ctx.params.runId!, decision, args },
    { bus: ctx.deps.bus },
  )
  ctx.res.statusCode = 202
  ctx.res.setHeader("content-type", "application/json")
  ctx.res.end(JSON.stringify({ ok: true }))
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

  const url = new URL(req.url, "http://127.0.0.1")
  for (const route of routes) {
    if (route.method !== req.method) continue
    const match = route.pattern.exec(url.pathname)
    if (!match) continue
    await route.handle({
      req,
      res,
      url,
      params: match.groups ?? {},
      deps: dependencies,
    })
    return
  }

  res.statusCode = 404
  res.end("not found")
}
