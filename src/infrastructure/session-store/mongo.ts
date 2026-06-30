import { MongoServerError, type ClientSession, type Collection, type MongoClient } from "mongodb"

import {
  SessionRunActiveError,
  SessionRunNotActiveError,
  type AppendSessionEventInput,
  type AppendSessionEventResult,
  type SessionStore,
  type StartSessionRunInput,
  type StartSessionRunResult,
} from "../../application/session-store"
import type { ChatMessage } from "../../domain/message"
import type { AgentRun, AgentRunStatus } from "../../domain/run"
import type { ChatSession } from "../../domain/session"
import type { SessionEventLogEntry } from "../../domain/session-event-log"

type Clock = () => Date
type IdFactory = () => string

type MongoSessionStoreOptions = {
  dbName?: string
  sessionsCollection?: string
  messagesCollection?: string
  runsCollection?: string
  eventsCollection?: string
  outboxCollection?: string
  now?: Clock
  newMessageId?: IdFactory
  newRunId?: IdFactory
}

type SessionDoc = ChatSession & {
  activeIdempotencyKey?: string
  activeUserMessageId?: string
  activeAssistantMessageId?: string
}
type MessageDoc = ChatMessage
type RunDoc = AgentRun
type EventDoc = SessionEventLogEntry
type OutboxDoc = {
  siteId: string
  sessionId: string
  eventId: string
  createdAt: Date
}

function defaultMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

