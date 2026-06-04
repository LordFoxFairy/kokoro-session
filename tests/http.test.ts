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
  return { streamPort, replayStore }
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
  test("replays normalized AGUI events as SSE after relay drains", async () => {
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
    expect(text).toContain("event: session.created")
    expect(text).toContain("event: run.created")
    expect(text).toContain("event: message.delta")
    expect(text).toContain("event: run.completed")
    expect(text).toContain('"title":"ses_sse"')
    // SSE 三行结构：id / event / data。
    expect(text).toMatch(/id: run_[^\n]*\nevent: session\.created\ndata: \{/)
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

    // 先落一条历史事件 → SSE 打开时快照非空。
    await deps.replayStore.append(sessionId, [
      {
        event: "session.created",
        event_id: "evt_1",
        ...base,
        cursor: `${runId}:0001`,
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

    // 连接建立后再追加，确保这些事件不属于初始快照——正是旧实现会漏掉的那段。
    await new Promise((resolve) => setTimeout(resolve, 50))
    await deps.replayStore.append(sessionId, [
      {
        event: "message.delta",
        event_id: "evt_2",
        ...base,
        cursor: `${runId}:0002`,
        payload: { message_id: `${runId}:m1`, delta: "你好", role: "assistant" },
      },
      {
        event: "run.completed",
        event_id: "evt_3",
        ...base,
        cursor: `${runId}:0003`,
        payload: { run_id: runId, status: "completed" },
      },
    ])

    const text = await readSomeSse(res)
    expect(text).toContain("event: session.created") // 历史回放
    expect(text).toContain("event: message.delta") // 实时续订（旧实现在此断流）
    expect(text).toContain("event: run.completed")
  })
})

// 读到包含 run.completed 的回放部分即返回，避免在 keep-alive 续订连接上无限等待。
async function readSomeSse(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error("no body")
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (buffer.includes("event: run.completed")) {
      await reader.cancel()
      break
    }
  }
  return buffer
}
