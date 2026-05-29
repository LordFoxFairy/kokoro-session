import type { SessionEvent } from "../domain/events"
import type { StartRunInput } from "../domain/sessions"

export interface SessionReplayStore {
  append(sessionId: string, events: SessionEvent[]): void
  read(sessionId: string): SessionEvent[]
}

export interface AgentRunStreamClient {
  streamRun(input: StartRunInput): AsyncIterable<SessionEvent>
}
