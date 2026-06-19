import { describe, expect, test } from "bun:test"

import { Normalizer } from "../src/application/normalize"
import {
  parseSessionEvent,
  type AguiPayload,
  type SessionEvent,
  type SessionEventName,
} from "../src/domain/session-event"

const BINDING = {
  sessionId: "ses_01",
  conversationId: "conv_01",
  runId: "run_x",
}

function makeNormalizer() {
  return new Normalizer(BINDING, {
    now: () => new Date("2026-05-30T00:00:00.000Z"),
  })
}

// Typed accessor: assert the envelope is the expected event, then return its
// schema-derived payload type — replaces inline `as {...}` casts (single source).
function payloadOf<E extends SessionEventName>(
  envelope: SessionEvent | undefined,
  event: E,
): AguiPayload<E> {
  expect(envelope?.event).toBe(event)
  return envelope?.payload as AguiPayload<E>
}

describe("Normalizer", () => {
  test("run.started emits protocol-complete session.created (first) + run.created", () => {
    const n = makeNormalizer()
    const out = n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })

    expect(out.map((e) => e.event)).toEqual(["session.created", "run.created"])
    // 合成的两条共享 run.started 的 seq。
    expect(out.map((e) => e.seq)).toEqual([0, 0])
    expect(out[0]?.payload).toMatchObject({
      session_id: "ses_01",
      conversation_id: "conv_01",
      owner_id: "kokoro-agent",
      title: "conv_01",
    })
    expect(out[1]?.payload).toMatchObject({ run_id: "run_x" })
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

  test("parseSessionEvent accepts run.created payloads", () => {
    expect(() =>
      parseSessionEvent({
        event: "run.created",
        event_id: "evt_0002",
        seq: 2,
        session_id: "ses_01",
        conversation_id: "conv_01",
        run_id: "run_x",
        timestamp: "2026-05-30T00:00:00.000Z",
        payload: { run_id: "run_x" },
      }),
    ).not.toThrow()
  })

  test("parseSessionEvent rejects session.created without title", () => {
    expect(() =>
      parseSessionEvent({
        event: "session.created",
        event_id: "evt_0001",
        seq: 1,
        session_id: "ses_01",
        conversation_id: "conv_01",
        run_id: "run_x",
        timestamp: "2026-05-30T00:00:00.000Z",
        payload: {
          session_id: "ses_01",
          conversation_id: "conv_01",
          owner_id: "kokoro-agent",
        },
      }),
    ).toThrow()
  })

  test("text.delta maps to message.delta passing the agent segment_id through", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const a = n.ingest({
      kind: "text.delta",
      run_id: "run_x",
      seq: 1,
      payload: { segment_id: "m1", text: "Hel" },
    })
    const b = n.ingest({
      kind: "text.delta",
      run_id: "run_x",
      seq: 2,
      payload: { segment_id: "m1", text: "lo" },
    })

    expect(a).toHaveLength(1)
    expect(a[0]?.event).toBe("message.delta")
    expect(a[0]?.payload).toMatchObject({ delta: "Hel", role: "assistant" })
    // session 透传 agent 分配的 segment_id，不再独立重映射。
    expect(a[0]?.payload.segment_id).toBe("m1")
    expect(b[0]?.payload.segment_id).toBe("m1")
    expect(b[0]?.payload).toMatchObject({ delta: "lo", role: "assistant" })
  })

  test("text.completed maps to message.completed with content + same segment_id", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const d = n.ingest({
      kind: "text.delta",
      run_id: "run_x",
      seq: 1,
      payload: { segment_id: "m1", text: "Hi" },
    })
    const c = n.ingest({
      kind: "text.completed",
      run_id: "run_x",
      seq: 2,
      payload: { segment_id: "m1", text: "Hi there" },
    })
    expect(c[0]?.event).toBe("message.completed")
    expect(c[0]?.payload).toMatchObject({ content: "Hi there", role: "assistant" })
    expect(c[0]?.payload.segment_id).toBe(d[0]?.payload.segment_id)
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

  test("seq is monotonic non-decreasing across the whole run", () => {
    const n = makeNormalizer()
    const all = [
      ...n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} }),
      ...n.ingest({ kind: "text.delta", run_id: "run_x", seq: 1, payload: { segment_id: "m1", text: "a" } }),
      ...n.ingest({ kind: "run.completed", run_id: "run_x", seq: 2, payload: { status: "completed" } }),
    ]
    // run.started 合成两条共享 seq 0；其后各事件透传自身 seq → 数组单调非降。
    const seqs = all.map((e) => e.seq)
    expect(seqs).toEqual([0, 0, 1, 2])
    const sorted = [...seqs].sort((a, b) => a - b)
    expect(seqs).toEqual(sorted)
  })

  test("envelope carries the agent event's seq as a first-class field", () => {
    const n = makeNormalizer()
    // run.started 合成 session.created + run.created 两条，共享 run.started 的 seq。
    const started = n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    expect(started.map((e) => e.seq)).toEqual([0, 0])
    // 后续事件各自透传 agent 的 seq（不再靠 cursor 末段反解）。
    const delta = n.ingest({
      kind: "text.delta",
      run_id: "run_x",
      seq: 7,
      payload: { segment_id: "m1", text: "hi" },
    })
    expect(delta[0]?.seq).toBe(7)
  })

  test("idempotent: same (run_id, seq) fed twice produces output only once", () => {
    const n = makeNormalizer()
    const first = n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const second = n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    expect(first).toHaveLength(2)
    expect(second).toEqual([])
  })

  test("terminal events are exempt from seq dedup so a reused seq cannot swallow the run's end", () => {
    const n = makeNormalizer()
    // 工具事件先用掉 seq 5；若 agent 复用 seq 5 发终态，普通去重会把它吞掉致 relay 永不收束。
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const tool = n.ingest({
      kind: "tool.invoked",
      run_id: "run_x",
      seq: 5,
      payload: { segment_id: "m1", tool_id: "t1", name: "now", args: {} },
    })
    expect(tool.map((e) => e.event)).toEqual(["tool.invoked"])
    const done = n.ingest({
      kind: "run.completed",
      run_id: "run_x",
      seq: 5,
      payload: { status: "completed" },
    })
    expect(done.map((e) => e.event)).toEqual(["run.completed"])
  })

  test("event_id derives from (run_id, seq, event) — replays and replicas produce identical envelopes", () => {
    const feed = (n: Normalizer) => [
      ...n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} }),
      ...n.ingest({ kind: "text.delta", run_id: "run_x", seq: 1, payload: { segment_id: "m1", text: "a" } }),
      ...n.ingest({ kind: "run.completed", run_id: "run_x", seq: 2, payload: { status: "completed" } }),
    ]
    const a = feed(makeNormalizer())
    const b = feed(makeNormalizer())

    // 多副本/重启重放同一 run 必须产出逐字节相同的 event_id，web 的 eventId 去重才能幂等吸收。
    expect(a.map((e) => e.event_id)).toEqual(b.map((e) => e.event_id))
    expect(a[0]?.event_id).toBe("evt_run_x_0_session.created")
    expect(a[1]?.event_id).toBe("evt_run_x_0_run.created")
    expect(a[2]?.event_id).toBe("evt_run_x_1_message.delta")
    expect(a[3]?.event_id).toBe("evt_run_x_2_run.completed")
    // 合成两条共享 seq 0，靠 event 名保持唯一。
    expect(new Set(a.map((e) => e.event_id)).size).toBe(a.length)
  })

  test("schema collapse: malformed agent event throws", () => {
    const n = makeNormalizer()
    expect(() =>
      n.ingest({ kind: "text.delta", run_id: "run_x", seq: 1, payload: { segment_id: "m1" } }),
    ).toThrow()
  })

  test("schema collapse: unknown kind throws", () => {
    const n = makeNormalizer()
    expect(() =>
      n.ingest({ kind: "bogus", run_id: "run_x", seq: 1, payload: {} }),
    ).toThrow()
  })

  // --- activity event families (thinking / tool / todo / subagent) ---

  test("tool.invoked maps to a tool.invoked envelope and parses clean", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "tool.invoked",
      run_id: "run_x",
      seq: 1,
      payload: {
        segment_id: "m1",
        tool_id: "t1",
        name: "get_weather",
        args: { city: "北京" },
      },
    })
    const invokedPayload = payloadOf(out[0], "tool.invoked")
    expect(typeof invokedPayload.segment_id).toBe("string")
    expect(invokedPayload.tool_id).toBe("t1")
    expect(invokedPayload.name).toBe("get_weather")
    expect(invokedPayload.args).toEqual({ city: "北京" })
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("tool.returned maps to a tool.returned envelope", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "tool.returned",
      run_id: "run_x",
      seq: 1,
      payload: {
        segment_id: "m1",
        tool_id: "t1",
        name: "get_weather",
        result: "北京: 晴",
        is_error: false,
      },
    })
    const returnedPayload = payloadOf(out[0], "tool.returned")
    expect(typeof returnedPayload.segment_id).toBe("string")
    expect(returnedPayload.tool_id).toBe("t1")
    expect(returnedPayload.name).toBe("get_weather")
    expect(returnedPayload.result).toBe("北京: 晴")
    expect(returnedPayload.is_error).toBe(false)
  })

  test("tool.returned carries is_error=true through for a failed tool", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "tool.returned",
      run_id: "run_x",
      seq: 1,
      payload: {
        segment_id: "m1",
        tool_id: "t1",
        name: "fetch_url",
        result: "connection refused",
        is_error: true,
      },
    })
    expect(payloadOf(out[0], "tool.returned").is_error).toBe(true)
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("tool.returned carries the HITL rejected flag through (replay-safe distinct visual)", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "tool.returned",
      run_id: "run_x",
      seq: 1,
      payload: {
        segment_id: "m1",
        tool_id: "t1",
        name: "fetch_url",
        result: "用户拒绝了工具 fetch_url 的调用。",
        is_error: false,
        rejected: true,
      },
    })
    expect(payloadOf(out[0], "tool.returned").rejected).toBe(true)
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("tool.returned without rejected omits the key (optional, absence = not rejected)", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "tool.returned",
      run_id: "run_x",
      seq: 1,
      payload: {
        segment_id: "m1",
        tool_id: "t1",
        name: "now",
        result: "2026-06-14",
        is_error: false,
      },
    })
    expect(payloadOf(out[0], "tool.returned").rejected).toBeUndefined()
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("todo.updated carries the ordered CC-style list through unchanged", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const todos = [
      { content: "查天气", status: "completed" },
      { content: "作答", status: "in_progress" },
    ]
    const out = n.ingest({ kind: "todo.updated", run_id: "run_x", seq: 1, payload: { todos } })
    expect(out[0]?.event).toBe("todo.updated")
    expect(out[0]?.payload.todos).toEqual(todos)
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("subagent lifecycle maps started + finished", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const started = n.ingest({
      kind: "subagent.started",
      run_id: "run_x",
      seq: 1,
      payload: {
        segment_id: "m1",
        subagent_id: "sa1",
        name: "researcher",
        description: "查资料",
        subagent_type: "researcher",
        source: "built-in",
      },
    })
    const finished = n.ingest({
      kind: "subagent.finished",
      run_id: "run_x",
      seq: 2,
      payload: {
        segment_id: "m1",
        subagent_id: "sa1",
        name: "researcher",
        subagent_type: "researcher",
        source: "built-in",
      },
    })
    const startedPayload = payloadOf(started[0], "subagent.started")
    expect(typeof startedPayload.segment_id).toBe("string")
    expect(startedPayload.subagent_id).toBe("sa1")
    expect(startedPayload.name).toBe("researcher")
    expect(startedPayload.description).toBe("查资料")
    expect(startedPayload.subagent_type).toBe("researcher")
    expect(startedPayload.source).toBe("built-in")
    const finishedPayload = payloadOf(finished[0], "subagent.finished")
    expect(typeof finishedPayload.segment_id).toBe("string")
    expect(finishedPayload.subagent_id).toBe("sa1")
    expect(finishedPayload.name).toBe("researcher")
    expect(finishedPayload.subagent_type).toBe("researcher")
    expect(finishedPayload.source).toBe("built-in")
  })

  test("subagent text maps to subagent text envelopes with segment_id + subagent_id", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "subagent.text.completed",
      run_id: "run_x",
      seq: 1,
      payload: { segment_id: "m1", subagent_id: "sa1", text: "子智能体结论" },
    })
    expect(out[0]?.event).toBe("subagent.text.completed")
    expect(out[0]?.payload).toMatchObject({ subagent_id: "sa1", text: "子智能体结论" })
    expect(typeof out[0]?.payload.segment_id).toBe("string")
  })

  test("thinking.delta maps to a thinking.delta envelope with a segment_id", () => {
    const n = makeNormalizer()
    n.ingest({ kind: "run.started", run_id: "run_x", seq: 0, payload: {} })
    const out = n.ingest({
      kind: "thinking.delta",
      run_id: "run_x",
      seq: 1,
      payload: { segment_id: "t1", text: "我在推理" },
    })
    expect(out[0]?.event).toBe("thinking.delta")
    expect(out[0]?.payload).toMatchObject({ delta: "我在推理" })
    expect(typeof out[0]?.payload.segment_id).toBe("string")
  })

  test("schema collapse: tool.invoked with an extra key throws", () => {
    const n = makeNormalizer()
    expect(() =>
      n.ingest({
        kind: "tool.invoked",
        run_id: "run_x",
        seq: 1,
        payload: { tool_id: "t", name: "x", args: {}, extra: 1 },
      }),
    ).toThrow()
  })

  test("schema collapse: todo.updated with an unknown status throws", () => {
    const n = makeNormalizer()
    expect(() =>
      n.ingest({
        kind: "todo.updated",
        run_id: "run_x",
        seq: 1,
        payload: { todos: [{ content: "x", status: "done" }] },
      }),
    ).toThrow()
  })

  test("schema collapse: tool.returned missing is_error throws (strict producer boundary)", () => {
    // 入站 strict + required：缺 is_error 的脏 tool.returned 必被拒，绝不归一化进 replay。
    const n = makeNormalizer()
    expect(() =>
      n.ingest({
        kind: "tool.returned",
        run_id: "run_x",
        seq: 1,
        payload: { segment_id: "m1", tool_id: "t1", name: "x", result: "ok" },
      }),
    ).toThrow()
  })
})
