// DO NOT EDIT — generated from kokoro-agent envelope.py by contract/agent_wire.py.
// agent 是 wire 单源真理；改 envelope.py 后跑 `python3 contract/generate.py`。

import { z } from "zod"

const agentStatusData = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started") }).strict(),
  z.object({ status: z.literal("todo_updated"), segment_id: z.string(), todos: z.array(z.unknown()) }).strict(),
  z.object({ status: z.literal("subagent_started"), segment_id: z.string(), subagent_id: z.string(), name: z.string(), description: z.string(), subagent_type: z.string(), source: z.string() }).strict(),
  z.object({ status: z.literal("subagent_finished"), segment_id: z.string(), subagent_id: z.string(), name: z.string(), subagent_type: z.string(), source: z.string() }).strict(),
  z.object({ status: z.literal("custom"), custom: z.unknown() }).strict(),
  z.object({ status: z.literal("awaiting_approval"), segment_id: z.string(), pending: z.array(z.object({ tool_id: z.string(), name: z.string(), args: z.record(z.unknown()) }).strict()) }).strict(),
])

const envelope = { request_id: z.string(), timestamp: z.number() }

export const agentEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("agent_status"), ...envelope, data: agentStatusData }).strict(),
  z.object({ event: z.literal("text_chunk"), ...envelope, data: z.object({ segment_id: z.string(), text: z.string(), final: z.boolean(), subagent_id: z.string().optional() }).strict() }).strict(),
  z.object({ event: z.literal("reasoning_chunk"), ...envelope, data: z.object({ segment_id: z.string(), text: z.string(), final: z.boolean(), subagent_id: z.string().optional() }).strict() }).strict(),
  z.object({ event: z.literal("tool_call_start"), ...envelope, data: z.object({ segment_id: z.string(), tool_id: z.string(), name: z.string(), args: z.record(z.unknown()) }).strict() }).strict(),
  z.object({ event: z.literal("tool_call_end"), ...envelope, data: z.object({ segment_id: z.string(), tool_id: z.string(), name: z.string(), result: z.string(), is_error: z.boolean(), rejected: z.boolean() }).strict() }).strict(),
  z.object({ event: z.literal("agent_done"), ...envelope, data: z.object({ status: z.literal("completed"), usage: z.record(z.unknown()) }).strict() }).strict(),
  z.object({ event: z.literal("agent_error"), ...envelope, data: z.object({ error_kind: z.string(), message: z.string() }).strict() }).strict(),
])

export type AgentEvent = z.infer<typeof agentEventSchema>
