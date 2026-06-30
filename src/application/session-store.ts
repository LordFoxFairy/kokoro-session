import type { ChatMessage } from "../domain/message"
import type { AgentRun, AgentRunStatus } from "../domain/run"
import type { ChatSession } from "../domain/session"
import type { SessionEventLogEntry } from "../domain/session-event-log"
import type { SessionEventName } from "../domain/session-event"

type Clock = () => Date
type IdFactory = () => string

export type StartSessionRunInput = {
  siteId: string
  sessionId: string
  ownerUserId: string
  content: string
  idempotencyKey: string
}

export type StartSessionRunResult = {
  userMessageId: string
  assistantMessageId: string
  runId: string
}

export type AppendSessionEventInput = {
  siteId: string
  sessionId: string
  eventId: string
  conversationId: string
  runId: string
  type: SessionEventName
  timestamp: string
  status?: AgentRunStatus
  payload?: Record<string, unknown>
}

export type AppendSessionEventResult = {
  stored: boolean
}

export type SessionStore = {
  startRun(input: StartSessionRunInput): Promise<StartSessionRunResult>
  appendEvent(input: AppendSessionEventInput): Promise<AppendSessionEventResult>
  getSession(siteId: string, sessionId: string): Promise<ChatSession | null>
  listMessages(siteId: string, sessionId: string): Promise<ChatMessage[]>
  listRuns(siteId: string, sessionId: string): Promise<AgentRun[]>
  listEvents(
    siteId: string,
    sessionId: string,
    opts?: { afterEventId?: string; limit?: number },
  ): Promise<SessionEventLogEntry[]>
}

export class SessionRunActiveError extends Error {
  constructor(siteId: string, sessionId: string, activeRunId: string) {
    super(`Session ${siteId}/${sessionId} already has active run ${activeRunId}`)
    this.name = "SessionRunActiveError"
  }
}

export class SessionRunNotActiveError extends Error {
  constructor(siteId: string, sessionId: string, runId: string) {
    super(`Session ${siteId}/${sessionId} does not have active run ${runId}`)
    this.name = "SessionRunNotActiveError"
  }
}

type MemorySessionStoreOptions = {
  now?: Clock
  newMessageId?: IdFactory
  newRunId?: IdFactory
}

function defaultMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

