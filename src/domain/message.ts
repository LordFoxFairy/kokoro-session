export type ChatMessageRole = "user" | "assistant"
export type ChatMessageStatus = "pending" | "completed"

export type ChatMessage = {
  siteId: string
  messageId: string
  sessionId: string
  runId: string
  role: ChatMessageRole
  content: string
  status: ChatMessageStatus
  createdAt: Date
  updatedAt: Date
}
