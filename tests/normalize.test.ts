import { describe, expect, test } from "bun:test"

import { Normalizer } from "../src/application/normalize"
import { parseSessionEvent } from "../src/domain/events"

const BINDING = {
  sessionId: "ses_01",
  conversationId: "conv_01",
  runId: "run_x",
}

function makeNormalizer() {
  let n = 0
  return new Normalizer(BINDING, {
    newEventId: () => `evt_${String(++n).padStart(4, "0")}`,
    now: () => new Date("2026-05-30T00:00:00.000Z"),
  })
}

describe("Normalizer", () => {
  test("run.started emits session.created (first) + run.created with run-scoped cursors", () => {
    const n = makeNormalizer()
    const out = n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })

    expect(out.map((e) => e.event)).toEqual(["session.created", "run.created"])
    expect(out.map((e) => e.cursor)).toEqual(["run_x:0001", "run_x:0002"])
    for (const e of out) {
      expect(e.session_id).toBe("ses_01")
      expect(e.conversation_id).toBe("conv_01")
      expect(e.run_id).toBe("run_x")
      expect(e.timestamp).toBe("2026-05-30T00:00:00.000Z")
      // 每个出站信封都过 AGUI 解析器，必填字段齐全才不抛。
      expect(() => parseSessionEvent(e)).not.toThrow()
    }
    expect(new Set(out.map((e) => e.event_id)).size).toBe(2)
  })

  test("a second run.started does NOT re-emit session.created", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({ kind: "run.started", run_id: "run_x", seq: 1, payload: {} })
    expect(out.map((e) => e.event)).toEqual(["run.created"])
  })

  test("text.delta maps to message.delta with stable message_id per message_ref", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const a = n.ingest({
      kind: "text.delta",
      run_id: "run_x",
      seq: 1,
      payload: { message_ref: "m1", text: "Hel" },
    })
    const b = n.ingest({
      kind: "text.delta",
      run_id: "run_x",
      seq: 2,
      payload: { message_ref: "m1", text: "lo" },
    })

    expect(a).toHaveLength(1)
    expect(a[0]?.event).toBe("message.delta")
    expect(a[0]?.payload).toMatchObject({ delta: "Hel", role: "assistant" })
    const mid = a[0]?.payload.message_id
    expect(typeof mid).toBe("string")
    // 同一 message_ref → 稳定 message_id。
    expect(b[0]?.payload.message_id).toBe(mid)
    expect(b[0]?.payload).toMatchObject({ delta: "lo", role: "assistant" })
  })

  test("text.completed maps to message.completed with content + same message_id", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const d = n.ingest({
      kind: "text.delta",
      run_id: "run_x",
      seq: 1,
      payload: { message_ref: "m1", text: "Hi" },
    })
    const c = n.ingest({
      kind: "text.completed",
      run_id: "run_x",
      seq: 2,
      payload: { message_ref: "m1", text: "Hi there" },
    })
    expect(c[0]?.event).toBe("message.completed")
    expect(c[0]?.payload).toMatchObject({ content: "Hi there", role: "assistant" })
    expect(c[0]?.payload.message_id).toBe(d[0]?.payload.message_id)
  })

  test("run.completed maps to run.completed envelope with status", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "run.completed",
      run_id: "run_x",
      seq: 1,
      payload: { status: "completed" },
    })
    expect(out[0]?.event).toBe("run.completed")
    expect(out[0]?.payload).toMatchObject({ run_id: "run_x", status: "completed" })
  })

  test("run.failed maps to run.failed envelope", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "run.failed",
      run_id: "run_x",
      seq: 1,
      payload: { error_kind: "timeout", message: "boom" },
    })
    expect(out[0]?.event).toBe("run.failed")
    expect(out[0]?.payload).toMatchObject({ error_kind: "timeout", message: "boom" })
  })

  test("cursors are strictly monotonic across the whole run", () => {
    const n = makeNormalizer()
    const all = [
      ...n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} }),
      ...n.ingest({ kind: "text.delta", run_id: "run_x", seq: 1, payload: { message_ref: "m1", text: "a" } }),
      ...n.ingest({ kind: "run.completed", run_id: "run_x", seq: 2, payload: { status: "completed" } }),
    ]
    const cursors = all.map((e) => e.cursor)
    const sorted = [...cursors].sort()
    expect(cursors).toEqual(sorted)
    expect(new Set(cursors).size).toBe(cursors.length)
  })

  test("idempotent: same (run_id, seq) fed twice produces output only once", () => {
    const n = makeNormalizer()
    const first = n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const second = n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    expect(first).toHaveLength(2)
    expect(second).toEqual([])
  })

  test("schema collapse: malformed agent event throws", () => {
    const n = makeNormalizer()
    expect(() =>
      n.ingest({ kind: "text.delta", run_id: "run_x", seq: 1, payload: { message_ref: "m1" } }),
    ).toThrow()
  })

  test("schema collapse: unknown kind throws", () => {
    const n = makeNormalizer()
    expect(() =>
      n.ingest({ kind: "bogus", run_id: "run_x", seq: 1, payload: {} }),
    ).toThrow()
  })
})
