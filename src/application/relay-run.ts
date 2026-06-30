import type { StreamProtocol } from "./event-stream"
import type { Normalizer } from "./normalize"
import type { SessionStore } from "./session-store"
import type { AgentRunStatus } from "../domain/run"
import type { SessionEvent } from "../domain/session-event"
import { LIVE_STREAM_MAXLEN, liveStream } from "../infrastructure/live-bus"
import { runEventsStream } from "./stream-names"

export type RelayRunInput = {
  bus: StreamProtocol
  sessionStore: SessionStore
  normalizer: Normalizer
  siteId: string
  sessionId: string
  runId: string
}

// 消费某 run 的事件流 → 归一化 → 持久 SessionStore（长期真源）→ 发布 live（供 SSE 实时）。
export async function relayRun(input: RelayRunInput): Promise<void> {
  const stream = runEventsStream(input.runId)
  const live = liveStream(input.sessionId)
  for await (const item of input.bus.subscribe(stream)) {
    let envelopes
    try {
      envelopes = input.normalizer.ingest(item.event, item.cursor)
    } catch (error) {
      // 跳过单条脏事件而不中断整条流：否则其后的终态永不落库，web 该轮停留在「进行中」。
      console.error("skipping dirty agent event", input.runId, error)
      continue
    }
    if (envelopes.length > 0) {
      for (const event of envelopes) {
        const append = await input.sessionStore.appendEvent({
          siteId: input.siteId,
          sessionId: event.session_id,
          eventId: event.event_id,
          conversationId: event.conversation_id,
          runId: event.run_id,
          type: event.event,
          timestamp: event.timestamp,
          payload: event.payload,
          ...(terminalStatus(event) !== undefined ? { status: terminalStatus(event) } : {}),
        })
        if (!append.stored) continue

        await input.bus.publish(live, event, { maxlen: LIVE_STREAM_MAXLEN })
      }
    }
    if (envelopes.some((e) => e.event === "run.completed" || e.event === "run.failed")) {
      // 终态即收束 relay：不再读取该 run 的事件流，连接释放。resume/cancel 走共享请求流、
      // 非 per-run 流，无需在此清理（agent 对未知/终态 run 的迟到控制消息直接丢弃）。
      return
    }
  }
}

function terminalStatus(event: SessionEvent): AgentRunStatus | undefined {
  if (event.event === "run.failed") return "failed"
  if (event.event !== "run.completed") return undefined
  const status = event.payload.status
  if (status === "completed" || status === "cancelled" || status === "timeout") return status
  return undefined
}