function defaultRunId(): string {
  return `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

function isTerminalRunStatus(status: AgentRunStatus | undefined): status is AgentRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timeout" ||
    status === "enqueue_failed"
  )
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime())
}

function cloneSession(session: ChatSession): ChatSession {
  return {
    ...session,
    createdAt: cloneDate(session.createdAt),
    updatedAt: cloneDate(session.updatedAt),
  }
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    createdAt: cloneDate(message.createdAt),
    updatedAt: cloneDate(message.updatedAt),
  }
}

function cloneRun(run: AgentRun): AgentRun {
  return {
    ...run,
    createdAt: cloneDate(run.createdAt),
    updatedAt: cloneDate(run.updatedAt),
  }
}

function cloneEvent(event: SessionEventLogEntry): SessionEventLogEntry {
  return {
    ...event,
    payload: { ...event.payload },
    createdAt: cloneDate(event.createdAt),
  }
}

export class MemorySessionStore implements SessionStore {
  private readonly now: Clock
  private readonly newMessageId: IdFactory
  private readonly newRunId: IdFactory
  private readonly sessions = new Map<string, ChatSession>()
  private readonly messages = new Map<string, ChatMessage[]>()
  private readonly runs = new Map<string, AgentRun[]>()
  private readonly events = new Map<string, SessionEventLogEntry[]>()
  private readonly eventIds = new Set<string>()
  private readonly idempotency = new Map<string, StartSessionRunResult>()

  constructor(options: MemorySessionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.newMessageId = options.newMessageId ?? defaultMessageId
    this.newRunId = options.newRunId ?? defaultRunId
  }

  startRun(input: StartSessionRunInput): Promise<StartSessionRunResult> {
    const key = this.sessionKey(input.siteId, input.sessionId)
    const previous = this.idempotency.get(
      this.idempotencyKey(input.siteId, input.sessionId, input.idempotencyKey),
    )
    if (previous !== undefined) {
      return Promise.resolve({ ...previous })
    }

    const existingSession = this.sessions.get(key)
    if (existingSession?.activeRunId !== null && existingSession?.activeRunId !== undefined) {
      return Promise.reject(
        new SessionRunActiveError(input.siteId, input.sessionId, existingSession.activeRunId),
      )
    }

    const at = this.now()
    const userMessageId = this.newMessageId()
    const assistantMessageId = this.newMessageId()
    const runId = this.newRunId()
    const session: ChatSession =
      existingSession === undefined
        ? {
            siteId: input.siteId,
            sessionId: input.sessionId,
            ownerUserId: input.ownerUserId,
            activeRunId: runId,
            status: "active",
            createdAt: at,
            updatedAt: at,
          }
        : {
            ...existingSession,
            activeRunId: runId,
            updatedAt: at,
          }

    const userMessage: ChatMessage = {
      siteId: input.siteId,
      messageId: userMessageId,
      sessionId: input.sessionId,
      runId,
      role: "user",
      content: input.content,
      status: "completed",
      createdAt: at,
      updatedAt: at,
    }
    const assistantMessage: ChatMessage = {
      siteId: input.siteId,
      messageId: assistantMessageId,
      sessionId: input.sessionId,
      runId,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: at,
      updatedAt: at,
    }
    const run: AgentRun = {
      siteId: input.siteId,
      runId,
      sessionId: input.sessionId,
      userMessageId,
      assistantMessageId,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    }

    this.sessions.set(key, session)
    this.messages.set(key, [...(this.messages.get(key) ?? []), userMessage, assistantMessage])
    this.runs.set(key, [...(this.runs.get(key) ?? []), run])

    const result = { userMessageId, assistantMessageId, runId }
    this.idempotency.set(
      this.idempotencyKey(input.siteId, input.sessionId, input.idempotencyKey),
      result,
    )
    return Promise.resolve({ ...result })
  }

  appendEvent(input: AppendSessionEventInput): Promise<AppendSessionEventResult> {
    const key = this.sessionKey(input.siteId, input.sessionId)
    const eventKey = this.eventKey(input.siteId, input.sessionId, input.eventId)
    if (this.eventIds.has(eventKey)) {
      return Promise.resolve({ stored: false })
    }

    const at = this.now()
    const terminalStatus = input.status
    if (isTerminalRunStatus(terminalStatus)) {
      const session = this.sessions.get(key)
      const hasRun = (this.runs.get(key) ?? []).some((run) => run.runId === input.runId)
      if (session?.activeRunId !== input.runId || !hasRun) {
        return Promise.reject(new SessionRunNotActiveError(input.siteId, input.sessionId, input.runId))
      }
    }

    const entry: SessionEventLogEntry = {
      siteId: input.siteId,
      eventId: input.eventId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      runId: input.runId,
      type: input.type,
      timestamp: input.timestamp,
      ...(input.status !== undefined ? { status: input.status } : {}),
      payload: input.payload ?? {},
      createdAt: at,
    }

    this.eventIds.add(eventKey)
    this.events.set(key, [...(this.events.get(key) ?? []), entry])

    if (isTerminalRunStatus(terminalStatus)) {
      const runs = this.runs.get(key) ?? []
      this.runs.set(
        key,
        runs.map((run) =>
          run.runId === input.runId ? { ...run, status: terminalStatus, updatedAt: at } : run,
        ),
      )
      const session = this.sessions.get(key)
      if (session?.activeRunId === input.runId) {
        this.sessions.set(key, {
          ...session,
          activeRunId: null,
          updatedAt: at,
        })
      }
    }

    return Promise.resolve({ stored: true })
  }

  getSession(siteId: string, sessionId: string): Promise<ChatSession | null> {
    const session = this.sessions.get(this.sessionKey(siteId, sessionId))
    return Promise.resolve(session === undefined ? null : cloneSession(session))
  }

  listMessages(siteId: string, sessionId: string): Promise<ChatMessage[]> {
    return Promise.resolve((this.messages.get(this.sessionKey(siteId, sessionId)) ?? []).map(cloneMessage))
  }

  listRuns(siteId: string, sessionId: string): Promise<AgentRun[]> {
    return Promise.resolve((this.runs.get(this.sessionKey(siteId, sessionId)) ?? []).map(cloneRun))
  }

  listEvents(
    siteId: string,
    sessionId: string,
    opts: { afterEventId?: string; limit?: number } = {},
  ): Promise<SessionEventLogEntry[]> {
    const all = this.events.get(this.sessionKey(siteId, sessionId)) ?? []
    const start =
      opts.afterEventId === undefined
        ? 0
        : Math.max(0, all.findIndex((event) => event.eventId === opts.afterEventId) + 1)
    const end = opts.limit === undefined ? undefined : start + opts.limit
    return Promise.resolve(all.slice(start, end).map(cloneEvent))
  }

  private sessionKey(siteId: string, sessionId: string): string {
    return `${siteId}:${sessionId}`
  }

  private eventKey(siteId: string, sessionId: string, eventId: string): string {
    return `${this.sessionKey(siteId, sessionId)}:${eventId}`
  }

  private idempotencyKey(siteId: string, sessionId: string, idempotencyKey: string): string {
    return `${this.sessionKey(siteId, sessionId)}:${idempotencyKey}`
  }
}
