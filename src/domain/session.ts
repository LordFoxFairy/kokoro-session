export type ChatSessionStatus = "active" | "archived" | "deleted"

export type ChatSession = {
  siteId: string
  sessionId: string
  ownerUserId: string
  activeRunId: string | null
  status: ChatSessionStatus
  createdAt: Date
  updatedAt: Date
}
