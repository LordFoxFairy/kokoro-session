export type AgentRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "enqueue_failed"

export type AgentRun = {
  siteId: string
  runId: string
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  idempotencyKey: string
  status: AgentRunStatus
  createdAt: Date
  updatedAt: Date
}
