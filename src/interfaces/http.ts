import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { z, ZodError } from "zod"

import type { MessageStore, StreamProtocol } from "../application/event-stream"
import { sendRunControl } from "../application/send-run-control"
import { startRun } from "../application/start-run"
import {
  pendingApprovalsFromEvents,
  runControlBodySchema,
  RunControlDecisionError,
  validateResumeDecisions,
} from "../domain/run-control"
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
  messageStore: MessageStore
}

// 用户消息入口读 JSON body：content 是标准输入；其它 runtime 选项明确列出，未知键 fail-loud。
const startMessageBodySchema = z
  .object({
    content: z.string().min(1),
    conversationId: z.string().optional(),
    executionStyle: z.enum(["fast", "thinking"]).optional(),
    permissionMode: z.enum(["auto", "default"]).optional(),
  })
  .strict()

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
    pattern: /^\/sessions\/(?<sessionId>[^/]+)\/messages$/,
    handle: handleStartMessage,
  },
  {
    method: "GET",
    pattern: /^\/sessions\/(?<sessionId>[^/]+)\/events$/,
    handle: (ctx) =>
      streamSession(ctx.req, ctx.res, ctx.deps.bus, ctx.deps.messageStore, ctx.params.sessionId!),
  },
  {
    method: "POST",
    pattern: /^\/sessions\/(?<sessionId>[^/]+)\/runs\/(?<runId>[^/]+)\/control$/,
    handle: handleRunControl,
  },
]

async function handleStartMessage(ctx: RouteContext): Promise<void> {
  const body = startMessageBodySchema.parse(jsonBodySchema.parse(await readBody(ctx.req)))
  const result = await startRun(
    {
      sessionId: ctx.params.sessionId!,
      conversationId: body.conversationId,
      input: body.content,
      executionStyle: body.executionStyle,
      permissionMode: body.permissionMode,
    },
    { bus: ctx.deps.bus },
  )
  ctx.res.statusCode = 200
  ctx.res.setHeader("content-type", "application/json")
  ctx.res.end(JSON.stringify(result))
}

// 请求体 JSON 解析：决策数组（含 edit 的 edited_action）可大于 query 串上限，故走 body。非法
// JSON 经 Zod 抛 ZodError → 顶层 400；空体退化为 {} 交判别联合报缺 kind。
const jsonBodySchema = z.string().transform((raw, ctx) => {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "body is not valid JSON" })
    return z.NEVER
  }
})

// 体量不设应用层硬顶：session 是本地、CORS 锁定、仅本机 web 前端可达的内部服务，DoS 不在威胁
// 模型内；且 Node 在未读完请求体时回写响应会破坏 HTTP/1.1 连接（413 到不了客户端）。若将来对公网
// 暴露，正确做法是反向代理层限体，而非应用层中途拒收。
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

// HITL 反向通道：web 批准/拒绝待批工具或放弃整个 run → 翻译成 run.resume/run.cancel 发请求流。
// 同帧多工具须在一条 run.resume 内携全部决策（agent 按 tool_id 一一对齐，缺/多即 fail-loud）。
async function handleRunControl(ctx: RouteContext): Promise<void> {
  const body = runControlBodySchema.parse(jsonBodySchema.parse(await readBody(ctx.req)))
  if (body.kind === "run.resume") {
    const runEvents = await ctx.deps.messageStore.readRun(ctx.params.sessionId!, ctx.params.runId!)
    validateResumeDecisions(
      body.decisions,
      pendingApprovalsFromEvents(
        runEvents.map((stored) => stored.event),
        ctx.params.runId!,
      ),
    )
  }
  await sendRunControl(
    body.kind === "run.cancel"
      ? { kind: "run.cancel", runId: ctx.params.runId!, sessionId: ctx.params.sessionId! }
      : {
          kind: "run.resume",
          runId: ctx.params.runId!,
          sessionId: ctx.params.sessionId!,
          decisions: body.decisions,
        },
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
      if (error instanceof ZodError || error instanceof RunControlDecisionError) {
        res.statusCode = 400
        res.setHeader("content-type", "application/json")
        const detail =
          error instanceof ZodError
            ? error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ")
            : error.message
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
