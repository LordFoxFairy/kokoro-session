import type { AgentRunStatus } from "./run"

export type SessionEventLogEntry = {
  siteId: string
  eventId: string
  sessionId: string
  runId: string
  type: string
  status?: AgentRunStatus
  payload: Record<string, unknown>
  createdAt: Date
}
