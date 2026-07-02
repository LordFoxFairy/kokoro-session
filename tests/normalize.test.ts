import { describe, expect, test } from "vitest"

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

// transport cursor 是定宽零填充数字串；helper 把整数渲染成同样形态，seq 由 Number(cursor) 反解。
const CURSOR_WIDTH = 20
function cursor(n: number): string {
  return String(n).padStart(CURSOR_WIDTH, "0")
}

const ENV = { request_id: "run_x", timestamp: 1700000000 }

// 自增 cursor 的 ingest 封装：模拟 transport 单调游标，免去逐条手填。
function makeFeeder(n: Normalizer) {
  let next = 0
  return {
    feed(raw: unknown): SessionEvent[] {
      return n.ingest(raw, cursor(next++))
    },
    at(raw: unknown, c: number): SessionEvent[] {
      return n.ingest(raw, cursor(c))
    },
  }
}

const started = { event: "agent_status", ...ENV, data: { status: "started" } }

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
  test("agent_status started emits protocol-complete session.created (first) + run.created", () => {
    const f = makeFeeder(makeNormalizer())
    const out = f.feed(started)

    expect(out.map((e) => e.event)).toEqual(["session.created", "run.created"])
    // 合成的两条共享同一 cursor 派生的 seq 0。
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
      expect(() => parseSessionEvent(e)).not.toThrow()
    }
    expect(new Set(out.map((e) => e.event_id)).size).toBe(2)
  })

  test("a second started does NOT re-emit session.created", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const out = f.feed(started)
    expect(out.map((e) => e.event)).toEqual(["run.created"])
  })

  test("text_chunk (no subagent, final=false) maps to message.delta passing segment_id through", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const a = f.feed({
      event: "text_chunk",
      ...ENV,
      data: { segment_id: "m1", text: "Hel", final: false },
    })
    const b = f.feed({
      event: "text_chunk",
      ...ENV,
      data: { segment_id: "m1", text: "lo", final: false },
    })

    expect(a).toHaveLength(1)
    expect(a[0]?.event).toBe("message.delta")
    expect(a[0]?.payload).toMatchObject({ delta: "Hel", role: "assistant" })
    expect(a[0]?.payload.segment_id).toBe("m1")
    expect(b[0]?.payload.segment_id).toBe("m1")
    expect(b[0]?.payload).toMatchObject({ delta: "lo", role: "assistant" })
  })

  test("text_chunk (no subagent, final=true) maps to message.completed with content", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const c = f.feed({
      event: "text_chunk",
      ...ENV,
      data: { segment_id: "m1", text: "Hi there", final: true },
    })
    expect(c[0]?.event).toBe("message.completed")
    expect(c[0]?.payload).toMatchObject({ content: "Hi there", role: "assistant" })
    expect(c[0]?.payload.segment_id).toBe("m1")
  })

  test("agent_done maps to run.completed envelope with status", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const out = f.feed({
      event: "agent_done",
      ...ENV,
      data: { status: "completed", usage: {} },
    })
    expect(out[0]?.event).toBe("run.completed")
    expect(out[0]?.payload).toMatchObject({ run_id: "run_x", status: "completed" })
  })

  test("agent_error maps to run.failed envelope", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const out = f.feed({
      event: "agent_error",
      ...ENV,
      data: { error_kind: "timeout", message: "boom" },
    })
    expect(out[0]?.event).toBe("run.failed")
    expect(out[0]?.payload).toMatchObject({ error_kind: "timeout", message: "boom" })
  })

  test("seq derives from transport cursor and is monotonic non-decreasing across the run", () => {
    const f = makeFeeder(makeNormalizer())
    const all = [
      ...f.feed(started),
      ...f.feed({ event: "text_chunk", ...ENV, data: { segment_id: "m1", text: "a", final: false } }),
      ...f.feed({ event: "agent_done", ...ENV, data: { status: "completed", usage: {} } }),
    ]
    // started 合成两条共享 cursor 0 → seq 0；其后 cursor 1/2 → seq 1/2，数组单调非降。
    const seqs = all.map((e) => e.seq)
    expect(seqs).toEqual([0, 0, 1, 2])
    const sorted = [...seqs].sort((a, b) => a - b)
    expect(seqs).toEqual(sorted)
  })

  // 回归：真 RedisStream 游标是 `<ms>-<seq>`（非定宽数字串）。此前所有用例都用 MemoryStream 形态
  // 的数字游标，漏掉这一格——Number("1782540325240-0")=NaN 会让每条事件被当脏事件丢弃、redis 后端
  // SSE 全断（真·跨进程 e2e 抓出）。seq 取 `-` 前首段（毫秒，单调可序）；全串仍作去重/event_id。
  test("derives a finite seq from a real Redis stream cursor `<ms>-<seq>` (MemoryStream-only blind spot)", () => {
    const out = makeNormalizer().ingest(started, "1782540325240-0")
    expect(out.length).toBeGreaterThan(0)
    expect(out.every((e) => Number.isFinite(e.seq))).toBe(true)
    expect(out[0]?.seq).toBe(1782540325240)
  })

  test("cursor-derived seq is carried as a first-class field", () => {
    const f = makeFeeder(makeNormalizer())
    const out = f.at(started, 0)
    expect(out.map((e) => e.seq)).toEqual([0, 0])
    const delta = f.at(
      { event: "text_chunk", ...ENV, data: { segment_id: "m1", text: "hi", final: false } },
      7,
    )
    expect(delta[0]?.seq).toBe(7)
  })

  test("idempotent: same cursor fed twice produces output only once (cursor dedup)", () => {
    const f = makeFeeder(makeNormalizer())
    const first = f.at(started, 0)
    const second = f.at(started, 0)
    expect(first).toHaveLength(2)
    expect(second).toEqual([])
  })

  test("terminal events are exempt from cursor dedup so a reused cursor cannot swallow the run's end", () => {
    const f = makeFeeder(makeNormalizer())
    f.at(started, 0)
    // 工具事件先用掉 cursor 5；若同一 cursor 复用发终态，普通去重会把它吞掉致 relay 永不收束。
    const tool = f.at(
      { event: "tool_call_start", ...ENV, data: { segment_id: "m1", tool_id: "t1", name: "now", args: {} } },
      5,
    )
    expect(tool.map((e) => e.event)).toEqual(["tool.invoked"])
    const done = f.at(
      { event: "agent_done", ...ENV, data: { status: "completed", usage: {} } },
      5,
    )
    expect(done.map((e) => e.event)).toEqual(["run.completed"])
  })

  test("event_id derives from (request_id, cursor, event) — replays and replicas produce identical envelopes", () => {
    const feed = (n: Normalizer) => {
      const f = makeFeeder(n)
      return [
        ...f.feed(started),
        ...f.feed({ event: "text_chunk", ...ENV, data: { segment_id: "m1", text: "a", final: false } }),
        ...f.feed({ event: "agent_done", ...ENV, data: { status: "completed", usage: {} } }),
      ]
    }
    const a = feed(makeNormalizer())
    const b = feed(makeNormalizer())

    expect(a.map((e) => e.event_id)).toEqual(b.map((e) => e.event_id))
    expect(a[0]?.event_id).toBe(`evt_run_x_${cursor(0)}_session.created`)
    expect(a[1]?.event_id).toBe(`evt_run_x_${cursor(0)}_run.created`)
    expect(a[2]?.event_id).toBe(`evt_run_x_${cursor(1)}_message.delta`)
    expect(a[3]?.event_id).toBe(`evt_run_x_${cursor(2)}_run.completed`)
    // 合成两条共享 cursor 0，靠 event 名保持唯一。
    expect(new Set(a.map((e) => e.event_id)).size).toBe(a.length)
  })

  test("schema collapse: malformed agent event throws", () => {
    const f = makeFeeder(makeNormalizer())
    expect(() =>
      f.feed({ event: "text_chunk", ...ENV, data: { segment_id: "m1" } }),
    ).toThrow()
  })

  test("schema collapse: unknown event throws", () => {
    const f = makeFeeder(makeNormalizer())
    expect(() => f.feed({ event: "bogus", ...ENV, data: {} })).toThrow()
  })

  // --- channel separation: text vs reasoning, subagent routing ---

  test("reasoning_chunk delta (final=false) maps to thinking.delta; final=true is dropped", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const delta = f.feed({
      event: "reasoning_chunk",
      ...ENV,
      data: { segment_id: "t1", text: "我在推理", final: false },
    })
    expect(delta[0]?.event).toBe("thinking.delta")
    expect(delta[0]?.payload).toMatchObject({ delta: "我在推理" })
    expect(typeof delta[0]?.payload.segment_id).toBe("string")

    // reasoning 终态帧多余（web thinking 纯续写）→ 丢弃。
    const final = f.feed({
      event: "reasoning_chunk",
      ...ENV,
      data: { segment_id: "t1", text: "推理完", final: true },
    })
    expect(final).toEqual([])
  })

  test("text_chunk with subagent_id routes to subagent text channel (delta + completed)", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const delta = f.feed({
      event: "text_chunk",
      ...ENV,
      data: { segment_id: "m1", text: "子部分", final: false, subagent_id: "sa1" },
    })
    expect(delta[0]?.event).toBe("subagent.text.delta")
    expect(delta[0]?.payload).toMatchObject({ subagent_id: "sa1", text: "子部分" })
    expect(delta[0]?.payload.segment_id).toBe("m1")

    const completed = f.feed({
      event: "text_chunk",
      ...ENV,
      data: { segment_id: "m1", text: "子智能体结论", final: true, subagent_id: "sa1" },
    })
    expect(completed[0]?.event).toBe("subagent.text.completed")
    expect(completed[0]?.payload).toMatchObject({ subagent_id: "sa1", text: "子智能体结论" })
    expect(completed[0]?.payload.segment_id).toBe("m1")
  })

  // --- tool family ---

  test("tool_call_start maps to a tool.invoked envelope and parses clean", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const out = f.feed({
      event: "tool_call_start",
      ...ENV,
      data: { segment_id: "m1", tool_id: "t1", name: "get_weather", args: { city: "北京" } },
    })
    const invokedPayload = payloadOf(out[0], "tool.invoked")
    expect(invokedPayload.segment_id).toBe("m1")
    expect(invokedPayload.tool_id).toBe("t1")
    expect(invokedPayload.name).toBe("get_weather")
    expect(invokedPayload.args).toEqual({ city: "北京" })
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("tool_call_end maps to a tool.returned envelope", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const out = f.feed({
      event: "tool_call_end",
      ...ENV,
      data: {
        segment_id: "m1",
        tool_id: "t1",
        name: "get_weather",
        result: "北京: 晴",
        is_error: false,
        rejected: false,
      },
    })
    const returnedPayload = payloadOf(out[0], "tool.returned")
    expect(returnedPayload.segment_id).toBe("m1")
    expect(returnedPayload.tool_id).toBe("t1")
    expect(returnedPayload.name).toBe("get_weather")
    expect(returnedPayload.result).toBe("北京: 晴")
    expect(returnedPayload.is_error).toBe(false)
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("tool_call_end carries is_error=true through for a failed tool", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const out = f.feed({
      event: "tool_call_end",
      ...ENV,
      data: {
        segment_id: "m1",
        tool_id: "t1",
        name: "fetch_url",
        result: "connection refused",
        is_error: true,
        rejected: false,
      },
    })
    expect(payloadOf(out[0], "tool.returned").is_error).toBe(true)
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("tool_call_end carries the HITL rejected flag through (replay-safe distinct visual)", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const out = f.feed({
      event: "tool_call_end",
      ...ENV,
      data: {
        segment_id: "m1",
        tool_id: "t1",
        name: "fetch_url",
        result: "不安全",
        is_error: false,
        rejected: true,
        reject_reason: "不安全",
      },
    })
    expect(payloadOf(out[0], "tool.returned").rejected).toBe(true)
    expect(payloadOf(out[0], "tool.returned").reject_reason).toBe("不安全")
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("each tool_call_awaiting maps to one tool.awaiting_approval", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    // agent 现发逐工具顶层 tool_call_awaiting（不再打包 pending 数组）。
    const out1 = f.feed({
      event: "tool_call_awaiting",
      ...ENV,
      data: {
        segment_id: "m1",
        tool_id: "t1",
        name: "fetch",
        args: { url: "a" },
        description: "需要批准 fetch",
        allowed_decisions: ["approve", "edit", "reject"],
        kind: "tool_approval",
        editable: true,
      },
    })
    const out2 = f.feed({
      event: "tool_call_awaiting",
      ...ENV,
      data: {
        segment_id: "m1",
        tool_id: "t2",
        name: "ask_user",
        args: { question: "继续吗" },
        description: "需要用户回答",
        allowed_decisions: ["respond"],
        kind: "ask_user",
        editable: false,
      },
    })
    expect(out1.map((e) => e.event)).toEqual(["tool.awaiting_approval"])
    expect(out2.map((e) => e.event)).toEqual(["tool.awaiting_approval"])
    expect(payloadOf(out1[0], "tool.awaiting_approval")).toMatchObject({
      segment_id: "m1", tool_id: "t1", name: "fetch", args: { url: "a" },
      description: "需要批准 fetch", allowed_decisions: ["approve", "edit", "reject"],
      kind: "tool_approval", editable: true,
    })
    expect(payloadOf(out2[0], "tool.awaiting_approval")).toMatchObject({
      segment_id: "m1", tool_id: "t2", name: "ask_user", args: { question: "继续吗" },
      description: "需要用户回答", allowed_decisions: ["respond"],
      kind: "ask_user", editable: false,
    })
    for (const e of [...out1, ...out2]) expect(() => parseSessionEvent(e)).not.toThrow()
  })

  // --- todo / subagent lifecycle ---

  test("todo_updated carries the ordered CC-style list through unchanged", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const todos = [
      { content: "查天气", status: "completed" },
      { content: "作答", status: "in_progress" },
    ]
    const out = f.feed({
      event: "agent_status",
      ...ENV,
      data: { status: "todo_updated", segment_id: "m1", todos },
    })
    expect(out[0]?.event).toBe("todo.updated")
    expect(out[0]?.payload.todos).toEqual(todos)
    expect(() => parseSessionEvent(out[0])).not.toThrow()
  })

  test("subagent lifecycle maps started + finished", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const startedOut = f.feed({
      event: "agent_status",
      ...ENV,
      data: {
        status: "subagent_started",
        segment_id: "m1",
        subagent_id: "sa1",
        name: "researcher",
        description: "查资料",
        subagent_type: "researcher",
        source: "built-in",
      },
    })
    const finishedOut = f.feed({
      event: "agent_status",
      ...ENV,
      data: {
        status: "subagent_finished",
        segment_id: "m1",
        subagent_id: "sa1",
        name: "researcher",
        subagent_type: "researcher",
        source: "built-in",
      },
    })
    const startedPayload = payloadOf(startedOut[0], "subagent.started")
    expect(startedPayload.segment_id).toBe("m1")
    expect(startedPayload.subagent_id).toBe("sa1")
    expect(startedPayload.name).toBe("researcher")
    expect(startedPayload.description).toBe("查资料")
    expect(startedPayload.subagent_type).toBe("researcher")
    expect(startedPayload.source).toBe("built-in")
    const finishedPayload = payloadOf(finishedOut[0], "subagent.finished")
    expect(finishedPayload.segment_id).toBe("m1")
    expect(finishedPayload.subagent_id).toBe("sa1")
    expect(finishedPayload.name).toBe("researcher")
    expect(finishedPayload.subagent_type).toBe("researcher")
    expect(finishedPayload.source).toBe("built-in")
  })

  test("agent_status custom is dropped (web does not render business telemetry)", () => {
    const f = makeFeeder(makeNormalizer())
    f.feed(started)
    const out = f.feed({
      event: "agent_status",
      ...ENV,
      data: { status: "custom", custom: { kind: "telemetry", value: 1 } },
    })
    expect(out).toEqual([])
  })

  // --- strict producer boundary ---

  test("schema collapse: tool_call_start with an extra key throws", () => {
    const f = makeFeeder(makeNormalizer())
    expect(() =>
      f.feed({
        event: "tool_call_start",
        ...ENV,
        data: { segment_id: "m1", tool_id: "t", name: "x", args: {}, extra: 1 },
      }),
    ).toThrow()
  })

  test("schema collapse: tool_call_end missing is_error throws (strict producer boundary)", () => {
    const f = makeFeeder(makeNormalizer())
    expect(() =>
      f.feed({
        event: "tool_call_end",
        ...ENV,
        data: { segment_id: "m1", tool_id: "t1", name: "x", result: "ok", rejected: false },
      }),
    ).toThrow()
  })
})
