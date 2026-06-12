import { describe, expect, test } from "bun:test"

import { Normalizer } from "../src/application/normalize"
import { relayRun, REQUESTS_STREAM, runEventsStream, startRun } from "../src/application/start-run"
import { runRequestSchema } from "../src/domain/run-request"
import { memoryReplayStore } from "../src/infrastructure/replay-store"
import { MemoryStreamPort } from "../src/infrastructure/stream-port"

describe("startRun", () => {
  test("generates a run id and publishes a valid run.request to the requests stream", async () => {
    const streamPort = new MemoryStreamPort()
    const { runId } = await startRun(
      {
        sessionId: "ses_01",
        conversationId: "conv_01",
        input: "hello kokoro",
        executionStyle: "fast",
      },
      { streamPort },
    )

    expect(runId).toMatch(/^run_/)

    const requests = await streamPort.readAll(REQUESTS_STREAM)
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
    const streamPort = new MemoryStreamPort()
    const { runId } = await startRun(
      { sessionId: "ses_02", input: "hi" },
      { streamPort },
    )
    const requests = await streamPort.readAll(REQUESTS_STREAM)
    const parsed = runRequestSchema.parse(requests.at(-1)?.event)
    expect(parsed.conversation_id).toBe("ses_02")
    expect(parsed.run_id).toBe(runId)
    expect(parsed.execution_style).toBeUndefined()
  })

  test("fails loud on an empty executionStyle instead of silently dropping it", async () => {
    const streamPort = new MemoryStreamPort()
    await expect(
      startRun({ sessionId: "ses_03", input: "hi", executionStyle: "" }, { streamPort }),
    ).rejects.toThrow()
  })

  test("each run gets a distinct run id", async () => {
    const streamPort = new MemoryStreamPort()
    const a = await startRun({ sessionId: "ses_03", input: "a" }, { streamPort })
    const b = await startRun({ sessionId: "ses_03", input: "b" }, { streamPort })
    expect(a.runId).not.toBe(b.runId)
  })
})

describe("relayRun", () => {
  test("normalizes agent events from the run stream into AGUI replay", async () => {
    const streamPort = new MemoryStreamPort()
    const replayStore = memoryReplayStore()
    const sessionId = "ses_10"
    const conversationId = "conv_10"
    const runId = "run_relay"

    // 预先把 agent 原始事件灌入该 run 的事件流。
    const stream = runEventsStream(runId)
    await streamPort.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await streamPort.publish(stream, {
      kind: "text.delta",
      run_id: runId,
      seq: 1,
      payload: { segment_id: "m1", text: "Hi" },
    })
    await streamPort.publish(stream, {
      kind: "text.completed",
      run_id: runId,
      seq: 2,
      payload: { segment_id: "m1", text: "Hi there" },
    })
    await streamPort.publish(stream, {
      kind: "run.completed",
      run_id: runId,
      seq: 3,
      payload: { status: "completed" },
    })
    const normalizer = new Normalizer(
      { sessionId, conversationId, runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )

    await relayRun({ streamPort, replayStore, normalizer, sessionId, runId })

    const events = replayStore.read(sessionId)
    expect(events.map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "message.delta",
      "message.completed",
      "run.completed",
    ])
    expect(events.every((e) => e.session_id === sessionId)).toBe(true)
  })

  test("relay stops at run.completed and is idempotent on duplicate seqs", async () => {
    const streamPort = new MemoryStreamPort()
    const replayStore = memoryReplayStore()
    const runId = "run_dup"
    const stream = runEventsStream(runId)
    await streamPort.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await streamPort.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await streamPort.publish(stream, { kind: "run.completed", run_id: runId, seq: 1, payload: { status: "completed" } })
    const normalizer = new Normalizer(
      { sessionId: "ses_dup", conversationId: "ses_dup", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ streamPort, replayStore, normalizer, sessionId: "ses_dup", runId })

    const events = replayStore.read("ses_dup")
    // 第二个重复 run.started(seq 0) 被去重；只剩 session.created/run.created/run.completed。
    expect(events.map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "run.completed",
    ])
  })

  test("a dirty event mid-stream is skipped and the terminal still lands (skip-and-continue)", async () => {
    const streamPort = new MemoryStreamPort()
    const replayStore = memoryReplayStore()
    const runId = "run_dirty_mid"
    const stream = runEventsStream(runId)
    await streamPort.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    // 中途混入未知 kind 的脏事件——不得撕掉整条中继,否则终态永不落 replay。
    await streamPort.publish(stream, { kind: "not.a.kind", run_id: runId, seq: 1, payload: {} })
    await streamPort.publish(stream, {
      kind: "text.completed",
      run_id: runId,
      seq: 2,
      payload: { segment_id: `${runId}:seg_0001`, text: "survived" },
    })
    await streamPort.publish(stream, {
      kind: "run.completed",
      run_id: runId,
      seq: 3,
      payload: { status: "completed" },
    })
    const normalizer = new Normalizer(
      { sessionId: "ses_dirty", conversationId: "ses_dirty", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ streamPort, replayStore, normalizer, sessionId: "ses_dirty", runId })

    expect(replayStore.read("ses_dirty").map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "message.completed",
      "run.completed",
    ])
  })

  test("relay terminates on run.failed", async () => {
    const streamPort = new MemoryStreamPort()
    const replayStore = memoryReplayStore()
    const runId = "run_fail"
    const stream = runEventsStream(runId)
    await streamPort.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await streamPort.publish(stream, {
      kind: "run.failed",
      run_id: runId,
      seq: 1,
      payload: { error_kind: "timeout", message: "boom" },
    })
    const normalizer = new Normalizer(
      { sessionId: "ses_fail", conversationId: "ses_fail", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ streamPort, replayStore, normalizer, sessionId: "ses_fail", runId })

    expect(replayStore.read("ses_fail").map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "run.failed",
    ])
  })
})
