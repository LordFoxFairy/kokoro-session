import { describe, expect, test } from "bun:test"

import {
  MemorySessionStore,
  SessionRunActiveError,
  SessionRunNotActiveError,
} from "../src/application/session-store"

const START_INPUT = {
  siteId: "site_1",
  sessionId: "ses_1",
  ownerUserId: "user_1",
  content: "Build a calm landing page",
  idempotencyKey: "idem_1",
}

function makeStore(): MemorySessionStore {
  let messageNumber = 0
  let runNumber = 0
  return new MemorySessionStore({
    now: () => new Date("2026-06-30T00:00:00.000Z"),
    newMessageId: () => `msg_${++messageNumber}`,
    newRunId: () => `run_${++runNumber}`,
  })
}

describe("SessionStore", () => {
  test("creates a user message, assistant placeholder, run, and activeRunId atomically", async () => {
    const store = makeStore()

    const result = await store.startRun(START_INPUT)

    expect(result).toEqual({
      userMessageId: "msg_1",
      assistantMessageId: "msg_2",
      runId: "run_1",
    })
    await expect(store.getSession("site_1", "ses_1")).resolves.toMatchObject({
      siteId: "site_1",
      sessionId: "ses_1",
      ownerUserId: "user_1",
      activeRunId: "run_1",
      status: "active",
    })
    await expect(store.listMessages("site_1", "ses_1")).resolves.toEqual([
      {
        siteId: "site_1",
        messageId: "msg_1",
        sessionId: "ses_1",
        runId: "run_1",
        role: "user",
        content: "Build a calm landing page",
        status: "completed",
        createdAt: new Date("2026-06-30T00:00:00.000Z"),
        updatedAt: new Date("2026-06-30T00:00:00.000Z"),
      },
      {
        siteId: "site_1",
        messageId: "msg_2",
        sessionId: "ses_1",
        runId: "run_1",
        role: "assistant",
        content: "",
        status: "pending",
        createdAt: new Date("2026-06-30T00:00:00.000Z"),
        updatedAt: new Date("2026-06-30T00:00:00.000Z"),
      },
    ])
    await expect(store.listRuns("site_1", "ses_1")).resolves.toEqual([
      {
        siteId: "site_1",
        runId: "run_1",
        sessionId: "ses_1",
        userMessageId: "msg_1",
        assistantMessageId: "msg_2",
        idempotencyKey: "idem_1",
        status: "queued",
        createdAt: new Date("2026-06-30T00:00:00.000Z"),
        updatedAt: new Date("2026-06-30T00:00:00.000Z"),
      },
    ])
  })

  test("same idempotencyKey returns the original messageId and runId", async () => {
    const store = makeStore()

    const first = await store.startRun(START_INPUT)
    const retry = await store.startRun(START_INPUT)

    expect(retry).toEqual(first)
    await expect(store.listMessages("site_1", "ses_1")).resolves.toHaveLength(2)
    await expect(store.listRuns("site_1", "ses_1")).resolves.toHaveLength(1)
  })

  test("different idempotencyKey is rejected while a run is active", async () => {
    const store = makeStore()
    await store.startRun(START_INPUT)

    await expect(
      store.startRun({ ...START_INPUT, idempotencyKey: "idem_2", content: "Try again" }),
    ).rejects.toBeInstanceOf(SessionRunActiveError)

    await expect(store.listMessages("site_1", "ses_1")).resolves.toHaveLength(2)
    await expect(store.listRuns("site_1", "ses_1")).resolves.toHaveLength(1)
  })

  test("same sessionId is isolated by siteId", async () => {
    const store = makeStore()

    const siteOne = await store.startRun(START_INPUT)
    const siteTwo = await store.startRun({
      ...START_INPUT,
      siteId: "site_2",
      ownerUserId: "user_2",
      content: "Same visible session id, different site",
    })

    expect(siteOne.runId).toBe("run_1")
    expect(siteTwo.runId).toBe("run_2")
    await expect(store.getSession("site_1", "ses_1")).resolves.toMatchObject({
      siteId: "site_1",
      ownerUserId: "user_1",
      activeRunId: "run_1",
    })
    await expect(store.getSession("site_2", "ses_1")).resolves.toMatchObject({
      siteId: "site_2",
      ownerUserId: "user_2",
      activeRunId: "run_2",
    })
  })

  test("terminal event clears activeRunId in the same commit", async () => {
    const store = makeStore()
    const started = await store.startRun(START_INPUT)

    const event = await store.appendEvent({
      siteId: "site_1",
      sessionId: "ses_1",
      eventId: "evt_done",
      conversationId: "ses_1",
      runId: started.runId,
      type: "run.completed",
      timestamp: "2026-06-30T00:00:00.000Z",
      status: "completed",
      payload: { runId: started.runId },
    })

    expect(event.stored).toBe(true)
    await expect(store.getSession("site_1", "ses_1")).resolves.toMatchObject({
      activeRunId: null,
      updatedAt: new Date("2026-06-30T00:00:00.000Z"),
    })
    await expect(store.listRuns("site_1", "ses_1")).resolves.toMatchObject([
      { runId: started.runId, status: "completed" },
    ])
    await expect(store.listEvents("site_1", "ses_1")).resolves.toHaveLength(1)
  })

  test("terminal event for a non-active run is rejected without storing the event", async () => {
    const store = makeStore()
    await store.startRun(START_INPUT)

    await expect(
      store.appendEvent({
        siteId: "site_1",
        sessionId: "ses_1",
        eventId: "evt_wrong_run",
        conversationId: "ses_1",
        runId: "run_missing",
        type: "run.completed",
        timestamp: "2026-06-30T00:00:00.000Z",
        status: "completed",
      }),
    ).rejects.toBeInstanceOf(SessionRunNotActiveError)

    await expect(store.getSession("site_1", "ses_1")).resolves.toMatchObject({
      activeRunId: "run_1",
    })
    await expect(store.listRuns("site_1", "ses_1")).resolves.toMatchObject([
      { runId: "run_1", status: "queued" },
    ])
    await expect(store.listEvents("site_1", "ses_1")).resolves.toEqual([])
  })

  test("duplicate eventId is stored once", async () => {
    const store = makeStore()
    const started = await store.startRun(START_INPUT)

    await expect(
      store.appendEvent({
        siteId: "site_1",
        sessionId: "ses_1",
        eventId: "evt_repeat",
        conversationId: "ses_1",
        runId: started.runId,
        type: "message.delta",
        timestamp: "2026-06-30T00:00:00.000Z",
        payload: { delta: "hello" },
      }),
    ).resolves.toEqual({ stored: true })
    await expect(
      store.appendEvent({
        siteId: "site_1",
        sessionId: "ses_1",
        eventId: "evt_repeat",
        conversationId: "ses_1",
        runId: started.runId,
        type: "message.delta",
        timestamp: "2026-06-30T00:00:00.000Z",
        payload: { delta: "hello again" },
      }),
    ).resolves.toEqual({ stored: false })

    await expect(store.listEvents("site_1", "ses_1")).resolves.toEqual([
      {
        siteId: "site_1",
        eventId: "evt_repeat",
        sessionId: "ses_1",
        conversationId: "ses_1",
        runId: started.runId,
        type: "message.delta",
        timestamp: "2026-06-30T00:00:00.000Z",
        payload: { delta: "hello" },
        createdAt: new Date("2026-06-30T00:00:00.000Z"),
      },
    ])
  })

  test("same eventId can exist in another site session", async () => {
    const store = makeStore()
    await store.startRun(START_INPUT)
    const other = await store.startRun({ ...START_INPUT, siteId: "site_2" })

    await expect(
      store.appendEvent({
        siteId: "site_1",
        sessionId: "ses_1",
        eventId: "evt_same",
        conversationId: "ses_1",
        runId: "run_1",
        type: "message.delta",
        timestamp: "2026-06-30T00:00:00.000Z",
      }),
    ).resolves.toEqual({ stored: true })
    await expect(
      store.appendEvent({
        siteId: "site_2",
        sessionId: "ses_1",
        eventId: "evt_same",
        conversationId: "ses_1",
        runId: other.runId,
        type: "message.delta",
        timestamp: "2026-06-30T00:00:00.000Z",
      }),
    ).resolves.toEqual({ stored: true })

    await expect(store.listEvents("site_1", "ses_1")).resolves.toHaveLength(1)
    await expect(store.listEvents("site_2", "ses_1")).resolves.toHaveLength(1)
  })
})
