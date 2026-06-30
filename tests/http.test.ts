import type { AddressInfo } from "node:net"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { Normalizer } from "../src/application/normalize"
import { relayRun } from "../src/application/relay-run"
import { REQUESTS_STREAM, runEventsStream } from "../src/application/stream-names"
import type { SessionEvent } from "../src/domain/session-event"
import { MemorySessionStore } from "../src/application/session-store"
import { LIVE_STREAM_MAXLEN, liveStream } from "../src/infrastructure/live-bus"
import { MemoryMessageStore } from "../src/infrastructure/message-store"
import { MemoryStream } from "../src/infrastructure/stream"
import { buildServer } from "../src/interfaces/http"

function makeDeps() {
  const bus = new MemoryStream()
  const messageStore = new MemoryMessageStore()
  const sessionStore = new MemorySessionStore()
  return { bus, messageStore, sessionStore }
}

// 模拟 relay：先发布 live（拿 cursor）再持久 DB，返回各事件的 transport cursor（= SSE id 轴）。
async function seed(
  deps: ReturnType<typeof makeDeps>,
  sessionId: string,
  events: SessionEvent[],
): Promise<string[]> {
  const cursors: string[] = []
  for (const event of events) {
    const cursor = await deps.bus.publish(liveStream(sessionId), event, {
      maxlen: LIVE_STREAM_MAXLEN,
    })
    await deps.messageStore.append(sessionId, [{ cursor, event }])
    cursors.push(cursor)
  }
  return cursors
}

let server: ReturnType<typeof buildServer>
let baseUrl: string

async function listen(deps: ReturnType<typeof makeDeps>) {
  server = buildServer(deps)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe("routing", () => {
  beforeEach(async () => {
    await listen(makeDeps())
  })

  test("404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
  })

  test("old POST /sessions/:id/runs route is removed", async () => {
    const res = await fetch(`${baseUrl}/sessions/ses_dup_q/runs?input=first`, { method: "POST" })
    expect(res.status).toBe(404)
  })
})

