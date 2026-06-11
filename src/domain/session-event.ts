import { z } from "zod"

// 事件名集合的单一真理来源 = 下方 Zod 判别联合；类型从 schema 推导，避免重复维护两份名单。
export type SessionEventName = z.infer<typeof sessionEventSchema>["event"]

export type SessionEvent = {
  event: SessionEventName
  event_id: string
  // seq：透传产生该信封的 agent 事件的发射序号（run 内单调），web 据此定序，不再靠 cursor 反解。
  seq: number
  session_id: string
  conversation_id: string
  run_id: string
  timestamp: string
  payload: Record<string, unknown>
}

const nonEmptyString = z.string().min(1)

const envelopeFields = {
  event_id: nonEmptyString,
  seq: z.number().int().nonnegative(),
  session_id: nonEmptyString,
  conversation_id: nonEmptyString,
  run_id: nonEmptyString,
  timestamp: nonEmptyString,
}

const sessionCreatedPayload = z
  .object({
    session_id: nonEmptyString,
    conversation_id: nonEmptyString,
    owner_id: nonEmptyString,
    title: nonEmptyString,
  })
  .strict()

const runCreatedPayload = z
  .object({
    run_id: nonEmptyString,
  })
  .strict()

const messageDeltaPayload = z
  .object({
    message_id: nonEmptyString,
    delta: z.string(),
    role: nonEmptyString,
  })
  .strict()

const messageCompletedPayload = z
  .object({
    message_id: nonEmptyString,
    role: nonEmptyString,
    content: z.string(),
  })
  .strict()

const runCompletedPayload = z
  .object({
    run_id: nonEmptyString,
    status: z.enum(["completed", "cancelled", "timeout"]),
  })
  .strict()

const runFailedPayload = z
  .object({
    run_id: nonEmptyString,
    error_kind: nonEmptyString,
    message: z.string(),
  })
  .strict()

// 活动事件族（思考 / 工具 / todo / 子智能体）：与入站 agent-events 同形，供 web 渲染。
const thinkingDeltaPayload = z
  .object({
    message_id: nonEmptyString,
    delta: z.string(),
  })
  .strict()

const toolInvokedPayload = z
  .object({
    message_id: nonEmptyString,
    tool_id: nonEmptyString,
    name: nonEmptyString,
    args: z.record(z.unknown()),
  })
  .strict()

const toolReturnedPayload = z
  .object({
    message_id: nonEmptyString,
    tool_id: nonEmptyString,
    name: nonEmptyString,
    result: z.string(),
  })
  .strict()

const todoUpdatedPayload = z
  .object({
    todos: z.array(
      z
        .object({
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
        })
        .strict(),
    ),
  })
  .strict()

const subagentStartedPayload = z
  .object({
    message_id: nonEmptyString,
    subagent_id: nonEmptyString,
    name: nonEmptyString,
    description: z.string(),
    subagent_type: nonEmptyString,
    source: z.enum(["built-in", "config-custom", "runtime-custom"]),
  })
  .strict()

const subagentFinishedPayload = z
  .object({
    message_id: nonEmptyString,
    subagent_id: nonEmptyString,
    name: nonEmptyString,
    subagent_type: nonEmptyString,
    source: z.enum(["built-in", "config-custom", "runtime-custom"]),
  })
  .strict()

const subagentTextDeltaPayload = z
  .object({
    message_id: nonEmptyString,
    subagent_id: nonEmptyString,
    text: z.string(),
  })
  .strict()

const subagentTextCompletedPayload = z
  .object({
    message_id: nonEmptyString,
    subagent_id: nonEmptyString,
    text: z.string(),
  })
  .strict()

const sessionEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("session.created"), ...envelopeFields, payload: sessionCreatedPayload }).strict(),
  z.object({ event: z.literal("run.created"), ...envelopeFields, payload: runCreatedPayload }).strict(),
  z.object({ event: z.literal("message.delta"), ...envelopeFields, payload: messageDeltaPayload }).strict(),
  z.object({ event: z.literal("message.completed"), ...envelopeFields, payload: messageCompletedPayload }).strict(),
  z.object({ event: z.literal("thinking.delta"), ...envelopeFields, payload: thinkingDeltaPayload }).strict(),
  z.object({ event: z.literal("tool.invoked"), ...envelopeFields, payload: toolInvokedPayload }).strict(),
  z.object({ event: z.literal("tool.returned"), ...envelopeFields, payload: toolReturnedPayload }).strict(),
  z.object({ event: z.literal("todo.updated"), ...envelopeFields, payload: todoUpdatedPayload }).strict(),
  z.object({ event: z.literal("subagent.started"), ...envelopeFields, payload: subagentStartedPayload }).strict(),
  z.object({ event: z.literal("subagent.finished"), ...envelopeFields, payload: subagentFinishedPayload }).strict(),
  z.object({ event: z.literal("subagent.text.delta"), ...envelopeFields, payload: subagentTextDeltaPayload }).strict(),
  z.object({ event: z.literal("subagent.text.completed"), ...envelopeFields, payload: subagentTextCompletedPayload }).strict(),
  z.object({ event: z.literal("run.completed"), ...envelopeFields, payload: runCompletedPayload }).strict(),
  z.object({ event: z.literal("run.failed"), ...envelopeFields, payload: runFailedPayload }).strict(),
])

// 各 kind 出站 payload 类型（从判别联合 schema 推导）：normalize 构造信封时按 event 取得编译期保护。
type SessionEventUnion = z.infer<typeof sessionEventSchema>
export type AguiPayload<E extends SessionEventName> = Extract<
  SessionEventUnion,
  { event: E }
>["payload"]

// session 侧严格校验当前实际发出的 AGUI 事件族，避免把脏事件写入 replay 或 SSE。
export function parseSessionEvent(input: unknown): SessionEvent {
  return sessionEventSchema.parse(input)
}
