import { createHash } from "node:crypto"

import { agentEventSchema, type AgentEvent } from "../domain/agent-event"
import { parseSessionEvent, type AguiPayload, type SessionEvent } from "../domain/session-event"

// 把 agent canonical wire 事件归一化成 AG-UI 信封；注入 clock 让时间戳在测试里确定。

export type NormalizerBinding = {
  sessionId: string
  conversationId: string
  runId: string
}

export type NormalizerClock = {
  now: () => Date
}

export class Normalizer {
  private readonly binding: NormalizerBinding
  private readonly clock: NormalizerClock
  private sessionCreated = false
  private runCreated = false

  constructor(binding: NormalizerBinding, clock: NormalizerClock) {
    this.binding = binding
    this.clock = clock
  }

  ingest(raw: unknown, rawId: string): SessionEvent[] {
    // 入站严格校验：缺字段 / 多余键 / 未知 event 直接抛，不将脏事件归一化进 replay。
    const event = agentEventSchema.parse(raw)

    const envelopes = this.mapEvent(event)

    // 出站自检：每个信封过 AG-UI 解析器；event_id 是 opaque idempotency id。
    return envelopes.map((envelope) =>
      parseSessionEvent({
        ...envelope,
        event_id: stableEventId(event, envelope.event, rawId),
      }),
    )
  }

  private mapEvent(event: AgentEvent): Omit<SessionEvent, "event_id">[] {
    switch (event.event) {
      case "agent_status":
        return this.mapStatus(event.data, event.request_id)
      case "text_chunk":
        return this.mapTextChunk(event.data)
      case "reasoning_chunk": {
        // web thinking 纯续写，终态帧多余 → final=true 丢弃。
        if (event.data.final) return []
        return [
          this.envelope("thinking.delta", {
            segment_id: event.data.segment_id,
            delta: event.data.text,
          }),
        ]
      }
      case "tool_call_start":
        return [
          this.envelope("tool.invoked", {
            segment_id: event.data.segment_id,
            tool_id: event.data.tool_id,
            name: event.data.name,
            args: event.data.args,
          }),
        ]
      case "tool_call_awaiting":
        // agent 现发逐工具顶层 tool_call_awaiting，直映 AG-UI tool.awaiting_approval（不再拆 pending 数组）。
        return [
          this.envelope("tool.awaiting_approval", {
            segment_id: event.data.segment_id,
            tool_id: event.data.tool_id,
            name: event.data.name,
            args: event.data.args,
          }),
        ]
      case "tool_call_end":
        return [
          this.envelope("tool.returned", {
            segment_id: event.data.segment_id,
            tool_id: event.data.tool_id,
            name: event.data.name,
            result: event.data.result,
            is_error: event.data.is_error,
            rejected: event.data.rejected,
            // reject_reason 仅 HITL 拒绝时存在（可选）；透传供 web 渲染拒绝理由。
            reject_reason: event.data.reject_reason,
            // responded 仅 HITL 人工答复时存在（可选）；透传供 web 渲染「已人工答复」标记。
            responded: event.data.responded,
          }),
        ]
      case "agent_done":
        return [
          this.envelope("run.completed", {
            run_id: event.request_id,
            status: event.data.status,
          }),
        ]
      case "agent_error":
        return [
          this.envelope("run.failed", {
            run_id: event.request_id,
            error_kind: event.data.error_kind,
            message: event.data.message,
          }),
        ]
    }
  }

  private mapStatus(
    data: Extract<AgentEvent, { event: "agent_status" }>["data"],
    requestId: string,
  ): Omit<SessionEvent, "event_id">[] {
    switch (data.status) {
      case "started": {
        // 维持现有 run.started 行为：首次合成 session.created，再发 run.created。
        const envelopes: Omit<SessionEvent, "event_id">[] = []
        if (!this.sessionCreated) {
          this.sessionCreated = true
          envelopes.push(
            this.envelope("session.created", {
              session_id: this.binding.sessionId,
              conversation_id: this.binding.conversationId,
              owner_id: "kokoro-agent",
              title: this.sessionTitle(),
            }),
          )
        }
        if (!this.runCreated) {
          this.runCreated = true
          envelopes.push(this.envelope("run.created", { run_id: requestId }))
        }
        return envelopes
      }
      case "todo_updated":
        // agent wire 把 todos 作 unknown[] 透传；AG-UI 的逐项 strict 形状由出站 parseSessionEvent 兜底校验。
        return [
          this.envelope("todo.updated", {
            todos: data.todos as AguiPayload<"todo.updated">["todos"],
          }),
        ]
      case "subagent_started":
        // source 在 agent wire 是 string；AG-UI 收窄为 enum，由出站 parseSessionEvent 强校验。
        return [
          this.envelope("subagent.started", {
            segment_id: data.segment_id,
            subagent_id: data.subagent_id,
            name: data.name,
            description: data.description,
            subagent_type: data.subagent_type,
            source: data.source as AguiPayload<"subagent.started">["source"],
          }),
        ]
      case "subagent_finished":
        return [
          this.envelope("subagent.finished", {
            segment_id: data.segment_id,
            subagent_id: data.subagent_id,
            name: data.name,
            subagent_type: data.subagent_type,
            source: data.source as AguiPayload<"subagent.finished">["source"],
            // 子代理内部异常时透传（可选）：失败有归属，不再被吞成顶层 run.failed。
            failed: data.failed,
            error: data.error,
          }),
        ]
      case "custom":
        // 业务遥测，web 不渲染 → 丢弃。
        return []
    }
  }

  private mapTextChunk(
    data: Extract<AgentEvent, { event: "text_chunk" }>["data"],
  ): Omit<SessionEvent, "event_id">[] {
    if (data.subagent_id !== undefined) {
      // 子智能体文本走独立通道，按 final 分增量 / 终态。
      if (data.final) {
        return [
          this.envelope("subagent.text.completed", {
            segment_id: data.segment_id,
            subagent_id: data.subagent_id,
            text: data.text,
          }),
        ]
      }
      return [
        this.envelope("subagent.text.delta", {
          segment_id: data.segment_id,
          subagent_id: data.subagent_id,
          text: data.text,
        }),
      ]
    }
    if (data.final) {
      return [
        this.envelope("message.completed", {
          segment_id: data.segment_id,
          role: "assistant",
          content: data.text,
        }),
      ]
    }
    return [
      this.envelope("message.delta", {
        segment_id: data.segment_id,
        delta: data.text,
        role: "assistant",
      }),
    ]
  }

  private sessionTitle(): string {
    return this.binding.conversationId || this.binding.sessionId
  }

  private envelope<E extends SessionEvent["event"]>(
    event: E,
    payload: AguiPayload<E>,
  ): Omit<SessionEvent, "event_id"> {
    return {
      event,
      session_id: this.binding.sessionId,
      conversation_id: this.binding.conversationId,
      run_id: this.binding.runId,
      timestamp: this.clock.now().toISOString(),
      payload,
    }
  }
}

function stableEventId(event: AgentEvent, sessionEvent: SessionEvent["event"], rawId: string): string {
  const identity = stableJson({
    raw_id: rawId,
    request_id: event.request_id,
    agent_event: event.event,
    session_event: sessionEvent,
    data: event.data,
  })
  return `evt_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
