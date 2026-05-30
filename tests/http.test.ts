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
    // SSE 三行结构：id / event / data。
    expect(text).toMatch(/id: run_[^\n]*\nevent: session\.created\ndata: \{/)
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
