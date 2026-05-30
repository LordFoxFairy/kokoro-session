import { z } from "zod"

// 入站原始 agent 事件契约（agent→session）。所有跨进程载荷进入系统前必过 .strict()，
// 拦截缺字段 / 注入多余键，避免脏事件污染归一化与 replay。

const emptyPayload = z.object({}).strict()

const textPayload = z
  .object({
    message_ref: z.string().min(1),
    text: z.string(),
  })
  .strict()

const runCompletedPayload = z
  .object({
    status: z.string().min(1),
  })
  .strict()

const runFailedPayload = z
  .object({
    error_kind: z.string().min(1),
    message: z.string(),
  })
  .strict()

const toolInvokedPayload = z
  .object({
    tool: z.string().min(1),
    input: z.unknown(),
  })
  .strict()

const toolReturnedPayload = z
  .object({
    tool: z.string().min(1),
    output: z.unknown(),
  })
  .strict()

const seq = z.number().int().nonnegative()

// 用判别联合（discriminated union）按 kind 绑定各自 payload，保证每种 kind 的 payload 也被严格校验。
export const agentEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.started"), run_id: z.string().min(1), seq, payload: emptyPayload }).strict(),
  z.object({ kind: z.literal("text.delta"), run_id: z.string().min(1), seq, payload: textPayload }).strict(),
  z.object({ kind: z.literal("text.completed"), run_id: z.string().min(1), seq, payload: textPayload }).strict(),
  z.object({ kind: z.literal("tool.invoked"), run_id: z.string().min(1), seq, payload: toolInvokedPayload }).strict(),
  z.object({ kind: z.literal("tool.returned"), run_id: z.string().min(1), seq, payload: toolReturnedPayload }).strict(),
  z.object({ kind: z.literal("run.completed"), run_id: z.string().min(1), seq, payload: runCompletedPayload }).strict(),
  z.object({ kind: z.literal("run.failed"), run_id: z.string().min(1), seq, payload: runFailedPayload }).strict(),
])

export type AgentEvent = z.infer<typeof agentEventSchema>

// run 请求信封（session 写出到 kokoro:runs:requests）。run_id 由 session 生成。
export const runRequestSchema = z
  .object({
    kind: z.literal("run.request"),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    conversation_id: z.string().min(1),
    input: z.string().min(1),
    execution_style: z.string().min(1).optional(),
  })
  .strict()

export type RunRequest = z.infer<typeof runRequestSchema>
