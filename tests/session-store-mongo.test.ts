import { afterAll, describe, expect, test } from "vitest"

import { MongoClient } from "mongodb"

import {
  SessionRunActiveError,
  SessionRunNotActiveError,
} from "../src/application/session-store"
import { MongoSessionStore } from "../src/infrastructure/session-store"

const MONGO_URL = process.env.KOKORO_TEST_MONGO_URL ?? "mongodb://127.0.0.1:27117"

async function probeMongo(): Promise<MongoClient | null> {
  try {
    const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 800 })
    await client.connect()
    await client.db("admin").command({ ping: 1 })
    const probeDb = `kokoro_session_probe_${Date.now()}`
    await client.withSession((session) =>
      session.withTransaction(async () => {
        await client.db(probeDb).collection("transaction_probe").insertOne({ ok: true }, { session })
      }),
    )
    await client.db(probeDb).dropDatabase()
    return client
  } catch {
    return null
  }
}

const client = await probeMongo()
const itOrSkip = client ? test : test.skip

afterAll(async () => {
  if (client) await client.close()
})

function makeDbName(label: string): string {
  return `kokoro_session_test_${Date.now()}_${label}`
}

function makeStore(mongo: MongoClient, dbName: string): MongoSessionStore {
  let messageNumber = 0
  let runNumber = 0
  return new MongoSessionStore(mongo, {
    dbName,
    now: () => new Date("2026-06-30T00:00:00.000Z"),
    newMessageId: () => `msg_${++messageNumber}`,
    newRunId: () => `run_${++runNumber}`,
  })
}

function eventMeta(sessionId = "ses_1") {
  return {
    conversationId: sessionId,
    timestamp: "2026-06-30T00:00:00.000Z",
  }
}