describe("GET /sessions/:id/stream", () => {
  test("replays normalized AGUI events as SSE after relay drains", async () => {
    const deps = makeDeps()
    await listen(deps)

    const sessionId = "ses_sse"
    const runId = "run_sse"

    // 模拟 agent worker：把 canonical wire 事件回写到 run 事件流。
    const env = { request_id: runId, timestamp: 1700000000 }
    const stream = runEventsStream(runId)
    await deps.bus.publish(stream, { event: "agent_status", ...env, data: { status: "started" } })
    await deps.bus.publish(stream, {
      event: "text_chunk",
      ...env,
      data: { segment_id: "m1", text: "Hi", final: false },
    })
    await deps.bus.publish(stream, {
      event: "agent_done",
      ...env,
      data: { status: "completed", usage: {} },
    })
    const normalizer = new Normalizer(
      { sessionId, conversationId: sessionId, runId },
      { now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ bus: deps.bus, messageStore: deps.messageStore, normalizer, sessionId, runId })

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(2000),
    })
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const text = await readSomeSse(res)
    expect(text).toContain("event: session.created")
    expect(text).toContain("event: run.created")
    expect(text).toContain("event: message.delta")
    expect(text).toContain("event: run.completed")
    expect(text).toContain('"title":"ses_sse"')
    // SSE 三行结构：id / event / data。id 用 replay 流 transport cursor（数字），非域 cursor。
    expect(text).toMatch(/id: \d+\nevent: session\.created\ndata: \{/)
  })

  // 回归：非空快照后必须继续续订实时事件。旧实现把领域 envelope.cursor 当作续订游标，
  // 快照非空时续订不到随后追加的事件（Redis 后端更会因非法 id 直接断流）。
  test("keeps streaming live events appended after the initial replay", async () => {
    const deps = makeDeps()
    await listen(deps)

    const sessionId = "ses_tail"
    const runId = "run_tail"
    const base = {
      session_id: sessionId,
      conversation_id: sessionId,
      run_id: runId,
      timestamp: "2026-05-30T00:00:00.000Z",
    }

    // 先落一条历史事件（DB 持久）→ SSE 打开时历史快照非空。
    await seed(deps, sessionId, [
      {
        event: "session.created",
        event_id: "evt_1",
        seq: 0,
        ...base,
        payload: {
          session_id: sessionId,
          conversation_id: sessionId,
          owner_id: "agent",
          title: sessionId,
        },
      },
    ])

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(3000),
    })

    // 连接建立后只发到 live 总线（不入历史），确保这些事件必须靠实时 tail 才能到达——正是要验证的那段。
    await new Promise((resolve) => setTimeout(resolve, 50))
    await deps.bus.publish(liveStream(sessionId), {
      event: "message.delta",
      event_id: "evt_2",
      seq: 1,
      ...base,
      payload: { segment_id: `${runId}:m1`, delta: "你好", role: "assistant" },
    })
    await deps.bus.publish(liveStream(sessionId), {
      event: "run.completed",
      event_id: "evt_3",
      seq: 2,
      ...base,
      payload: { run_id: runId, status: "completed" },
    })

    const text = await readSomeSse(res)
    expect(text).toContain("event: session.created") // 历史回放
    expect(text).toContain("event: message.delta") // 实时续订（旧实现在此断流）
    expect(text).toContain("event: run.completed")
  })

  // 回归：损坏条目（decodeFields 兜底为 null）混入回放流时，SSE 必须跳过该条而非整流断供。
  test("skips a corrupt/null replay entry instead of crashing the SSE stream", async () => {
    const deps = makeDeps()
    await listen(deps)

    const sessionId = "ses_corrupt"
    const runId = "run_corrupt"
    const base = {
      session_id: sessionId,
      conversation_id: sessionId,
      run_id: runId,
      timestamp: "2026-05-30T00:00:00.000Z",
    }
    await seed(deps, sessionId, [
      {
        event: "session.created",
        event_id: "evt_1",
        seq: 0,
        ...base,
        payload: {
          session_id: sessionId,
          conversation_id: sessionId,
          owner_id: "agent",
          title: sessionId,
        },
      },
    ])
    // 损坏的 Redis 条目经 decodeFields 兜底后即为 null：直接投喂 null 到 live 总线复现该形态，
    // 紧随其后的合法终态须照常 tail 交付——单条脏数据不得炸断 SSE 实时流。
    await deps.bus.publish(liveStream(sessionId), null)
    await deps.bus.publish(liveStream(sessionId), {
      event: "run.completed",
      event_id: "evt_2",
      seq: 1,
      ...base,
      payload: { run_id: runId, status: "completed" },
    })

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(2000),
    })
    const text = await readSomeSse(res)

    // 损坏条目被跳过，其前后的合法事件照常交付——SSE 流没有被单条脏数据炸断。
    expect(text).toContain("event: session.created")
    expect(text).toContain("event: run.completed")
  })

  test("SSE id line carries the replay transport cursor, not the domain envelope cursor", async () => {
    const deps = makeDeps()
    await listen(deps)

    const sessionId = "ses_id"
    const runId = "run_id"
    const base = {
      session_id: sessionId,
      conversation_id: sessionId,
      run_id: runId,
      timestamp: "2026-05-30T00:00:00.000Z",
    }
    const cursors = await seed(deps, sessionId, [
      {
        event: "session.created",
        event_id: "evt_1",
        seq: 0,
        ...base,
        payload: {
          session_id: sessionId,
          conversation_id: sessionId,
          owner_id: "agent",
          title: sessionId,
        },
      },
      {
        event: "run.completed",
        event_id: "evt_2",
        seq: 1,
        ...base,
        payload: { run_id: runId, status: "completed" },
      },
    ])

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(2000),
    })
    const text = await readSomeSse(res)

    // SSE id = transport cursor（全局单调、可作续点），而非 per-run 域 cursor。
    expect(text).toContain(`id: ${cursors[0]}`)
    expect(text).not.toContain(`id: ${runId}:0001`)
  })

  test("resumes from a transport-cursor Last-Event-ID, skipping already-delivered events", async () => {
    const deps = makeDeps()
    await listen(deps)

    const sessionId = "ses_resume"
    const runId = "run_resume"
    const base = {
      session_id: sessionId,
      conversation_id: sessionId,
      run_id: runId,
      timestamp: "2026-05-30T00:00:00.000Z",
    }
    const cursors = await seed(deps, sessionId, [
      {
        event: "session.created",
        event_id: "evt_1",
        seq: 0,
        ...base,
        payload: {
          session_id: sessionId,
          conversation_id: sessionId,
          owner_id: "agent",
          title: sessionId,
        },
      },
      {
        event: "message.delta",
        event_id: "evt_2",
        seq: 1,
        ...base,
        payload: { segment_id: `${runId}:m1`, delta: "hi", role: "assistant" },
      },
      {
        event: "run.completed",
        event_id: "evt_3",
        seq: 2,
        ...base,
        payload: { run_id: runId, status: "completed" },
      },
    ])

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/stream`, {
      headers: {
        accept: "text/event-stream",
        "last-event-id": cursors[0] as string,
      },
      signal: AbortSignal.timeout(2000),
    })
    const text = await readSomeSse(res)

    // 续点之后增量续传：cursor[0] 的 session.created 已交付，跳过；其后的续传。
    expect(text).not.toContain("event: session.created")
    expect(text).toContain("event: message.delta")
    expect(text).toContain("event: run.completed")
  })

  test("falls back to full replay when Last-Event-ID is not a transport cursor (upgrade transition)", async () => {
    const deps = makeDeps()
    await listen(deps)

    const sessionId = "ses_legacy"
    const runId = "run_legacy"
    const base = {
      session_id: sessionId,
      conversation_id: sessionId,
      run_id: runId,
      timestamp: "2026-05-30T00:00:00.000Z",
    }
    await seed(deps, sessionId, [
      {
        event: "session.created",
        event_id: "evt_1",
        seq: 0,
        ...base,
        payload: {
          session_id: sessionId,
          conversation_id: sessionId,
          owner_id: "agent",
          title: sessionId,
        },
      },
      {
        event: "run.completed",
        event_id: "evt_2",
        seq: 1,
        ...base,
        payload: { run_id: runId, status: "completed" },
      },
    ])

    // 升级过渡：浏览器仍持旧的域 cursor 作 Last-Event-ID。它不是合法 transport 续点，
    // 必须被忽略、退回全量重放（reducer 端 eventId 去重兜底），绝不能静默空流。
    const res = await fetch(`${baseUrl}/sessions/${sessionId}/stream`, {
      headers: {
        accept: "text/event-stream",
        "last-event-id": `${runId}:0001`,
      },
      signal: AbortSignal.timeout(2000),
    })
    const text = await readSomeSse(res)

    expect(text).toContain("event: session.created")
    expect(text).toContain("event: run.completed")
  })
})

describe("HTTP boundary contract", () => {
  beforeEach(async () => {
    await listen(makeDeps())
  })

  test("400 with JSON error body locating to content when content is missing", async () => {
    const res = await fetch(`${baseUrl}/sessions/ses_01/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "idem_1" }),
    })
    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("content")
  })

  // 非法枚举是客户端入参错误：必须 400 而非让 ZodError 穿透成 500。
  test("400 when executionStyle is not a known enum value", async () => {
    const res = await fetch(`${baseUrl}/sessions/ses_01/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "idem_1", content: "hello", executionStyle: "bogus" }),
    })
    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("executionStyle")
  })

  // 错误方法打到已知资源路径：当前契约无专门 405，一律落 404——钉死之，避免静默行为漂移。
  test("404 for a known resource path with the wrong method", async () => {
    const postStream = await fetch(`${baseUrl}/sessions/ses_01/stream`, { method: "POST" })
    expect(postStream.status).toBe(404)
    const deleteRuns = await fetch(`${baseUrl}/sessions/ses_01/runs?input=hi`, {
      method: "DELETE",
    })
    expect(deleteRuns.status).toBe(404)
  })
})

describe("HTTP error envelope", () => {
  // 非 Zod 的内部错误（下游 publish 抛）必须显性落 500 带 message，不静默成 200 或挂起。
  test("500 with the error message when run dispatch throws a non-Zod error", async () => {
    const deps = makeDeps()
    deps.bus.publish = async () => {
      throw new Error("redis down")
    }
    await listen(deps)
    const res = await fetch(`${baseUrl}/sessions/ses_01/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "idem_1", content: "hello" }),
    })
    expect(res.status).toBe(500)
    expect(await res.text()).toBe("redis down")
  })
})

