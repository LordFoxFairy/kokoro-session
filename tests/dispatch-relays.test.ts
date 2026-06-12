import { describe, expect, test } from "bun:test"

import { dispatchRelays } from "../src/application/dispatch-relays"
import { REQUESTS_STREAM, runEventsStream } from "../src/application/start-run"
import { memoryReplayStore } from "../src/infrastructure/replay-store"
import { MemoryStreamPort } from "../src/infrastructure/stream-port"
import type { SessionEvent } from "../src/domain/session-event"

// 轮询直到 replay 出现终态（dispatch 循环活着才可能发生），超时返回当前快照。
async function waitForTerminal(
  read: () => SessionEvent[],
  deadlineMs: number,
): Promise<SessionEvent[]> {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    const events = read()
    if (events.some((e) => e.event === "run.completed" || e.event === "run.failed")) {
      return events
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return read()
}

describe("dispatchRelays", () => {
  test("a malformed run.request is skipped without killing the dispatch loop", async () => {
    const streamPort = new MemoryStreamPort()
    const replayStore = memoryReplayStore()
    const runId = "run_after_dirty"

    // 先灌一条脏请求（多余键 + 缺必填），再灌合法请求——脏请求不得杀死调度循环。
    await streamPort.publish(REQUESTS_STREAM, { kind: "run.request", injected: "evil" })
    await streamPort.publish(REQUESTS_STREAM, {
      kind: "run.request",
      run_id: runId,
      session_id: "ses_dispatch",
      conversation_id: "ses_dispatch",
      input: "hello",
    })

    // 合法 run 的 agent 事件已就绪，relay 一启动即可收束。
    const stream = runEventsStream(runId)
    await streamPort.publish(stream, { kind: "run.started", run_id: runId, seq: 0, payload: {} })
    await streamPort.publish(stream, {
      kind: "text.completed",
      run_id: runId,
      seq: 1,
      payload: { segment_id: `${runId}:seg_0001`, text: "still alive" },
    })
    await streamPort.publish(stream, {
      kind: "run.completed",
      run_id: runId,
      seq: 2,
      payload: { status: "completed" },
    })

    // 调度循环常驻不返回；悬挂运行后轮询 replay 验证合法 run 仍被调度。
    void dispatchRelays(streamPort, replayStore).catch(() => {})

    const events = await waitForTerminal(() => replayStore.read("ses_dispatch"), 1500)
    expect(events.map((e) => e.event)).toEqual([
      "session.created",
      "run.created",
      "message.completed",
      "run.completed",
    ])
  })
})
