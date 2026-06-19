import { agentEventSchema, type AgentEvent } from "../domain/agent-event"
import { parseSessionEvent, type AguiPayload, type SessionEvent } from "../domain/session-event"

// 把原始 agent 事件归一化成 AGUI 信封；注入 clock 让时间戳在测试里确定。

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
  private readonly seenSeqs = new Set<number>()

  constructor(binding: NormalizerBinding, clock: NormalizerClock) {
    this.binding = binding
    this.clock = clock
  }

  ingest(raw: unknown): SessionEvent[] {
    // 入站严格校验：缺字段 / 多余键 / 未知 kind 直接抛，不将脏事件归一化进 replay。
    const event = agentEventSchema.parse(raw)

    // 幂等：同 (run_id, seq) 重复输入只产出一次。seq 在单 run 内唯一标识。
    // 终态(run.completed/run.failed)豁免去重：若 agent 复用已见 seq 发终态，去重会丢弃它，
    // 导致 relay 永不收束、web 停留在「进行中」；重复终态由 web 端 eventId 去重处理。
    const isTerminal =
      event.kind === "run.completed" || event.kind === "run.failed"
    if (!isTerminal && this.seenSeqs.has(event.seq)) {
      return []
    }
    this.seenSeqs.add(event.seq)

    // 出站自检：每个信封过 AGUI 解析器；透传该 agent 事件的 seq（含 run.started 合成的两条）。
    // event_id 确定性派生自 (run_id, seq, event)：重启/多副本重放产生同一 id，web 去重幂等。
    return this.mapEvent(event).map((envelope) =>
      parseSessionEvent({
        ...envelope,
        seq: event.seq,
        event_id: `evt_${this.binding.runId}_${event.seq}_${envelope.event}`,
      }),
    )
  }

  private mapEvent(event: AgentEvent): Omit<SessionEvent, "seq" | "event_id">[] {
    switch (event.kind) {
      case "run.started": {
        const envelopes: Omit<SessionEvent, "seq" | "event_id">[] = []
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
        return [
          this.envelope("message.delta", {
            segment_id: event.payload.segment_id,
            delta: event.payload.text,
            role: "assistant",
          }),
        ]
      }
      case "text.completed": {
        return [
          this.envelope("message.completed", {
            segment_id: event.payload.segment_id,
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
            segment_id: event.payload.segment_id,
            delta: event.payload.text,
          }),
        ]
      }
      case "tool.invoked": {
        return [
          this.envelope("tool.invoked", {
            segment_id: event.payload.segment_id,
            tool_id: event.payload.tool_id,
            name: event.payload.name,
            args: event.payload.args,
          }),
        ]
      }
      case "tool.awaiting_approval": {
        return [
          this.envelope("tool.awaiting_approval", {
            segment_id: event.payload.segment_id,
            tool_id: event.payload.tool_id,
            name: event.payload.name,
            args: event.payload.args,
          }),
        ]
      }
      case "tool.returned": {
        return [
          this.envelope("tool.returned", {
            segment_id: event.payload.segment_id,
            tool_id: event.payload.tool_id,
            name: event.payload.name,
            result: event.payload.result,
            is_error: event.payload.is_error,
            // HITL 拒绝标记(仅拒绝时存在)透传：让 web replay 安全地显「已拒绝」而非绿勾。
            ...(event.payload.rejected !== undefined
              ? { rejected: event.payload.rejected }
              : {}),
          }),
        ]
      }
      case "todo.updated": {
        return [this.envelope("todo.updated", { todos: event.payload.todos })]
      }
      case "subagent.started": {
        return [
          this.envelope("subagent.started", {
            segment_id: event.payload.segment_id,
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
            segment_id: event.payload.segment_id,
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
            segment_id: event.payload.segment_id,
            subagent_id: event.payload.subagent_id,
            text: event.payload.text,
          }),
        ]
      }
      case "subagent.text.completed": {
        return [
          this.envelope("subagent.text.completed", {
            segment_id: event.payload.segment_id,
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

  private envelope<E extends SessionEvent["event"]>(
    event: E,
    payload: AguiPayload<E>,
  ): Omit<SessionEvent, "seq" | "event_id"> {
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
