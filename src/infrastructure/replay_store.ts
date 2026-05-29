import type { SessionEvent } from "../domain/events"

export interface ReplayStore {
  append(sessionId: string, events: SessionEvent[]): void
  read(sessionId: string): SessionEvent[]
}

const replayStore = new Map<string, SessionEvent[]>()

export const memoryReplayStore: ReplayStore = {
  append(sessionId, events) {
    const previous = replayStore.get(sessionId) ?? []
    replayStore.set(sessionId, [...previous, ...events])
  },
  read(sessionId) {
    return replayStore.get(sessionId) ?? []
  },
}
