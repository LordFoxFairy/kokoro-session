import { agentEventSchema, type AgentEvent } from "../domain/agent-events"
import { parseSessionEvent, type SessionEvent } from "../domain/events"

// Normalizer：把原始 agent 事件归一化成 AGUI 信封。
// 绑定 (session_id, conversation_id, run_id)；注入 id 工厂 + clock 以便测试确定性。
// 职责：分配 event_id、单调 cursor（run_x:NNNN）、补全归属字段、按 (run_id,seq) 幂等去重、
//       维护 message_ref→message_id 稳定映射。入站过 agentEventSchema，出站过 parseSessionEvent。

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
  private readonly toolCallIds = new Map<string, string>()
  private toolCounter = 0
  // thinking 缓冲：累加 thinking.delta 文本，在首个非 thinking 出站事件或 run 收尾时归一成一条 thinking.summary。
  private thinkingBuffer = ""
  private thinkingFlushed = false
  // write_todos 的 tool_call_ref 集合：其 tool.returned 需被吞掉（已识别为 plan.updated）。
  private readonly writeTodosRefs = new Set<string>()

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

    const out = this.mapEvent(event)
    // 出站自检：每个信封必须通过 AGUI 解析器（必填字段齐全）。
    return out.map((envelope) => parseSessionEvent(envelope))
  }

  private mapEvent(event: AgentEvent): SessionEvent[] {
    // thinking.delta 只累加缓冲，不直接产出出站事件。
    if (event.kind === "thinking.delta") {
      this.thinkingBuffer += event.payload.text
      return []
    }

    // 任何非 thinking 出站事件之前，若有挂起的思考缓冲，先归一成一条 thinking.summary。
    const prefix = this.flushThinking()
    return [...prefix, ...this.mapNonThinkingEvent(event)]
  }

  // 把累加的思考文本归一成至多一条 thinking.summary（每 run 仅一次）。无缓冲 / 已 flush 则空。
  private flushThinking(): SessionEvent[] {
    if (this.thinkingFlushed || this.thinkingBuffer.length === 0) {
      return []
    }
    this.thinkingFlushed = true
    const summary = this.thinkingBuffer
    this.thinkingBuffer = ""
    return [
      this.envelope("thinking.summary", {
        run_id: this.binding.runId,
        summary,
      }),
    ]
  }

  private mapNonThinkingEvent(event: Exclude<AgentEvent, { kind: "thinking.delta" }>): SessionEvent[] {
    switch (event.kind) {
      case "run.started": {
        const envelopes: SessionEvent[] = []
        if (!this.sessionCreated) {
          this.sessionCreated = true
          envelopes.push(
            this.envelope("session.created", {
              session_id: this.binding.sessionId,
              conversation_id: this.binding.conversationId,
              owner_id: "kokoro-agent",
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
      case "tool.invoked": {
        if (event.payload.tool_name === "write_todos") {
          // harness 识别 write_todos → 内部 plan.updated（不产 tool.started，吞掉其工具卡）。
          // 记住 ref 以便对应 tool.returned 也被吞。
          this.writeTodosRefs.add(event.payload.tool_call_ref)
          const rawArgs = event.payload.args ?? {}
          const todos = "todos" in rawArgs && Array.isArray(rawArgs.todos) ? rawArgs.todos : []
          return [
            this.envelope("plan.updated", {
              plan_id: `${this.binding.runId}:plan`,
              todos,
            }),
          ]
        }
        const toolCallId = this.toolCallIdFor(event.payload.tool_call_ref)
        return [
          this.envelope("tool.started", {
            tool_call_id: toolCallId,
            tool_name: event.payload.tool_name,
          }),
        ]
      }
      case "tool.returned": {
        if (this.writeTodosRefs.has(event.payload.tool_call_ref)) {
          // write_todos 已识别为 plan，吞掉其完成事件
          return []
        }
        // 找不到配对的 tool.invoked → 忽略并记日志，不崩（边界锁定）。
        const toolCallId = this.toolCallIds.get(event.payload.tool_call_ref)
        if (!toolCallId) {
          console.warn(
            `tool.returned with no matching tool.invoked (tool_call_ref=${event.payload.tool_call_ref}); ignoring`,
          )
          return []
        }
        return [
          this.envelope("tool.completed", {
            tool_call_id: toolCallId,
            tool_name: event.payload.tool_name,
            status: event.payload.status,
          }),
        ]
      }
    }
  }

  private messageIdFor(messageRef: string): string {
    const existing = this.messageIds.get(messageRef)
    if (existing) return existing
    const id = `${this.binding.runId}:msg_${String(++this.messageCounter).padStart(4, "0")}`
    this.messageIds.set(messageRef, id)
    return id
  }

  // tool_call_ref → 对外稳定 tool_call_id（同 message_ref 套路），tool.returned 据此配对。
  private toolCallIdFor(toolCallRef: string): string {
    const existing = this.toolCallIds.get(toolCallRef)
    if (existing) return existing
    const id = `${this.binding.runId}:tool_${String(++this.toolCounter).padStart(4, "0")}`
    this.toolCallIds.set(toolCallRef, id)
    return id
  }

  private envelope(
    event: SessionEvent["event"],
    payload: Record<string, unknown>,
  ): SessionEvent {
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
