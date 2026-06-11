import { agentEventSchema, type AgentEvent } from "../domain/agent-event"
import { parseSessionEvent, type SessionEvent } from "../domain/session-event"

// 把原始 agent 事件归一化成 AGUI 信封；注入 id 工厂 + clock 让 event_id/时间戳在测试里确定。

export type NormalizerBinding = {
  sessionId: string
  conversationId: string
  runId: string
}

export type NormalizerClock = {
  newEventId: () => string
  now: () => Date
}

export class Normalizer {
  private readonly binding: NormalizerBinding
  private readonly clock: NormalizerClock
  private cursorSeq = 0
  private sessionCreated = false
  private readonly seenSeqs = new Set<number>()
  private readonly messageIds = new Map<string, string>()
  private messageCounter = 0

  constructor(binding: NormalizerBinding, clock: NormalizerClock) {
    this.binding = binding
    this.clock = clock
  }

  ingest(raw: unknown): SessionEvent[] {
    // 入站严格校验：缺字段 / 多余键 / 未知 kind 直接抛，绝不把脏事件归一化进 replay。
    const event = agentEventSchema.parse(raw)

    // 幂等：同 (run_id, seq) 重复喂只产一次。seq 在单 run 内唯一标识。
    if (this.seenSeqs.has(event.seq)) {
      return []
    }
    this.seenSeqs.add(event.seq)

    // 出站自检：每个信封过 AGUI 解析器；并透传该 agent 事件的 seq（含 run.started 合成的两条）。
    return this.mapEvent(event).map((envelope) =>
      parseSessionEvent({ ...envelope, seq: event.seq }),
    )
  }

  private mapEvent(event: AgentEvent): Omit<SessionEvent, "seq">[] {
    switch (event.kind) {
      case "run.started": {
        const envelopes: Omit<SessionEvent, "seq">[] = []
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
        envelopes.push(
          this.envelope("run.created", { run_id: this.binding.runId }),
        )
        return envelopes
      }
      case "text.delta": {
        const messageId = this.messageIdFor(event.payload.message_ref)
        return [
          this.envelope("message.delta", {
            message_id: messageId,
            delta: event.payload.text,
            role: "assistant",
          }),
        ]
      }
      case "text.completed": {
        const messageId = this.messageIdFor(event.payload.message_ref)
        return [
          this.envelope("message.completed", {
            message_id: messageId,
            role: "assistant",
            content: event.payload.text,
          }),
        ]
      }
      case "run.completed": {
        return [
          this.envelope("run.completed", {
            run_id: this.binding.runId,
            status: event.payload.status,
          }),
        ]
      }
      case "run.failed": {
        return [
          this.envelope("run.failed", {
            run_id: this.binding.runId,
            error_kind: event.payload.error_kind,
            message: event.payload.message,
          }),
        ]
      }
      case "thinking.delta": {
        return [
          this.envelope("thinking.delta", {
            message_id: this.messageIdFor(event.payload.message_ref),
            delta: event.payload.text,
          }),
        ]
      }
      case "tool.invoked": {
        return [
          this.envelope("tool.invoked", {
            message_id: this.messageIdFor(event.payload.message_ref),
            tool_id: event.payload.tool_id,
            name: event.payload.name,
            args: event.payload.args,
          }),
        ]
      }
      case "tool.returned": {
        return [
          this.envelope("tool.returned", {
            message_id: this.messageIdFor(event.payload.message_ref),
            tool_id: event.payload.tool_id,
            name: event.payload.name,
            result: event.payload.result,
          }),
        ]
      }
      case "todo.updated": {
        return [this.envelope("todo.updated", { todos: event.payload.todos })]
      }
      case "subagent.started": {
        return [
          this.envelope("subagent.started", {
            message_id: this.messageIdFor(event.payload.message_ref),
            subagent_id: event.payload.subagent_id,
            name: event.payload.name,
            description: event.payload.description,
            subagent_type: event.payload.subagent_type,
            source: event.payload.source,
          }),
        ]
      }
      case "subagent.finished": {
        return [
          this.envelope("subagent.finished", {
            message_id: this.messageIdFor(event.payload.message_ref),
            subagent_id: event.payload.subagent_id,
            name: event.payload.name,
            subagent_type: event.payload.subagent_type,
            source: event.payload.source,
          }),
        ]
      }
      case "subagent.text.delta": {
        return [
          this.envelope("subagent.text.delta", {
            message_id: this.messageIdFor(event.payload.message_ref),
            subagent_id: event.payload.subagent_id,
            text: event.payload.text,
          }),
        ]
      }
      case "subagent.text.completed": {
        return [
          this.envelope("subagent.text.completed", {
            message_id: this.messageIdFor(event.payload.message_ref),
            subagent_id: event.payload.subagent_id,
            text: event.payload.text,
          }),
        ]
      }
    }
  }

  private sessionTitle(): string {
    return this.binding.conversationId || this.binding.sessionId
  }

  private messageIdFor(messageRef: string): string {
    const existing = this.messageIds.get(messageRef)
    if (existing) return existing
    const id = `${this.binding.runId}:msg_${String(++this.messageCounter).padStart(4, "0")}`
    this.messageIds.set(messageRef, id)
    return id
  }

  private envelope(
    event: SessionEvent["event"],
    payload: Record<string, unknown>,
  ): Omit<SessionEvent, "seq"> {
    const cursor = `${this.binding.runId}:${String(++this.cursorSeq).padStart(4, "0")}`
    return {
      event,
      event_id: this.clock.newEventId(),
      session_id: this.binding.sessionId,
      conversation_id: this.binding.conversationId,
      run_id: this.binding.runId,
      cursor,
      timestamp: this.clock.now().toISOString(),
      payload,
    }
  }
}
