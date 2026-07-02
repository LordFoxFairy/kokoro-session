// DO NOT EDIT — generated from kokoro-agent envelope.py by contract/agent_wire.py.
// agent 是 wire 单源真理；改 envelope.py 后跑 `python3 contract/generate.py`。

import { z } from "zod"

const agentStatusData = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started") }).strict(),
  z.object({ status: z.literal("todo_updated"), segment_id: z.string(), todos: z.unknown() }).strict(),
  z.object({ status: z.literal("subagent_started"), segment_id: z.string(), subagent_id: z.string(), name: z.string(), description: z.string(), subagent_type: z.string(), source: z.enum(["built-in", "config-custom"]) }).strict(),
  z.object({ status: z.literal("subagent_finished"), segment_id: z.string(), subagent_id: z.string(), name: z.string(), subagent_type: z.string(), source: z.enum(["built-in", "config-custom"]), failed: z.boolean().optional(), error: z.string().optional() }).strict(),
  z.object({ status: z.literal("custom"), custom: z.unknown() }).strict(),
])

const envelope = { request_id: z.string(), timestamp: z.number() }

export const agentEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("agent_status"), ...envelope, data: agentStatusData }).strict(),
  z.object({ event: z.literal("text_chunk"), ...envelope, data: z.object({ segment_id: z.string(), text: z.string(), final: z.boolean(), subagent_id: z.string().optional() }).strict() }).strict(),
  z.object({ event: z.literal("reasoning_chunk"), ...envelope, data: z.object({ segment_id: z.string(), text: z.string(), final: z.boolean(), subagent_id: z.string().optional() }).strict() }).strict(),
  z.object({ event: z.literal("tool_call_start"), ...envelope, data: z.object({ segment_id: z.string(), tool_id: z.string(), name: z.string(), args: z.record(z.unknown()), subagent_id: z.string().optional() }).strict() }).strict(),
  z.object({ event: z.literal("tool_call_awaiting"), ...envelope, data: z.object({ segment_id: z.string(), tool_id: z.string(), name: z.string(), args: z.record(z.unknown()), subagent_id: z.string().optional(), description: z.string(), allowed_decisions: z.array(z.enum(["approve", "edit", "reject", "respond"])), kind: z.enum(["tool_approval", "ask_user"]), editable: z.boolean() }).strict() }).strict(),
  z.object({ event: z.literal("tool_call_end"), ...envelope, data: z.object({ segment_id: z.string(), tool_id: z.string(), name: z.string(), result: z.string(), is_error: z.boolean(), rejected: z.boolean(), reject_reason: z.string().optional(), responded: z.boolean().optional(), subagent_id: z.string().optional() }).strict() }).strict(),
  z.object({ event: z.literal("agent_done"), ...envelope, data: z.object({ status: z.enum(["completed", "cancelled", "timeout"]), usage: z.record(z.unknown()).optional() }).strict() }).strict(),
  z.object({ event: z.literal("agent_error"), ...envelope, data: z.object({ error_kind: z.string(), message: z.string() }).strict() }).strict(),
])

export type AgentEvent = z.infer<typeof agentEventSchema>
