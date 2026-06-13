// DO NOT EDIT — generated from contract/events.yaml by contract/generate.py.
// Run `python3 contract/generate.py` after changing the contract.

import { z } from "zod"

const envelope = { run_id: z.string().min(1), seq: z.number().int().nonnegative() }

export const agentEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.started"), ...envelope, payload: z.object({}).strict() }).strict(),
  z.object({ kind: z.literal("thinking.delta"), ...envelope, payload: z.object({ segment_id: z.string().min(1), text: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal("text.delta"), ...envelope, payload: z.object({ segment_id: z.string().min(1), text: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal("text.completed"), ...envelope, payload: z.object({ segment_id: z.string().min(1), text: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal("tool.invoked"), ...envelope, payload: z.object({ segment_id: z.string().min(1), tool_id: z.string().min(1), name: z.string().min(1), args: z.record(z.unknown()) }).strict() }).strict(),
  z.object({ kind: z.literal("tool.returned"), ...envelope, payload: z.object({ segment_id: z.string().min(1), tool_id: z.string().min(1), name: z.string().min(1), result: z.string(), is_error: z.boolean() }).strict() }).strict(),
  z.object({ kind: z.literal("todo.updated"), ...envelope, payload: z.object({ todos: z.array(z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) }).strict()) }).strict() }).strict(),
  z.object({ kind: z.literal("subagent.started"), ...envelope, payload: z.object({ segment_id: z.string().min(1), subagent_id: z.string().min(1), name: z.string().min(1), description: z.string(), subagent_type: z.string().min(1), source: z.enum(["built-in", "config-custom", "runtime-custom"]) }).strict() }).strict(),
  z.object({ kind: z.literal("subagent.finished"), ...envelope, payload: z.object({ segment_id: z.string().min(1), subagent_id: z.string().min(1), name: z.string().min(1), subagent_type: z.string().min(1), source: z.enum(["built-in", "config-custom", "runtime-custom"]) }).strict() }).strict(),
  z.object({ kind: z.literal("subagent.text.delta"), ...envelope, payload: z.object({ segment_id: z.string().min(1), subagent_id: z.string().min(1), text: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal("subagent.text.completed"), ...envelope, payload: z.object({ segment_id: z.string().min(1), subagent_id: z.string().min(1), text: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal("run.completed"), ...envelope, payload: z.object({ status: z.enum(["completed", "cancelled", "timeout"]) }).strict() }).strict(),
  z.object({ kind: z.literal("run.failed"), ...envelope, payload: z.object({ error_kind: z.string().min(1), message: z.string().min(1) }).strict() }).strict(),
])

export type AgentEvent = z.infer<typeof agentEventSchema>
