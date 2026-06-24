import { agentEventSchema, type AgentEvent } from "../domain/agent-event"
import { parseSessionEvent, type AguiPayload, type SessionEvent } from "../domain/session-event"

// 把 agent canonical wire 事件归一化成 AG-UI 信封；注入 clock 让时间戳在测试里确定。
// agent 不再发 seq；定序/去重靠 transport cursor（零填充数字串），seq 由 cursor 派生。

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
  private readonly seenCursors = new Set<string>()

  constructor(binding: NormalizerBinding, clock: NormalizerClock) {
    this.binding = binding
    this.clock = clock
  }

  ingest(raw: unknown, cursor: string): SessionEvent[] {
    // 入站严格校验：缺字段 / 多余键 / 未知 event 直接抛，不将脏事件归一化进 replay。
    const event = agentEventSchema.parse(raw)

    // seq 由 transport cursor 派生（cursor 是定宽数字串，唯一定序源）。
    const seq = Number(cursor)

    const envelopes = this.mapEvent(event)

    // 幂等：同一 cursor 重复输入只产出一次。终态(run.completed/run.failed)豁免去重：
    // 若同一 cursor 复用发终态，去重会丢弃它，导致 relay 永不收束、web 停留在「进行中」；
    // 重复终态由 web 端 event_id 去重处理。
    const isTerminal = envelopes.some(
      (e) => e.event === "run.completed" || e.event === "run.failed",
    )
    if (!isTerminal && this.seenCursors.has(cursor)) {
      return []
    }
    this.seenCursors.add(cursor)

    // 出站自检：每个信封过 AG-UI 解析器；透传由 cursor 派生的 seq。
    // event_id 确定性派生自 (request_id, cursor, event)：重启/多副本重放产生同一 id，web 去重幂等。
    return envelopes.map((envelope) =>
      parseSessionEvent({
        ...envelope,
        seq,
        event_id: `evt_${event.request_id}_${cursor}_${envelope.event}`,
      }),
    )
  }

  private mapEvent(event: AgentEvent): Omit<SessionEvent, "seq" | "event_id">[] {
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
      case "tool_call_end":
        return [
          this.envelope("tool.returned", {
            segment_id: event.data.segment_id,
            tool_id: event.data.tool_id,
            name: event.data.name,
            result: event.data.result,
            is_error: event.data.is_error,
            rejected: event.data.rejected,
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
  ): Omit<SessionEvent, "seq" | "event_id">[] {
    switch (data.status) {
      case "started": {
        // 维持现有 run.started 行为：首次合成 session.created，再发 run.created。
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
        envelopes.push(this.envelope("run.created", { run_id: requestId }))
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
          }),
        ]
      case "custom":
        // 业务遥测，web 不渲染 → 丢弃。
        return []
      case "awaiting_approval":
        // 对 pending[] 每项扇出一条 tool.awaiting_approval。
        return data.pending.map((p) =>
          this.envelope("tool.awaiting_approval", {
            segment_id: data.segment_id,
            tool_id: p.tool_id,
            name: p.name,
            args: p.args,
          }),
        )
    }
  }

  private mapTextChunk(
    data: Extract<AgentEvent, { event: "text_chunk" }>["data"],
  ): Omit<SessionEvent, "seq" | "event_id">[] {
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
