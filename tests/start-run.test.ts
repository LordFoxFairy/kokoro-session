import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { Normalizer } from "../src/application/normalize"
import {
  controlStream,
  relayRun,
  REQUESTS_STREAM,
  runEventsStream,
  startRun,
} from "../src/application/start-run"
import { parseSessionEvent, type SessionEvent } from "../src/domain/session-event"
import { runRequestSchema } from "../src/domain/run-request"
import { makeReplayStore, replayStream } from "../src/infrastructure/replay-store"
import { MemoryStream } from "../src/infrastructure/stream"

// relayRun 把归一化信封 append 到 replayStream(sessionId)；从该 bus 流回读还原已落盘的 replay。
async function readReplay(bus: MemoryStream, sessionId: string): Promise<SessionEvent[]> {
  const items = await bus.readAll(replayStream(sessionId))
  return items.map((item) => parseSessionEvent(item.event))
}

// Local schema mirroring the HITL control envelope (approve/reject针对待批工具, cancel放弃整个 run).
// 待 SE-3 的 src/domain/run-control.ts 合并后可切换为复用,届时删除此内联 schema。
const controlEventSchema = z
  .object({
    kind: z.literal("control"),
    decision: z.enum(["approve", "reject", "cancel"]),
  })
  .strict()

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
    const replayStore = makeReplayStore(bus)
    const sessionId = "ses_10"
    const conversationId = "conv_10"
    const runId = "run_relay"

    // 预先把 agent 原始事件灌入该 run 的事件流。
    const stream = runEventsStream(runId)
    await bus.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await bus.publish(stream, {
      kind: "text.delta",
      run_id: runId,
      seq: 1,
      payload: { segment_id: "m1", text: "Hi" },
    })
    await bus.publish(stream, {
      kind: "text.completed",
      run_id: runId,
      seq: 2,
      payload: { segment_id: "m1", text: "Hi there" },
    })
    await bus.publish(stream, {
      kind: "run.completed",
      run_id: runId,
      seq: 3,
      payload: { status: "completed" },
    })
    const normalizer = new Normalizer(
      { sessionId, conversationId, runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )

    await relayRun({ bus, replayStore, normalizer, sessionId, runId })

    const events = await readReplay(bus, sessionId)
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
    const bus = new MemoryStream()
    const replayStore = makeReplayStore(bus)
    const runId = "run_dup"
    const stream = runEventsStream(runId)
    await bus.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await bus.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await bus.publish(stream, { kind: "run.completed", run_id: runId, seq: 1, payload: { status: "completed" } })
    const normalizer = new Normalizer(
      { sessionId: "ses_dup", conversationId: "ses_dup", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ bus, replayStore, normalizer, sessionId: "ses_dup", runId })

    const events = await readReplay(bus, "ses_dup")
    // 第二个重复 run.started(seq 0) 被去重；只剩 session.created/run.created/run.completed。
    expect(events.map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "run.completed",
    ])
  })

  test("a dirty event mid-stream is skipped and the terminal still lands (skip-and-continue)", async () => {
    const bus = new MemoryStream()
    const replayStore = makeReplayStore(bus)
    const runId = "run_dirty_mid"
    const stream = runEventsStream(runId)
    await bus.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    // 中途混入未知 kind 的脏事件——不得撕掉整条中继,否则终态永不落 replay。
    await bus.publish(stream, { kind: "not.a.kind", run_id: runId, seq: 1, payload: {} })
    await bus.publish(stream, {
      kind: "text.completed",
      run_id: runId,
      seq: 2,
      payload: { segment_id: `${runId}:seg_0001`, text: "survived" },
    })
    await bus.publish(stream, {
      kind: "run.completed",
      run_id: runId,
      seq: 3,
      payload: { status: "completed" },
    })
    const normalizer = new Normalizer(
      { sessionId: "ses_dirty", conversationId: "ses_dirty", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ bus, replayStore, normalizer, sessionId: "ses_dirty", runId })

    expect((await readReplay(bus, "ses_dirty")).map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "message.completed",
      "run.completed",
    ])
  })

  test("relay terminates on run.failed", async () => {
    const bus = new MemoryStream()
    const replayStore = makeReplayStore(bus)
    const runId = "run_fail"
    const stream = runEventsStream(runId)
    await bus.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await bus.publish(stream, {
      kind: "run.failed",
      run_id: runId,
      seq: 1,
      payload: { error_kind: "timeout", message: "boom" },
    })
    const normalizer = new Normalizer(
      { sessionId: "ses_fail", conversationId: "ses_fail", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ bus, replayStore, normalizer, sessionId: "ses_fail", runId })

    expect((await readReplay(bus, "ses_fail")).map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "run.failed",
    ])
  })

  test("deletes the control stream on terminal so HITL decisions do not linger", async () => {
    const bus = new MemoryStream()
    const replayStore = makeReplayStore(bus)
    const runId = "run_ctrl_cleanup"
    const stream = runEventsStream(runId)
    // 模拟一条遗留的审批指令还挂在控制流上;先过 schema 确保构造的是合法 control 信封。
    const lingering = controlEventSchema.parse({ kind: "control", decision: "approve" })
    await bus.publish(controlStream(runId), lingering)
    await bus.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await bus.publish(stream, {
      kind: "run.completed",
      run_id: runId,
      seq: 1,
      payload: { status: "completed" },
    })
    const normalizer = new Normalizer(
      { sessionId: "ses_ctrl", conversationId: "ses_ctrl", runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ bus, replayStore, normalizer, sessionId: "ses_ctrl", runId })

    expect(await bus.readAll(controlStream(runId))).toEqual([])
  })
})

// 待 SE-3 的 run-control schema 合并后,这些断言可切换为复用 src/domain/run-control.ts。
describe("control envelope", () => {
  test.each(["approve", "reject", "cancel"] as const)(
    "accepts the %s decision",
    (decision) => {
      const parsed = controlEventSchema.parse({ kind: "control", decision })
      expect(parsed).toEqual({ kind: "control", decision })
    },
  )

  test("rejects an unknown decision (fails loud, not silently relayed)", () => {
    expect(() =>
      controlEventSchema.parse({ kind: "control", decision: "nuke" }),
    ).toThrow()
  })

  test("rejects extra keys on the control envelope (strict boundary)", () => {
    expect(() =>
      controlEventSchema.parse({ kind: "control", decision: "approve", extra: 1 }),
    ).toThrow()
  })
})
