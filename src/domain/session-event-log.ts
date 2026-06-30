import type { AgentRunStatus } from "./run"
import { parseSessionEvent, type SessionEvent, type SessionEventName } from "./session-event"

export type SessionEventLogEntry = {
  siteId: string
  eventId: string
  sessionId: string
  conversationId: string
  runId: string
  type: SessionEventName
  timestamp: string
  status?: AgentRunStatus
  payload: Record<string, unknown>
  createdAt: Date
}

export function sessionEventFromLog(entry: SessionEventLogEntry): SessionEvent {
  return parseSessionEvent({
    event: entry.type,
    event_id: entry.eventId,
    session_id: entry.sessionId,
    conversation_id: entry.conversationId,
    run_id: entry.runId,
    timestamp: entry.timestamp,
    payload: entry.payload,
  })
}
