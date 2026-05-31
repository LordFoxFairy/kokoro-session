import type { AddressInfo } from "node:net"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { Normalizer } from "../src/application/normalize"
import { relayRun, runEventsStream, startRun } from "../src/application/start_run"
import { makeReplayStore } from "../src/infrastructure/replay_store"
import { MemoryStreamPort } from "../src/infrastructure/stream-port"
import { buildServer } from "../src/interfaces/http"

function makeDeps() {
  const streamPort = new MemoryStreamPort()
  const replayStore = makeReplayStore(streamPort)
  let n = 0
  return {
    streamPort,
    replayStore,
    newEventId: () => `evt_${++n}`,
    now: () => new Date("2026-05-31T00:00:00.000Z"),
  }
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

describe("POST /sessions/:id/runs", () => {
  beforeEach(async () => {
    await listen(makeDeps())
  })

  test("returns 200 with a runId", async () => {
    const res = await fetch(`${baseUrl}/sessions/ses_01/runs?input=hello`, {
      method: "POST",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: string }
    expect(body.runId).toMatch(/^run_/)
  })

  test("404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
  })
})

describe("GET /sessions/:id/stream", () => {
  test("replays A2UI ops as SSE after relay drains", async () => {
    const deps = makeDeps()
    await listen(deps)

    const sessionId = "ses_sse"
    const { runId } = await startRun(
      { sessionId, input: "hello" },
      { streamPort: deps.streamPort },
    )

    // 模拟 agent worker：把原始事件回写到 run 事件流。
    const stream = runEventsStream(runId)
    await deps.streamPort.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await deps.streamPort.publish(stream, {
      kind: "text.delta",
      run_id: runId,
      seq: 1,
      payload: { message_ref: "m1", text: "Hi" },
    })
    await deps.streamPort.publish(stream, {
      kind: "run.completed",
      run_id: runId,
      seq: 2,
      payload: { status: "completed" },
    })

    let n = 0
    const normalizer = new Normalizer(
      { sessionId, conversationId: sessionId, runId },
      { newEventId: () => `evt_${++n}`, now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    await relayRun({ streamPort: deps.streamPort, replayStore: deps.replayStore, normalizer, sessionId, runId })

    const res = await fetch(`${baseUrl}/sessions/${sessionId}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(2000),
    })
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const text = await readSomeSse(res)
    // stream 现在产出 A2UI op（event: a2ui.op），不再是 AGUI 信封。
    expect(text).toContain("event: a2ui.op")
    expect(text).toContain("createSurface")
    expect(text).toContain("kokoro/chat/v1")
    expect(text).toContain("updateComponents")
    // 完整 op 链路：createSurface→updateComponents→updateDataModel 都流过集成路径。
    expect(text).toContain("updateDataModel")
    // SSE 三行结构：id / event / data。
    expect(text).toMatch(/id: [^\n]+\nevent: a2ui\.op\ndata: \{/)
  })

  // 回归：连接后才追加的事件，必须经实时 tail 送达。
  // 旧实现把 SessionEvent.cursor（归一化游标 run_id:NNNN）当成流位置传给 subscribe，
  // 与后端原生游标命名空间不符——内存后端会把后续事件过滤掉、redis 会 XREAD 抛错关连接，
  // 导致只能靠"重连+全量重放"凑活。此用例在非空快照后追加事件，断言它们活体送达。
  test("delivers live ops appended AFTER the client connects (cursor resume regression)", async () => {
    const deps = makeDeps()
    await listen(deps)

    const sessionId = "ses_live"
    const runId = "run_live"
    let n = 0
    const normalizer = new Normalizer(
      { sessionId, conversationId: sessionId, runId },
      { newEventId: () => `evt_${++n}`, now: () => new Date("2026-05-30T00:00:00.000Z") },
    )
    const append = async (raw: unknown): Promise<void> => {
      const envs = normalizer.ingest(raw)
      if (envs.length) await deps.replayStore.append(sessionId, envs)
    }

    // Phase 1：先归一化一批，使客户端连接时快照非空（last 游标为归一化的 run_live:NNNN）。
    await append({ kind: "run.started", run_id: runId, seq: 0, payload: {} })

    // 客户端连接（快照里已有 createSurface + Thread）。
    const res = await fetch(`${baseUrl}/sessions/${sessionId}/stream`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(3000),
    })
    const reading = readUntil(res, "LIVE-OK")

    // Phase 2：连接之后才追加的事件——必须经实时 tail 送达（旧实现会丢/断）。
    await append({
      kind: "text.delta",
      run_id: runId,
      seq: 1,
      payload: { message_ref: "m1", text: "LIVE-OK" },
    })
    await append({
      kind: "run.completed",
      run_id: runId,
      seq: 2,
      payload: { status: "completed" },
    })

    const text = await reading
    // 连接后追加的文本经 updateDataModel 活体送达。
    expect(text).toContain("LIVE-OK")
    expect(text).toContain("updateDataModel")
  })

  test("permission fixture run replays a PermissionCard over SSE", async () => {
    const deps = makeDeps()
    await listen(deps)

    const res = await fetch(`${baseUrl}/sessions/ses_perm/runs?input=hello&fixture=permission`, {
      method: "POST",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: string }
    expect(body.runId).toMatch(/^run_/)

    const stream = await fetch(`${baseUrl}/sessions/ses_perm/stream`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(3000),
    })
    const text = await readUntil(stream, "PermissionCard")
    expect(text).toContain("event: a2ui.op")
    expect(text).toContain("PermissionCard")
    expect(text).toContain("我想访问这个外部资源，可以吗？")
  })

  test("permission decision endpoint resolves the existing card in place", async () => {
    const deps = makeDeps()
    await listen(deps)

    const start = await fetch(`${baseUrl}/sessions/ses_perm/runs?input=hello&fixture=permission`, {
      method: "POST",
    })
    expect(start.status).toBe(200)
    const { runId } = (await start.json()) as { runId: string }
    const requestId = `perm_${runId}`

    const stream = await fetch(`${baseUrl}/sessions/ses_perm/stream`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(5000),
    })
    const reading = readUntil(stream, "这一步已经允许继续了。")

    const decision = await fetch(`${baseUrl}/sessions/ses_perm/permissions/${requestId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "once" }),
    })

    expect(decision.status).toBe(200)
    const live = await reading
    expect(live).toContain("这一步已经允许继续了。")
    expect(live).toContain("updateDataModel")
  })

  test("permission decision endpoint is idempotent after resolve", async () => {
    const deps = makeDeps()
    await listen(deps)

    const start = await fetch(`${baseUrl}/sessions/ses_perm/runs?input=hello&fixture=permission`, {
      method: "POST",
    })
    expect(start.status).toBe(200)
    const { runId } = (await start.json()) as { runId: string }
    const requestId = `perm_${runId}`

    const first = await fetch(`${baseUrl}/sessions/ses_perm/permissions/${requestId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "once" }),
    })
    expect(first.status).toBe(200)

    const second = await fetch(`${baseUrl}/sessions/ses_perm/permissions/${requestId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "session" }),
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({
      request_id: requestId,
      decision: "allow",
      scope: "once",
      message: "这一步已经允许继续了。",
      kind: "permission",
    })

    const permissionEvents = deps.replayStore
      .read("ses_perm")
      .filter((event) => event.event === "permission.required" && event.payload.request_id === requestId)
    expect(permissionEvents).toHaveLength(2)
  })

  test("permission decision endpoint serializes concurrent duplicate submits", async () => {
    const deps = makeDeps()
    const originalAppend = deps.replayStore.append.bind(deps.replayStore)
    let resolvedAppends = 0
    let releaseFirstAppend!: () => void
    const firstAppendGate = new Promise<void>((resolve) => {
      releaseFirstAppend = () => resolve()
    })

    deps.replayStore.append = async (sessionId, events) => {
      const resolvedPermission = events.some(
        (event) => event.event === "permission.required" && event.payload.decision !== "ask",
      )
      if (resolvedPermission) {
        resolvedAppends += 1
        if (resolvedAppends === 1) {
          await firstAppendGate
        }
      }
      return originalAppend(sessionId, events)
    }

    await listen(deps)

    const start = await fetch(`${baseUrl}/sessions/ses_perm/runs?input=hello&fixture=permission`, {
      method: "POST",
    })
    expect(start.status).toBe(200)
    const { runId } = (await start.json()) as { runId: string }
    const requestId = `perm_${runId}`
    const url = `${baseUrl}/sessions/ses_perm/permissions/${requestId}/decision`

    const first = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "once" }),
    })
    await waitUntil(() => resolvedAppends === 1)

    const second = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow", scope: "session" }),
    })

    const secondReachedAppendBeforeRelease = await waitUntilOrTimeout(() => resolvedAppends === 2, 100)
    try {
      expect(secondReachedAppendBeforeRelease).toBe(false)
    } finally {
      if (releaseFirstAppend) {
        releaseFirstAppend()
      }
    }

    const [firstRes, secondRes] = await Promise.all([first, second])
    expect(firstRes.status).toBe(200)
    expect(secondRes.status).toBe(200)
    expect(await secondRes.json()).toEqual({
      request_id: requestId,
      decision: "allow",
      scope: "once",
      message: "这一步已经允许继续了。",
      kind: "permission",
    })

    const permissionEvents = deps.replayStore
      .read("ses_perm")
      .filter((event) => event.event === "permission.required" && event.payload.request_id === requestId)
    expect(permissionEvents).toHaveLength(2)
  })

  test("permission decision endpoint returns 400 for malformed JSON", async () => {
    const deps = makeDeps()
    await listen(deps)

    const start = await fetch(`${baseUrl}/sessions/ses_perm/runs?input=hello&fixture=permission`, {
      method: "POST",
    })
    expect(start.status).toBe(200)
    const { runId } = (await start.json()) as { runId: string }
    const requestId = `perm_${runId}`

    const decision = await fetch(`${baseUrl}/sessions/ses_perm/permissions/${requestId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"decision":',
    })

    expect(decision.status).toBe(400)
    expect(await decision.json()).toEqual({ error: "invalid decision payload" })
  })
})

// 读到出现哨兵串即返回（活体送达验证），带兜底防止挂死。
async function readUntil(res: Response, sentinel: string): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error("no body")
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes(sentinel)) {
        await reader.cancel()
        break
      }
    }
  } catch {
    // AbortSignal 超时——返回已收到的内容，让断言给出有意义的失败。
  }
  return buffer
}

// 读到包含 updateDataModel 的回放部分即返回，避免在 keep-alive 续订连接上无限等待。
async function readSomeSse(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error("no body")
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (buffer.includes("updateDataModel")) {
      await reader.cancel()
      break
    }
  }
  return buffer
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const ok = await waitUntilOrTimeout(predicate, timeoutMs)
  if (!ok) throw new Error("condition not met before timeout")
}

async function waitUntilOrTimeout(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(10)
  }
  return predicate()
}
