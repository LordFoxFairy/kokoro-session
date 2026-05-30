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

// 工具事件按 agent-events v0.3.0：用局部引用 tool_call_ref + tool_name，
// session 负责映射成对外稳定 tool_call_id。
// args 可选：工具入参原样（v0.3.0 新增，additive，向后兼容）；
// session harness 据此识别 write_todos → plan.updated。
const toolInvokedPayload = z
  .object({
    tool_call_ref: z.string().min(1),
    tool_name: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const toolReturnedPayload = z
  .object({
    tool_call_ref: z.string().min(1),
    tool_name: z.string().min(1),
    status: z.string().min(1),
  })
  .strict()

// thinking.delta（v0.2.0 新增）：思考增量文本，session 累加后归一成一条 thinking.summary。
const thinkingDeltaPayload = z
  .object({
    text: z.string(),
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
  z.object({ kind: z.literal("thinking.delta"), run_id: z.string().min(1), seq, payload: thinkingDeltaPayload }).strict(),
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
