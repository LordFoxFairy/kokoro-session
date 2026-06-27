import { describe, expect, test } from "bun:test"

import { Normalizer } from "../src/application/normalize"
import { relayRun } from "../src/application/relay-run"
import { startRun } from "../src/application/start-run"
import { REQUESTS_STREAM, runEventsStream } from "../src/application/stream-names"
import { parseSessionEvent, type SessionEvent } from "../src/domain/session-event"
import { runRequestSchema } from "../src/domain/run-request"
import { MemoryMessageStore } from "../src/infrastructure/message-store"
import { MemoryStream } from "../src/infrastructure/stream"

// relayRun 把归一化信封持久到 MessageStore（长期真源）；从中回读还原已落库的会话事件。
async function readReplay(
  store: MemoryMessageStore,
  sessionId: string,
): Promise<SessionEvent[]> {
  return (await store.read(sessionId)).map((stored) => parseSessionEvent(stored.event))
}

describe("startRun", () => {
  test("generates a run id and publishes a valid run.request to the requests stream", async () => {
    const bus = new MemoryStream()
    const { runId } = await startRun(
      {
        sessionId: "ses_01",
        conversationId: "conv_01",
        input: "hello kokoro",
        executionStyle: "fast",
      },
      { bus },
    )

    expect(runId).toMatch(/^run_/)

    const requests = await bus.readAll(REQUESTS_STREAM)
    expect(requests).toHaveLength(1)
    // 写出的 run.request 必须通过严格 schema（合法信封，不带多余键）。
    const parsed = runRequestSchema.parse(requests[0]?.event)
    expect(parsed).toMatchObject({
      kind: "run.request",
      run_id: runId,
      session_id: "ses_01",
      conversation_id: "conv_01",
      input: "hello kokoro",
      execution_style: "fast",
    })
  })

  test("defaults conversation_id to session_id when omitted", async () => {
    const bus = new MemoryStream()
    const { runId } = await startRun(
      { sessionId: "ses_02", input: "hi" },
      { bus },
    )
    const requests = await bus.readAll(REQUESTS_STREAM)
    const parsed = runRequestSchema.parse(requests.at(-1)?.event)
    expect(parsed.conversation_id).toBe("ses_02")
    expect(parsed.run_id).toBe(runId)
    expect(parsed.execution_style).toBeUndefined()
  })

  test("fails loud on an empty executionStyle instead of silently dropping it", async () => {
    const bus = new MemoryStream()
    await expect(
      startRun({ sessionId: "ses_03", input: "hi", executionStyle: "" }, { bus }),
    ).rejects.toThrow()
  })

  test("each run gets a distinct run id", async () => {
    const bus = new MemoryStream()
    const a = await startRun({ sessionId: "ses_03", input: "a" }, { bus })
    const b = await startRun({ sessionId: "ses_03", input: "b" }, { bus })
    expect(a.runId).not.toBe(b.runId)
  })
})

describe("relayRun", () => {
  test("normalizes agent events from the run stream into AGUI replay", async () => {
    const bus = new MemoryStream()
    const messageStore = new MemoryMessageStore()
    const sessionId = "ses_10"
    const conversationId = "conv_10"
    const runId = "run_relay"

    // 预先把 agent canonical wire 事件灌入该 run 的事件流。
    const env = { request_id: runId, timestamp: 1700000000 }
    const stream = runEventsStream(runId)
    await bus.publish(stream, { event: "agent_status", ...env, data: { status: "started" } })
    await bus.publish(stream, {
      event: "text_chunk",
      ...env,
      data: { segment_id: "m1", text: "Hi", final: false },
    })
    await bus.publish(stream, {
      event: "text_chunk",
      ...env,
      data: { segment_id: "m1", text: "Hi there", final: true },
    })
    await bus.publish(stream, {
      event: "agent_done",
      ...env,
      data: { status: "completed", usage: {} },
    })
    const normalizer = new Normalizer(
      { sessionId, conversationId, runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )

    await relayRun({ bus, messageStore, normalizer, sessionId, runId })

    const events = await readReplay(messageStore, sessionId)
    expect(events.map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "message.delta",
      "message.completed",
      "run.completed",
    ])
    expect(events.every((e) => e.session_id === sessionId)).toBe(true)
  })

  test("relay stops at terminal; session.created is synthesized only once across started events", async () => {
    const bus = new MemoryStream()
    const messageStore = new MemoryMessageStore()
    const runId = "run_dup"
    const env = { request_id: runId, timestamp: 1700000000 }
    const stream = runEventsStream(runId)
    // 两条 started 落在不同 cursor（非同一条目重放）→ 不算重复；但 session.created 只合成一次。
    await bus.publish(stream, { event: "agent_status", ...env, data: { status: "started" } })
    await bus.publish(stream, { event: "agent_status", ...env, data: { status: "started" } })
    await bus.publish(stream, { event: "agent_done", ...env, data: { status: "completed", usage: {} } })
    const normalizer = new Normalizer(
      { sessionId: "ses_dup", conversationId: "ses_dup", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ bus, messageStore, normalizer, sessionId: "ses_dup", runId })

    const events = await readReplay(messageStore, "ses_dup")
    expect(events.map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "run.created",
      "run.completed",
    ])
  })

  test("a dirty event mid-stream is skipped and the terminal still lands (skip-and-continue)", async () => {
    const bus = new MemoryStream()
    const messageStore = new MemoryMessageStore()
    const runId = "run_dirty_mid"
    const env = { request_id: runId, timestamp: 1700000000 }
    const stream = runEventsStream(runId)
    await bus.publish(stream, { event: "agent_status", ...env, data: { status: "started" } })
    // 中途混入未知 event 的脏事件——不得撕掉整条中继,否则终态永不落 replay。
    await bus.publish(stream, { event: "not_an_event", ...env, data: {} })
    await bus.publish(stream, {
      event: "text_chunk",
      ...env,
      data: { segment_id: `${runId}:seg_0001`, text: "survived", final: true },
    })
    await bus.publish(stream, {
      event: "agent_done",
      ...env,
      data: { status: "completed", usage: {} },
    })
    const normalizer = new Normalizer(
      { sessionId: "ses_dirty", conversationId: "ses_dirty", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ bus, messageStore, normalizer, sessionId: "ses_dirty", runId })

    expect((await readReplay(messageStore, "ses_dirty")).map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "message.completed",
      "run.completed",
    ])
  })

  test("relay terminates on run.failed", async () => {
    const bus = new MemoryStream()
    const messageStore = new MemoryMessageStore()
    const runId = "run_fail"
    const env = { request_id: runId, timestamp: 1700000000 }
    const stream = runEventsStream(runId)
    await bus.publish(stream, { event: "agent_status", ...env, data: { status: "started" } })
    await bus.publish(stream, {
      event: "agent_error",
      ...env,
      data: { error_kind: "timeout", message: "boom" },
    })
    const normalizer = new Normalizer(
      { sessionId: "ses_fail", conversationId: "ses_fail", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ bus, messageStore, normalizer, sessionId: "ses_fail", runId })

    expect((await readReplay(messageStore, "ses_fail")).map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "run.failed",
    ])
  })
})