function defaultRunId(): string {
  return `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000
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
    siteId: session.siteId,
    sessionId: session.sessionId,
    ownerUserId: session.ownerUserId,
    activeRunId: session.activeRunId,
    status: session.status,
    createdAt: cloneDate(session.createdAt),
    updatedAt: cloneDate(session.updatedAt),
  }
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    siteId: message.siteId,
    messageId: message.messageId,
    sessionId: message.sessionId,
    runId: message.runId,
    role: message.role,
    content: message.content,
    status: message.status,
    createdAt: cloneDate(message.createdAt),
    updatedAt: cloneDate(message.updatedAt),
  }
}

function cloneRun(run: AgentRun): AgentRun {
  return {
    siteId: run.siteId,
    runId: run.runId,
    sessionId: run.sessionId,
    userMessageId: run.userMessageId,
    assistantMessageId: run.assistantMessageId,
    idempotencyKey: run.idempotencyKey,
    status: run.status,
    createdAt: cloneDate(run.createdAt),
    updatedAt: cloneDate(run.updatedAt),
  }
}

function cloneEvent(event: SessionEventLogEntry): SessionEventLogEntry {
  return {
    siteId: event.siteId,
    eventId: event.eventId,
    sessionId: event.sessionId,
    runId: event.runId,
    type: event.type,
    ...(event.status !== undefined ? { status: event.status } : {}),
    payload: { ...event.payload },
    createdAt: cloneDate(event.createdAt),
  }
}

export class MongoSessionStore implements SessionStore {
  private readonly sessions: Collection<SessionDoc>
  private readonly messages: Collection<MessageDoc>
  private readonly runs: Collection<RunDoc>
  private readonly events: Collection<EventDoc>
  private readonly outbox: Collection<OutboxDoc>
  private readonly now: Clock
  private readonly newMessageId: IdFactory
  private readonly newRunId: IdFactory
  private indexReady: Promise<unknown> | undefined

  constructor(
    private readonly client: MongoClient,
    options: MongoSessionStoreOptions = {},
  ) {
    const db = client.db(options.dbName ?? "kokoro_session")
    this.sessions = db.collection<SessionDoc>(options.sessionsCollection ?? "sessions")
    this.messages = db.collection<MessageDoc>(options.messagesCollection ?? "messages")
    this.runs = db.collection<RunDoc>(options.runsCollection ?? "runs")
    this.events = db.collection<EventDoc>(options.eventsCollection ?? "session_events")
    this.outbox = db.collection<OutboxDoc>(options.outboxCollection ?? "outbox")
    this.now = options.now ?? (() => new Date())
    this.newMessageId = options.newMessageId ?? defaultMessageId
    this.newRunId = options.newRunId ?? defaultRunId
  }

  async startRun(input: StartSessionRunInput): Promise<StartSessionRunResult> {
    await this.ensureIndexes()
    const existingRun = await this.findRunByIdempotency(input)
    if (existingRun) return this.resultFromRun(existingRun)

    const at = this.now()
    const result = {
      userMessageId: this.newMessageId(),
      assistantMessageId: this.newMessageId(),
      runId: this.newRunId(),
    }
    return this.client.withSession(async (session) =>
      session.withTransaction(async () => {
        const acquired = await this.acquireAdmission(input, result, at, session)
        if (!acquired) {
          return this.resolveExistingAdmission(input, session)
        }

        await this.upsertRunArtifacts(input, result, at, session)
        return result
      }),
    )
  }

  async appendEvent(input: AppendSessionEventInput): Promise<AppendSessionEventResult> {
    await this.ensureIndexes()
    if (await this.events.findOne({ siteId: input.siteId, sessionId: input.sessionId, eventId: input.eventId })) {
      return { stored: false }
    }

    const at = this.now()
    if (isTerminalRunStatus(input.status)) {
      return this.client.withSession((session) =>
        session.withTransaction(async () => {
          const run = await this.runs.findOne(
            {
              siteId: input.siteId,
              sessionId: input.sessionId,
              runId: input.runId,
            },
            { session },
          )
          if (!run) {
            throw new SessionRunNotActiveError(input.siteId, input.sessionId, input.runId)
          }

          const stored = await this.insertEvent(input, at, session)
          if (!stored) return { stored: false }

          const sessionUpdate = await this.sessions.updateOne(
            { siteId: input.siteId, sessionId: input.sessionId, activeRunId: input.runId },
            {
              $set: { activeRunId: null, updatedAt: at },
              $unset: {
                activeIdempotencyKey: "",
                activeUserMessageId: "",
                activeAssistantMessageId: "",
              },
            },
            { session },
          )
          if (sessionUpdate.matchedCount !== 1) {
            if (
              await this.events.findOne(
                { siteId: input.siteId, sessionId: input.sessionId, eventId: input.eventId },
                { session },
              )
            ) {
              return { stored: false }
            }
            throw new SessionRunNotActiveError(input.siteId, input.sessionId, input.runId)
          }
          await this.runs.updateOne(
            { siteId: input.siteId, sessionId: input.sessionId, runId: input.runId },
            { $set: { status: input.status, updatedAt: at } },
            { session },
          )
          return { stored: true }
        }),
      )
    }

    return { stored: await this.insertEvent(input, at) }
  }

  async getSession(siteId: string, sessionId: string): Promise<ChatSession | null> {
    const session = await this.sessions.findOne({ siteId, sessionId })
    return session ? cloneSession(session) : null
  }

  async listMessages(siteId: string, sessionId: string): Promise<ChatMessage[]> {
    const docs = await this.messages.find({ siteId, sessionId }).sort({ createdAt: 1, _id: 1 }).toArray()
    return docs.map(cloneMessage)
  }

  async listRuns(siteId: string, sessionId: string): Promise<AgentRun[]> {
    const docs = await this.runs.find({ siteId, sessionId }).sort({ createdAt: 1, _id: 1 }).toArray()
    return docs.map(cloneRun)
  }

  async listEvents(siteId: string, sessionId: string): Promise<SessionEventLogEntry[]> {
    const docs = await this.events.find({ siteId, sessionId }).sort({ _id: 1 }).toArray()
    return docs.map(cloneEvent)
  }

  close(): Promise<void> {
    return this.client.close()
  }

  private ensureIndexes(): Promise<unknown> {
    this.indexReady ??= Promise.all([
      this.sessions.createIndex({ siteId: 1, sessionId: 1 }, { unique: true }),
      this.messages.createIndex({ siteId: 1, sessionId: 1, messageId: 1 }, { unique: true }),
      this.runs.createIndex({ siteId: 1, runId: 1 }, { unique: true }),
      this.runs.createIndex({ siteId: 1, sessionId: 1, status: 1 }),
      this.runs.createIndex({ siteId: 1, sessionId: 1, idempotencyKey: 1 }, { unique: true }),
      this.events.createIndex({ siteId: 1, sessionId: 1, eventId: 1 }, { unique: true }),
      this.outbox.createIndex({ siteId: 1, sessionId: 1, eventId: 1 }),
    ])
    return this.indexReady
  }

  private async findRunByIdempotency(input: StartSessionRunInput): Promise<RunDoc | null> {
    return this.runs.findOne({
      siteId: input.siteId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
    })
  }

  private resultFromRun(run: RunDoc): StartSessionRunResult {
    return {
      userMessageId: run.userMessageId,
      assistantMessageId: run.assistantMessageId,
      runId: run.runId,
    }
  }

  private async acquireAdmission(
    input: StartSessionRunInput,
    result: StartSessionRunResult,
    at: Date,
    session: ClientSession,
  ): Promise<boolean> {
    const activeFields = {
      activeRunId: result.runId,
      activeIdempotencyKey: input.idempotencyKey,
      activeUserMessageId: result.userMessageId,
      activeAssistantMessageId: result.assistantMessageId,
      updatedAt: at,
    }
    const updated = await this.sessions.updateOne(
      { siteId: input.siteId, sessionId: input.sessionId, activeRunId: null },
      { $set: activeFields },
      { session },
    )
    if (updated.matchedCount === 1) return true

    try {
      await this.sessions.insertOne(
        {
          siteId: input.siteId,
          sessionId: input.sessionId,
          ownerUserId: input.ownerUserId,
          activeRunId: result.runId,
          activeIdempotencyKey: input.idempotencyKey,
          activeUserMessageId: result.userMessageId,
          activeAssistantMessageId: result.assistantMessageId,
          status: "active",
          createdAt: at,
          updatedAt: at,
        },
        { session },
      )
      return true
    } catch (error) {
      if (isDuplicateKey(error)) return false
      throw error
    }
  }

  private async resolveExistingAdmission(
    input: StartSessionRunInput,
    session: ClientSession,
  ): Promise<StartSessionRunResult> {
    const existingRun = await this.runs.findOne(
      {
        siteId: input.siteId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
      },
      { session },
    )
    if (existingRun) return this.resultFromRun(existingRun)

    const sessionDoc = await this.sessions.findOne(
      { siteId: input.siteId, sessionId: input.sessionId },
      { session },
    )
    if (
      sessionDoc?.activeRunId &&
      sessionDoc.activeIdempotencyKey === input.idempotencyKey &&
      sessionDoc.activeUserMessageId &&
      sessionDoc.activeAssistantMessageId
    ) {
      const result = {
        userMessageId: sessionDoc.activeUserMessageId,
        assistantMessageId: sessionDoc.activeAssistantMessageId,
        runId: sessionDoc.activeRunId,
      }
      await this.upsertRunArtifacts(input, result, sessionDoc.updatedAt, session)
      return result
    }

    if (sessionDoc?.activeRunId) {
      throw new SessionRunActiveError(input.siteId, input.sessionId, sessionDoc.activeRunId)
    }

    throw new SessionRunActiveError(input.siteId, input.sessionId, "unknown")
  }

  private async upsertRunArtifacts(
    input: StartSessionRunInput,
    result: StartSessionRunResult,
    at: Date,
    session: ClientSession,
  ): Promise<void> {
    const userMessage: MessageDoc = {
      siteId: input.siteId,
      messageId: result.userMessageId,
      sessionId: input.sessionId,
      runId: result.runId,
      role: "user",
      content: input.content,
      status: "completed",
      createdAt: at,
      updatedAt: at,
    }
    const assistantMessage: MessageDoc = {
      siteId: input.siteId,
      messageId: result.assistantMessageId,
      sessionId: input.sessionId,
      runId: result.runId,
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: at,
      updatedAt: at,
    }
    const run: RunDoc = {
      siteId: input.siteId,
      runId: result.runId,
      sessionId: input.sessionId,
      userMessageId: result.userMessageId,
      assistantMessageId: result.assistantMessageId,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      createdAt: at,
      updatedAt: at,
    }
    await this.messages.bulkWrite(
      [
        {
          updateOne: {
            filter: { siteId: input.siteId, sessionId: input.sessionId, messageId: userMessage.messageId },
            update: { $setOnInsert: userMessage },
            upsert: true,
          },
        },
        {
          updateOne: {
            filter: { siteId: input.siteId, sessionId: input.sessionId, messageId: assistantMessage.messageId },
            update: { $setOnInsert: assistantMessage },
            upsert: true,
          },
        },
      ],
      { session },
    )
    await this.runs.updateOne(
      { siteId: input.siteId, sessionId: input.sessionId, idempotencyKey: input.idempotencyKey },
      { $setOnInsert: run },
      { upsert: true, session },
    )
  }

  private async insertEvent(
    input: AppendSessionEventInput,
    at: Date,
    session?: ClientSession,
  ): Promise<boolean> {
    try {
      await this.events.insertOne(
        {
          siteId: input.siteId,
          eventId: input.eventId,
          sessionId: input.sessionId,
          runId: input.runId,
          type: input.type,
          ...(input.status !== undefined ? { status: input.status } : {}),
          payload: input.payload ?? {},
          createdAt: at,
        },
        session ? { session } : undefined,
      )
      return true
    } catch (error) {
      if (isDuplicateKey(error)) return false
      throw error
    }
  }
}
