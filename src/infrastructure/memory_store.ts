import type { SessionEvent } from "../domain/events"

const replayStore = new Map<string, SessionEvent[]>()

export function appendEvents(sessionId: string, events: SessionEvent[]) {
  const previous = replayStore.get(sessionId) ?? []
  replayStore.set(sessionId, [...previous, ...events])
}

export function readEvents(sessionId: string) {
  return replayStore.get(sessionId) ?? []
}