describe("POST run control (HITL)", () => {
  function postControl(runId: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/sessions/s1/runs/${runId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  test("202 and writes run.resume with the per-tool decision to the requests stream", async () => {
    const deps = makeDeps()
    await listen(deps)
    const res = await postControl("run_1", {
      kind: "run.resume",
      decisions: [{ type: "approve", tool_id: "call-A" }],
    })
    expect(res.status).toBe(202)
    const items = await deps.bus.readAll(REQUESTS_STREAM)
    expect(items).toHaveLength(1)
    expect(items[0]?.event).toEqual({
      kind: "run.resume",
      run_id: "run_1",
      decisions: [{ type: "approve", tool_id: "call-A" }],
    })
  })

  test("202 and writes run.cancel (run abandon → agent cancels the run)", async () => {
    const deps = makeDeps()
    await listen(deps)
    const res = await postControl("run_1", { kind: "run.cancel" })
    expect(res.status).toBe(202)
    const items = await deps.bus.readAll(REQUESTS_STREAM)
    expect(items[0]?.event).toEqual({ kind: "run.cancel", run_id: "run_1" })
  })

  test("202 carries same-frame multi-tool decisions in one resume (approve A + reject B)", async () => {
    const deps = makeDeps()
    await listen(deps)
    const res = await postControl("run_1", {
      kind: "run.resume",
      decisions: [
        { type: "approve", tool_id: "call-A" },
        { type: "reject", tool_id: "call-B", message: "no" },
      ],
    })
    expect(res.status).toBe(202)
    const items = await deps.bus.readAll(REQUESTS_STREAM)
    expect((items[0]?.event as { decisions: unknown[] }).decisions).toHaveLength(2)
  })

  test("202 relays an edit decision with edited_action", async () => {
    const deps = makeDeps()
    await listen(deps)
    const edited = { name: "bash", args: { cmd: "ls" } }
    const res = await postControl("run_1", {
      kind: "run.resume",
      decisions: [{ type: "edit", tool_id: "call-A", edited_action: edited }],
    })
    expect(res.status).toBe(202)
    const items = await deps.bus.readAll(REQUESTS_STREAM)
    expect((items[0]?.event as { decisions: { edited_action: unknown }[] }).decisions[0]?.edited_action).toEqual(edited)
  })

  test("400 for malformed JSON body (client input error, fails loud)", async () => {
    await listen(makeDeps())
    const res = await fetch(`${baseUrl}/sessions/s1/runs/run_1/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    })
    expect(res.status).toBe(400)
  })

  test("400 for an invalid decision type (strict discriminated union)", async () => {
    await listen(makeDeps())
    const res = await postControl("run_1", {
      kind: "run.resume",
      decisions: [{ type: "bogus", tool_id: "call-A" }],
    })
    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toContain("application/json")
  })

  test("400 for a decision missing tool_id (multi-tool attribution is required)", async () => {
    await listen(makeDeps())
    const res = await postControl("run_1", {
      kind: "run.resume",
      decisions: [{ type: "approve" }],
    })
    expect(res.status).toBe(400)
  })

  test("400 for an empty decisions array (a resume must decide at least one tool)", async () => {
    await listen(makeDeps())
    const res = await postControl("run_1", { kind: "run.resume", decisions: [] })
    expect(res.status).toBe(400)
  })
})

describe("CORS", () => {
  beforeEach(async () => {
    await listen(makeDeps())
  })

  test("echoes allow-origin and vary: origin for an allowlisted browser origin", async () => {
    const res = await fetch(`${baseUrl}/nope`, {
      headers: { origin: "http://localhost:3000" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(res.headers.get("vary")).toBe("origin")
  })

  test("answers preflight OPTIONS with 204 and an empty body on any path", async () => {
    const res = await fetch(`${baseUrl}/whatever`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000" },
    })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS")
  })

  // allowlist 之外的源不回显 allow-origin（浏览器侧拦截），但请求本身正常服务。
  test("omits allow-origin for a non-allowlisted origin while still serving the request", async () => {
    const res = await fetch(`${baseUrl}/sessions/ses_cors/messages`, {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "idem_1", content: "hello" }),
    })
    expect(res.status).toBe(202)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })
})

// 读到包含 run.completed 的回放部分即返回，避免在 keep-alive 续订连接上无限等待。
async function readSomeSse(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error("no body")
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes("event: run.completed")) {
        await reader.cancel()
        break
      }
    }
  } catch {
    // AbortSignal.timeout 触发：返回已读部分，让断言判定（空流也被断言捕获，而非抛错）。
  }
  return buffer
}
