import { z } from "zod"

// 事件名集合的单一真理来源 = 下方 Zod 判别联合；类型从 schema 推导，避免重复维护两份名单。
export type SessionEventName = z.infer<typeof sessionEventSchema>["event"]

export type SessionEvent = {
  event: SessionEventName
  event_id: string
  session_id: string
  conversation_id: string
  run_id: string
  cursor: string
  timestamp: string
  payload: Record<string, unknown>
}

const nonEmptyString = z.string().min(1)

const envelopeFields = {
  event_id: nonEmptyString,
  session_id: nonEmptyString,
  conversation_id: nonEmptyString,
  run_id: nonEmptyString,
  cursor: nonEmptyString,
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
    status: nonEmptyString,
  })
  .strict()

const runFailedPayload = z
  .object({
    run_id: nonEmptyString,
    error_kind: nonEmptyString,
    message: z.string(),
  })
  .strict()

const sessionEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("session.created"), ...envelopeFields, payload: sessionCreatedPayload }).strict(),
  z.object({ event: z.literal("run.created"), ...envelopeFields, payload: runCreatedPayload }).strict(),
  z.object({ event: z.literal("message.delta"), ...envelopeFields, payload: messageDeltaPayload }).strict(),
  z.object({ event: z.literal("message.completed"), ...envelopeFields, payload: messageCompletedPayload }).strict(),
  z.object({ event: z.literal("run.completed"), ...envelopeFields, payload: runCompletedPayload }).strict(),
  z.object({ event: z.literal("run.failed"), ...envelopeFields, payload: runFailedPayload }).strict(),
])

// session 侧严格校验当前实际发出的 AGUI 事件族，避免把脏事件写入 replay 或 SSE。
export function parseSessionEvent(input: unknown): SessionEvent {
  return sessionEventSchema.parse(input) as SessionEvent
}
