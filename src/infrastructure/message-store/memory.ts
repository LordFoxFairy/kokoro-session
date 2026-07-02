import type { MessageStore, StoredEvent } from "../../application/event-stream"

// 进程内易失实现：按 sessionId 累积、event_id 去重、到达序即数组序（relay 本就按序 append）。
export class MemoryMessageStore implements MessageStore {
  private readonly bySession = new Map<string, StoredEvent[]>()
  private readonly seen = new Map<string, Set<string>>()

  append(sessionId: string, events: StoredEvent[]): Promise<void> {
    const list = this.bySession.get(sessionId) ?? []
    const seen = this.seen.get(sessionId) ?? new Set<string>()
    for (const stored of events) {
      // event_id 幂等：relay 重启以新 cursor 重投同一事件，只存首次（保首条 cursor 稳定）。
      if (seen.has(stored.event.event_id)) continue
      seen.add(stored.event.event_id)
      list.push(stored)
    }
    this.bySession.set(sessionId, list)
    this.seen.set(sessionId, seen)
    return Promise.resolve()
  }

  read(
    sessionId: string,
    opts?: { afterCursor?: string; limit?: number },
  ): Promise<StoredEvent[]> {
    const list = this.bySession.get(sessionId) ?? []
    // afterCursor 命中 → 从其后续读；未知 cursor → 退回全量，不空流。
    let start = 0
    if (opts?.afterCursor !== undefined) {
      const at = list.findIndex((s) => s.cursor === opts.afterCursor)
      if (at >= 0) start = at + 1
    }
    const end = opts?.limit === undefined ? list.length : start + opts.limit
    return Promise.resolve(list.slice(start, end))
  }

  readRun(sessionId: string, runId: string): Promise<StoredEvent[]> {
    const list = this.bySession.get(sessionId) ?? []
    return Promise.resolve(list.filter((stored) => stored.event.run_id === runId))
  }
}
