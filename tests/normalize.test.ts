import { describe, expect, it, test } from "bun:test"

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

function clock() {
  return { newEventId: () => "evt", now: () => new Date("2026-05-31T00:00:00Z") }
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

  test("tool.invoked → tool.started with stable tool_call_id; tool.returned → tool.completed reusing it", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const started = n.ingest({
      kind: "tool.invoked",
      run_id: "run_x",
      seq: 1,
      payload: { tool_call_ref: "tc1", tool_name: "echo_search" },
    })
    const completed = n.ingest({
      kind: "tool.returned",
      run_id: "run_x",
      seq: 2,
      payload: { tool_call_ref: "tc1", tool_name: "echo_search", status: "ok" },
    })

    expect(started).toHaveLength(1)
    expect(started[0]?.event).toBe("tool.started")
    expect(started[0]?.payload).toMatchObject({ tool_name: "echo_search" })
    const tcid = started[0]?.payload.tool_call_id
    expect(typeof tcid).toBe("string")

    expect(completed).toHaveLength(1)
    expect(completed[0]?.event).toBe("tool.completed")
    expect(completed[0]?.payload).toMatchObject({
      tool_call_id: tcid,
      tool_name: "echo_search",
      status: "ok",
    })
    for (const e of [...started, ...completed]) {
      expect(() => parseSessionEvent(e)).not.toThrow()
    }
  })

  test("tool.returned with no matching tool.invoked is ignored (logged), does not crash", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "tool.returned",
      run_id: "run_x",
      seq: 1,
      payload: { tool_call_ref: "ghost", tool_name: "echo_search", status: "ok" },
    })
    expect(out).toEqual([])
  })

  test("thinking deltas accumulate into ONE thinking.summary at run.completed", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const d1 = n.ingest({ kind: "thinking.delta", run_id: "run_x", seq: 1, payload: { text: "step a " } })
    const d2 = n.ingest({ kind: "thinking.delta", run_id: "run_x", seq: 2, payload: { text: "step b" } })
    // 原始思考增量本身不外泄成出站事件。
    expect(d1).toEqual([])
    expect(d2).toEqual([])

    const done = n.ingest({ kind: "run.completed", run_id: "run_x", seq: 3, payload: { status: "completed" } })
    const summaries = done.filter((e) => e.event === "thinking.summary")
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.payload).toMatchObject({ run_id: "run_x", summary: "step a step b" })
    // summary 在 run.completed 之前（思考块先于收尾）。
    expect(done.map((e) => e.event)).toEqual(["thinking.summary", "run.completed"])
    for (const e of done) expect(() => parseSessionEvent(e)).not.toThrow()
  })

  test("thinking.summary flushes on first non-thinking event after thinking (before text)", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    n.ingest({ kind: "thinking.delta", run_id: "run_x", seq: 1, payload: { text: "reasoning" } })
    const out = n.ingest({
      kind: "text.delta",
      run_id: "run_x",
      seq: 2,
      payload: { message_ref: "m1", text: "Answer" },
    })
    expect(out.map((e) => e.event)).toEqual(["thinking.summary", "message.delta"])
    const summary = out.find((e) => e.event === "thinking.summary")
    expect(summary?.payload).toMatchObject({ summary: "reasoning" })
  })

  test("thinking.summary emitted at most once per run", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    n.ingest({ kind: "thinking.delta", run_id: "run_x", seq: 1, payload: { text: "x" } })
    const t1 = n.ingest({ kind: "text.delta", run_id: "run_x", seq: 2, payload: { message_ref: "m1", text: "A" } })
    const t2 = n.ingest({ kind: "text.delta", run_id: "run_x", seq: 3, payload: { message_ref: "m1", text: "B" } })
    const done = n.ingest({ kind: "run.completed", run_id: "run_x", seq: 4, payload: { status: "completed" } })
    expect(t1.filter((e) => e.event === "thinking.summary")).toHaveLength(1)
    expect(t2.filter((e) => e.event === "thinking.summary")).toHaveLength(0)
    expect(done.filter((e) => e.event === "thinking.summary")).toHaveLength(0)
  })

  test("no thinking deltas → no thinking.summary at run.completed", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const done = n.ingest({ kind: "run.completed", run_id: "run_x", seq: 1, payload: { status: "completed" } })
    expect(done.map((e) => e.event)).toEqual(["run.completed"])
  })

  test("idempotent: repeated tool.invoked (same seq) does not double-emit or remap id", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const a = n.ingest({ kind: "tool.invoked", run_id: "run_x", seq: 1, payload: { tool_call_ref: "tc1", tool_name: "t" } })
    const b = n.ingest({ kind: "tool.invoked", run_id: "run_x", seq: 1, payload: { tool_call_ref: "tc1", tool_name: "t" } })
    expect(a).toHaveLength(1)
    expect(b).toEqual([])
  })
})

describe("Normalizer — write_todos harness recognition", () => {
  it("recognizes write_todos tool.invoked as an internal plan.updated (suppressing tool card)", () => {
    const norm = new Normalizer({ sessionId: "s", conversationId: "c", runId: "run_1" }, clock())
    norm.ingest({ kind: "run.started", run_id: "run_1", seq: 1, payload: {} })
    const out = norm.ingest({ kind: "tool.invoked", run_id: "run_1", seq: 2, payload: { tool_call_ref: "wt1", tool_name: "write_todos", args: { todos: [{ content: "a", status: "pending" }] } } })
    const plan = out.find((e) => e.event === "plan.updated")
    expect(plan).toBeDefined()
    expect(plan!.payload.plan_id).toBe("run_1:plan")
    expect((plan!.payload.todos as unknown[]).length).toBe(1)
    // 不产 tool.started
    expect(out.some((e) => e.event === "tool.started")).toBe(false)
    // 其对应 tool.returned 被吞
    const ret = norm.ingest({ kind: "tool.returned", run_id: "run_1", seq: 3, payload: { tool_call_ref: "wt1", tool_name: "write_todos", status: "ok" } })
    expect(ret).toEqual([])
  })

  it("keeps non-write_todos tools as normal tool.started/completed", () => {
    const norm = new Normalizer({ sessionId: "s", conversationId: "c", runId: "run_1" }, clock())
    norm.ingest({ kind: "run.started", run_id: "run_1", seq: 1, payload: {} })
    const inv = norm.ingest({ kind: "tool.invoked", run_id: "run_1", seq: 2, payload: { tool_call_ref: "es1", tool_name: "echo_search", args: { query: "x" } } })
    expect(inv.some((e) => e.event === "tool.started")).toBe(true)
  })

  it("write_todos with NO args field → plan.updated with empty todos (?? {} fallback)", () => {
    const norm = new Normalizer({ sessionId: "s", conversationId: "c", runId: "run_1" }, clock())
    norm.ingest({ kind: "run.started", run_id: "run_1", seq: 1, payload: {} })
    const out = norm.ingest({ kind: "tool.invoked", run_id: "run_1", seq: 2, payload: { tool_call_ref: "wt1", tool_name: "write_todos" } })
    const plan = out.find((e) => e.event === "plan.updated")
    expect(plan).toBeDefined()
    expect(plan!.payload.plan_id).toBe("run_1:plan")
    expect(plan!.payload.todos).toEqual([])
    expect(out.some((e) => e.event === "tool.started")).toBe(false)
  })
})
