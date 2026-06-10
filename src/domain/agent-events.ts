import { z } from "zod"

// 入站原始 agent 事件契约（agent→session）。所有跨进程载荷进入系统前必过 .strict()，
// 拦截缺字段 / 注入多余键，避免脏事件污染归一化与 replay。
// 这些 payload 形状必须与 kokoro-agent 的 AgentEvent（events.py / run_agent.py）保持一致。

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

// 工具事件：tool_id 关联 invoked/returned；args 任意结构，result 文本化。
const toolInvokedPayload = z
  .object({
    message_ref: z.string().min(1),
    tool_id: z.string().min(1),
    name: z.string().min(1),
    args: z.record(z.unknown()),
  })
  .strict()

const toolReturnedPayload = z
  .object({
    message_ref: z.string().min(1),
    tool_id: z.string().min(1),
    name: z.string().min(1),
    result: z.string(),
  })
  .strict()

// CC 风格 todo：有序清单，每项带状态。
const todoItemSchema = z
  .object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed"]),
  })
  .strict()

const todoUpdatedPayload = z
  .object({
    todos: z.array(todoItemSchema),
  })
  .strict()

const subagentStartedPayload = z
  .object({
    message_ref: z.string().min(1),
    subagent_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    subagent_type: z.string().min(1),
    source: z.enum(["built-in", "config-custom", "runtime-custom"]),
  })
  .strict()

const subagentFinishedPayload = z
  .object({
    message_ref: z.string().min(1),
    subagent_id: z.string().min(1),
    name: z.string().min(1),
    subagent_type: z.string().min(1),
    source: z.enum(["built-in", "config-custom", "runtime-custom"]),
  })
  .strict()

const seq = z.number().int().nonnegative()
const runId = z.string().min(1)

// 用判别联合（discriminated union）按 kind 绑定各自 payload，保证每种 kind 的 payload 也被严格校验。
export const agentEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.started"), run_id: runId, seq, payload: emptyPayload }).strict(),
  z.object({ kind: z.literal("thinking.delta"), run_id: runId, seq, payload: textPayload }).strict(),
  z.object({ kind: z.literal("text.delta"), run_id: runId, seq, payload: textPayload }).strict(),
  z.object({ kind: z.literal("text.completed"), run_id: runId, seq, payload: textPayload }).strict(),
  z.object({ kind: z.literal("tool.invoked"), run_id: runId, seq, payload: toolInvokedPayload }).strict(),
  z.object({ kind: z.literal("tool.returned"), run_id: runId, seq, payload: toolReturnedPayload }).strict(),
  z.object({ kind: z.literal("todo.updated"), run_id: runId, seq, payload: todoUpdatedPayload }).strict(),
  z.object({ kind: z.literal("subagent.started"), run_id: runId, seq, payload: subagentStartedPayload }).strict(),
  z.object({ kind: z.literal("subagent.finished"), run_id: runId, seq, payload: subagentFinishedPayload }).strict(),
  z.object({
    kind: z.literal("subagent.text.delta"),
    run_id: runId,
    seq,
    payload: z.object({ message_ref: z.string().min(1), subagent_id: z.string().min(1), text: z.string() }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("subagent.text.completed"),
    run_id: runId,
    seq,
    payload: z.object({ message_ref: z.string().min(1), subagent_id: z.string().min(1), text: z.string() }).strict(),
  }).strict(),
  z.object({ kind: z.literal("run.completed"), run_id: runId, seq, payload: runCompletedPayload }).strict(),
  z.object({ kind: z.literal("run.failed"), run_id: runId, seq, payload: runFailedPayload }).strict(),
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
    execution_style: z.enum(["fast", "thinking"]).optional(),
  })
  .strict()