describe("MongoSessionStore", () => {
  itOrSkip("persists sessions/messages/runs/events across clients", async () => {
    const dbName = makeDbName("persist")
    const writer = makeStore(client as MongoClient, dbName)
    const started = await writer.startRun({
      siteId: "site_1",
      sessionId: "ses_1",
      ownerUserId: "user_1",
      content: "Build the runtime",
      idempotencyKey: "idem_1",
    })
    const retry = await writer.startRun({
      siteId: "site_1",
      sessionId: "ses_1",
      ownerUserId: "user_1",
      content: "Build the runtime",
      idempotencyKey: "idem_1",
    })
    await writer.appendEvent({
      siteId: "site_1",
      sessionId: "ses_1",
      eventId: "evt_1",
      ...eventMeta(),
      runId: started.runId,
      type: "message.delta",
      payload: { delta: "hello" },
    })

    const readerClient = new MongoClient(MONGO_URL)
    const reader = new MongoSessionStore(readerClient, { dbName })
    try {
      expect(retry).toEqual(started)
      await expect(reader.getSession("site_1", "ses_1")).resolves.toMatchObject({
        siteId: "site_1",
        sessionId: "ses_1",
        ownerUserId: "user_1",
        activeRunId: started.runId,
      })
      await expect(reader.listMessages("site_1", "ses_1")).resolves.toMatchObject([
        { messageId: started.userMessageId, role: "user", content: "Build the runtime" },
        { messageId: started.assistantMessageId, role: "assistant", content: "" },
      ])
      await expect(reader.listRuns("site_1", "ses_1")).resolves.toMatchObject([
        {
          runId: started.runId,
          userMessageId: started.userMessageId,
          assistantMessageId: started.assistantMessageId,
          idempotencyKey: "idem_1",
        },
      ])
      await expect(reader.listEvents("site_1", "ses_1")).resolves.toMatchObject([
        { eventId: "evt_1", runId: started.runId, payload: { delta: "hello" } },
      ])
    } finally {
      await readerClient.close()
      await (client as MongoClient).db(dbName).dropDatabase()
    }
  })

  itOrSkip("active run admission is atomic under concurrent requests", async () => {
    const dbName = makeDbName("concurrent")
    const store = makeStore(client as MongoClient, dbName)
    try {
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          store.startRun({
            siteId: "site_1",
            sessionId: "ses_1",
            ownerUserId: "user_1",
            content: `Request ${index}`,
            idempotencyKey: `idem_${index}`,
          }),
        ),
      )

      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1)
      const rejected = attempts.filter((attempt) => attempt.status === "rejected")
      expect(rejected).toHaveLength(7)
      for (const attempt of rejected) {
        expect(attempt.reason).toBeInstanceOf(SessionRunActiveError)
      }
      await expect(store.listMessages("site_1", "ses_1")).resolves.toHaveLength(2)
      await expect(store.listRuns("site_1", "ses_1")).resolves.toHaveLength(1)
    } finally {
      await (client as MongoClient).db(dbName).dropDatabase()
    }
  })

  itOrSkip("eventId unique index deduplicates relay retry", async () => {
    const dbName = makeDbName("event_dedupe")
    const store = makeStore(client as MongoClient, dbName)
    try {
      const started = await store.startRun({
        siteId: "site_1",
        sessionId: "ses_1",
        ownerUserId: "user_1",
        content: "Hello",
        idempotencyKey: "idem_1",
      })

      await expect(
        store.appendEvent({
          siteId: "site_1",
          sessionId: "ses_1",
          eventId: "evt_retry",
          ...eventMeta(),
          runId: started.runId,
          type: "message.delta",
          payload: { delta: "one" },
        }),
      ).resolves.toEqual({ stored: true })
      await expect(
        store.appendEvent({
          siteId: "site_1",
          sessionId: "ses_1",
          eventId: "evt_retry",
          ...eventMeta(),
          runId: started.runId,
          type: "message.delta",
          payload: { delta: "two" },
        }),
      ).resolves.toEqual({ stored: false })
      await expect(store.listEvents("site_1", "ses_1")).resolves.toMatchObject([
        { eventId: "evt_retry", payload: { delta: "one" } },
      ])
    } finally {
      await (client as MongoClient).db(dbName).dropDatabase()
    }
  })

  itOrSkip("terminal event clears activeRunId atomically", async () => {
    const dbName = makeDbName("terminal")
    const store = makeStore(client as MongoClient, dbName)
    try {
      const started = await store.startRun({
        siteId: "site_1",
        sessionId: "ses_1",
        ownerUserId: "user_1",
        content: "Finish me",
        idempotencyKey: "idem_1",
      })

      await expect(
        store.appendEvent({
          siteId: "site_1",
          sessionId: "ses_1",
          eventId: "evt_done",
          ...eventMeta(),
          runId: started.runId,
          type: "run.completed",
          status: "completed",
        }),
      ).resolves.toEqual({ stored: true })
      await expect(store.getSession("site_1", "ses_1")).resolves.toMatchObject({
        activeRunId: null,
      })
      await expect(store.listRuns("site_1", "ses_1")).resolves.toMatchObject([
        { runId: started.runId, status: "completed" },
      ])
      await expect(
        store.startRun({
          siteId: "site_1",
          sessionId: "ses_1",
          ownerUserId: "user_1",
          content: "Second run",
          idempotencyKey: "idem_2",
        }),
      ).resolves.toMatchObject({ runId: "run_2" })
    } finally {
      await (client as MongoClient).db(dbName).dropDatabase()
    }
  })

  itOrSkip("siteId/sessionId/eventId scoping follows the memory contract", async () => {
    const dbName = makeDbName("scope")
    const store = makeStore(client as MongoClient, dbName)
    try {
      const siteOne = await store.startRun({
        siteId: "site_1",
        sessionId: "same_session",
        ownerUserId: "user_1",
        content: "Site one",
        idempotencyKey: "idem_shared",
      })
      const siteTwo = await store.startRun({
        siteId: "site_2",
        sessionId: "same_session",
        ownerUserId: "user_2",
        content: "Site two",
        idempotencyKey: "idem_shared",
      })

      expect(siteOne.runId).not.toBe(siteTwo.runId)
      await expect(
        store.appendEvent({
          siteId: "site_1",
          sessionId: "same_session",
          eventId: "evt_shared",
          ...eventMeta("same_session"),
          runId: siteOne.runId,
          type: "message.delta",
        }),
      ).resolves.toEqual({ stored: true })
      await expect(
        store.appendEvent({
          siteId: "site_2",
          sessionId: "same_session",
          eventId: "evt_shared",
          ...eventMeta("same_session"),
          runId: siteTwo.runId,
          type: "message.delta",
        }),
      ).resolves.toEqual({ stored: true })
      await expect(
        store.appendEvent({
          siteId: "site_1",
          sessionId: "same_session",
          eventId: "evt_wrong_terminal",
          ...eventMeta("same_session"),
          runId: siteTwo.runId,
          type: "run.completed",
          status: "completed",
        }),
      ).rejects.toBeInstanceOf(SessionRunNotActiveError)

      await expect(store.listEvents("site_1", "same_session")).resolves.toHaveLength(1)
      await expect(store.listEvents("site_2", "same_session")).resolves.toHaveLength(1)
      await expect(store.getSession("site_1", "same_session")).resolves.toMatchObject({
        ownerUserId: "user_1",
        activeRunId: siteOne.runId,
      })
      await expect(store.getSession("site_2", "same_session")).resolves.toMatchObject({
        ownerUserId: "user_2",
        activeRunId: siteTwo.runId,
      })
    } finally {
      await (client as MongoClient).db(dbName).dropDatabase()
    }
  })
})
