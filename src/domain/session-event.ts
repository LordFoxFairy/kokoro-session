// DO NOT EDIT — generated from contract/events.yaml by contract/generate.py.
// Run `python3 contract/generate.py` after changing the contract.

import { z } from "zod"

export type SessionEventName = z.infer<typeof sessionEventSchema>["event"]

export type SessionEvent = {
  event: SessionEventName
  event_id: string
  session_id: string
  conversation_id: string
  run_id: string
  timestamp: string
  payload: Record<string, unknown>
}

const envelopeFields = {
  event_id: z.string().min(1),
  session_id: z.string().min(1),
  conversation_id: z.string().min(1),
  run_id: z.string().min(1),
  timestamp: z.string().min(1),
}

const sessionEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("session.created"), ...envelopeFields, payload: z.object({ session_id: z.string().min(1), conversation_id: z.string().min(1), owner_id: z.string().min(1), title: z.string().min(1) }).strict() }).strict(),
  z.object({ event: z.literal("run.created"), ...envelopeFields, payload: z.object({ run_id: z.string().min(1) }).strict() }).strict(),
  z.object({ event: z.literal("thinking.delta"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), delta: z.string() }).strict() }).strict(),
  z.object({ event: z.literal("message.delta"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), delta: z.string(), role: z.string().min(1) }).strict() }).strict(),
  z.object({ event: z.literal("message.completed"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), role: z.string().min(1), content: z.string() }).strict() }).strict(),
  z.object({ event: z.literal("tool.invoked"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), tool_id: z.string().min(1), name: z.string().min(1), args: z.record(z.unknown()) }).strict() }).strict(),
  z.object({ event: z.literal("tool.awaiting_approval"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), tool_id: z.string().min(1), name: z.string().min(1), args: z.record(z.unknown()) }).strict() }).strict(),
  z.object({ event: z.literal("tool.returned"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), tool_id: z.string().min(1), name: z.string().min(1), result: z.string(), is_error: z.boolean(), rejected: z.boolean().optional(), reject_reason: z.string().optional(), responded: z.boolean().optional() }).strict() }).strict(),
  z.object({ event: z.literal("todo.updated"), ...envelopeFields, payload: z.object({ todos: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) }).strict()) }).strict() }).strict(),
  z.object({ event: z.literal("subagent.started"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), subagent_id: z.string().min(1), name: z.string().min(1), description: z.string(), subagent_type: z.string().min(1), source: z.enum(["built-in", "config-custom", "runtime-custom"]) }).strict() }).strict(),
  z.object({ event: z.literal("subagent.finished"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), subagent_id: z.string().min(1), name: z.string().min(1), subagent_type: z.string().min(1), source: z.enum(["built-in", "config-custom", "runtime-custom"]), failed: z.boolean().optional(), error: z.string().optional() }).strict() }).strict(),
  z.object({ event: z.literal("subagent.text.delta"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), subagent_id: z.string().min(1), text: z.string() }).strict() }).strict(),
  z.object({ event: z.literal("subagent.text.completed"), ...envelopeFields, payload: z.object({ segment_id: z.string().min(1), subagent_id: z.string().min(1), text: z.string() }).strict() }).strict(),
  z.object({ event: z.literal("run.completed"), ...envelopeFields, payload: z.object({ run_id: z.string().min(1), status: z.enum(["completed", "cancelled", "timeout"]) }).strict() }).strict(),
  z.object({ event: z.literal("run.failed"), ...envelopeFields, payload: z.object({ run_id: z.string().min(1), error_kind: z.string().min(1), message: z.string().min(1) }).strict() }).strict(),
])

type SessionEventUnion = z.infer<typeof sessionEventSchema>
export type AguiPayload<E extends SessionEventName> = Extract<
  SessionEventUnion,
  { event: E }
>["payload"]

export function parseSessionEvent(input: unknown): SessionEvent {
  return sessionEventSchema.parse(input)
}
