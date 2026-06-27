import type { MessageStore } from "../../application/event-stream"
import type { SessionEvent } from "../../domain/session-event"

// 进程内易失实现：按 sessionId 累积、event_id 去重、到达序即 (seq, 到达) 有序（relay 本就按序 append）。
export class MemoryMessageStore implements MessageStore {
  private readonly bySession = new Map<string, SessionEvent[]>()
  private readonly seen = new Map<string, Set<string>>()

  append(sessionId: string, events: SessionEvent[]): Promise<void> {
    const list = this.bySession.get(sessionId) ?? []
    const seen = this.seen.get(sessionId) ?? new Set<string>()
    for (const event of events) {
      // event_id 幂等：重连/重放同一事件只存一次（与 sqlite PRIMARY KEY 同语义）。
      if (seen.has(event.event_id)) continue
      seen.add(event.event_id)
      list.push(event)
    }
    this.bySession.set(sessionId, list)
    this.seen.set(sessionId, seen)
    return Promise.resolve()
  }

  read(
    sessionId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<SessionEvent[]> {
    const after = opts?.afterSeq ?? -1
    const limit = opts?.limit ?? Number.POSITIVE_INFINITY
    const out = (this.bySession.get(sessionId) ?? [])
      .filter((e) => e.seq > after)
      .slice(0, limit)
    return Promise.resolve(out)
  }
}
