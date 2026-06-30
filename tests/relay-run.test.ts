import { describe, expect, test } from "bun:test"

import type { StreamItem, StreamProtocol } from "../src/application/event-stream"
import { Normalizer } from "../src/application/normalize"
import { relayRun } from "../src/application/relay-run"
import { MemorySessionStore, type SessionStore } from "../src/application/session-store"
import { liveStream } from "../src/infrastructure/live-bus"

const SITE_ID = "site_1"
const SESSION_ID = "ses_relay"
const RUN_ID = "run_relay"
const ENV = { request_id: RUN_ID, timestamp: 1700000000 }

class StaticStream implements StreamProtocol {
  readonly published: Array<{ stream: string; event: unknown }> = []

  constructor(private readonly items: StreamItem[]) {}

  publish(stream: string, event: unknown, _opts?: { maxlen?: number }): Promise<string> {
    void _opts
    this.published.push({ stream, event })
    return Promise.resolve(`live_${this.published.length}`)
  }

  async *subscribe(_stream: string, _fromCursor?: string): AsyncIterable<StreamItem> {
    void _stream
    void _fromCursor
    for (const item of this.items) yield item
  }

  delete(_stream: string): Promise<void> {
    void _stream
    return Promise.resolve()
  }
}

function makeNormalizer(): Normalizer {
  return new Normalizer(
    { sessionId: SESSION_ID, conversationId: SESSION_ID, runId: RUN_ID },
    { now: () => new Date("2026-06-30T00:00:00.000Z") },
  )
}

function makeSessionStore(): MemorySessionStore {
  return new MemorySessionStore({
    now: () => new Date("2026-06-30T00:00:00.000Z"),
    newMessageId: (() => {
      let next = 0
      return () => `msg_${++next}`
    })(),
    newRunId: () => RUN_ID,
  })
}

async function seedActiveRun(store: MemorySessionStore): Promise<void> {
  await store.startRun({
    siteId: SITE_ID,
    sessionId: SESSION_ID,
    ownerUserId: "user_1",
    content: "hello",
    idempotencyKey: "idem_1",
  })
}

async function runRelay(input: {
  bus: StreamProtocol
  sessionStore: SessionStore
}): Promise<void> {
  const relayInput = {
    bus: input.bus,
    sessionStore: input.sessionStore,
    normalizer: makeNormalizer(),
    siteId: SITE_ID,
    sessionId: SESSION_ID,
    runId: RUN_ID,
  }
  await relayRun(relayInput)
}

describe("relayRun DB-first relay", () => {
  test("stores event before publishing live", async () => {
    const calls: string[] = []
    const bus = new StaticStream([
      {
        cursor: "redis-1",
        event: {
          event: "text_chunk",
          ...ENV,
          data: { segment_id: "seg_1", text: "hello", final: false },
        },
      },
      { cursor: "redis-2", event: { event: "agent_done", ...ENV, data: { status: "completed", usage: {} } } },
    ])
    const inner = makeSessionStore()
    await seedActiveRun(inner)
    const sessionStore: SessionStore = {
      appendEvent: async (event) => {
        calls.push(`store:${event.type}`)
        return inner.appendEvent(event)
      },
      getSession: (siteId, sessionId) => inner.getSession(siteId, sessionId),
      listEvents: (siteId, sessionId) => inner.listEvents(siteId, sessionId),
      listMessages: (siteId, sessionId) => inner.listMessages(siteId, sessionId),
      listRuns: (siteId, sessionId) => inner.listRuns(siteId, sessionId),
      startRun: (input) => inner.startRun(input),
    }
    const trackedBus: StreamProtocol = {
      publish: async (stream, event, opts) => {
        if (stream === liveStream(SESSION_ID)) calls.push(`live:${String((event as { event?: unknown }).event)}`)
        return bus.publish(stream, event, opts)
      },
      subscribe: (stream, fromCursor) => bus.subscribe(stream, fromCursor),
      delete: (stream) => bus.delete(stream),
    }

    await runRelay({ bus: trackedBus, sessionStore })

    expect(calls.slice(0, 2)).toEqual(["store:message.delta", "live:message.delta"])
  })

  test("terminal event updates run and clears activeRunId before live publish", async () => {
    const observations: string[] = []
    const bus = new StaticStream([
      { cursor: "redis-1", event: { event: "agent_done", ...ENV, data: { status: "completed", usage: {} } } },
    ])
    const store = makeSessionStore()
    await seedActiveRun(store)
    const trackedBus: StreamProtocol = {
      publish: async (stream, event, opts) => {
        if (stream === liveStream(SESSION_ID)) {
          const session = await store.getSession(SITE_ID, SESSION_ID)
          observations.push(`live:${String((event as { event?: unknown }).event)}:${session?.activeRunId ?? "null"}`)
        }
        return bus.publish(stream, event, opts)
      },
      subscribe: (stream, fromCursor) => bus.subscribe(stream, fromCursor),
      delete: (stream) => bus.delete(stream),
    }

    await runRelay({ bus: trackedBus, sessionStore: store })

    expect(observations).toEqual(["live:run.completed:null"])
    await expect(store.listRuns(SITE_ID, SESSION_ID)).resolves.toMatchObject([
      { runId: RUN_ID, status: "completed" },
    ])
  })

  test("same raw stream entry retry does not duplicate session_event", async () => {
    const raw = {
      event: "text_chunk",
      ...ENV,
      data: { segment_id: "seg_1", text: "hello", final: false },
    }
    const bus = new StaticStream([
      { cursor: "redis-1", event: raw },
      { cursor: "redis-1", event: raw },
      { cursor: "redis-2", event: { event: "agent_done", ...ENV, data: { status: "completed", usage: {} } } },
    ])
    const store = makeSessionStore()
    await seedActiveRun(store)

    await runRelay({ bus, sessionStore: store })

    const events = await store.listEvents(SITE_ID, SESSION_ID)
    expect(events.filter((event) => event.type === "message.delta")).toHaveLength(1)
  })

  test("malformed raw event is skipped without poisoning mongo/session store", async () => {
    const bus = new StaticStream([
      { cursor: "redis-1", event: { event: "text_chunk", ...ENV, data: { segment_id: "seg_1" } } },
      { cursor: "redis-2", event: { event: "agent_done", ...ENV, data: { status: "completed", usage: {} } } },
    ])
    const store = makeSessionStore()
    await seedActiveRun(store)

    await runRelay({ bus, sessionStore: store })

    await expect(store.getSession(SITE_ID, SESSION_ID)).resolves.toMatchObject({ activeRunId: null })
    expect((await store.listEvents(SITE_ID, SESSION_ID)).map((event) => event.type)).toEqual([
      "run.completed",
    ])
  })
})
