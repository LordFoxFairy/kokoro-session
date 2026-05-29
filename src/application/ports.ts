import type { SessionEvent } from "../domain/events"

export interface SessionReplayStore {
  append(sessionId: string, events: SessionEvent[]): void
  read(sessionId: string): SessionEvent[]
}

export interface AgentEventStreamWriter {
  append(stream: string, event: SessionEvent): Promise<void>
}
