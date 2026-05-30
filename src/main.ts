import { Normalizer } from "./application/normalize"
import { relayRun, REQUESTS_STREAM } from "./application/start_run"
import { runRequestSchema } from "./domain/agent-events"
import { makeReplayStore } from "./infrastructure/replay_store"
import { makeStreamPort } from "./infrastructure/stream-port"
import { buildServer } from "./interfaces/http"

const PORT = Number(process.env.KOKORO_SESSION_PORT ?? 3001)

function newEventId(): string {
  return `evt_${crypto.randomUUID().replace(/-/g, "")}`
}

// 后台调度：消费 run 请求流，为每个 run 起一条 relay（归一化 agent 事件 → replay）。
async function dispatchRelays(
  streamPort: ReturnType<typeof makeStreamPort>,
  replayStore: ReturnType<typeof makeReplayStore>,
): Promise<void> {
  for await (const item of streamPort.subscribe(REQUESTS_STREAM)) {
    const request = runRequestSchema.parse(item.event)
    const normalizer = new Normalizer(
      {
        sessionId: request.session_id,
        conversationId: request.conversation_id,
        runId: request.run_id,
      },
      { newEventId, now: () => new Date() },
    )
    // 每个 run 独立 relay，互不阻塞；失败只记录不拖垮调度循环。
    void relayRun({
      streamPort,
      replayStore,
      normalizer,
      sessionId: request.session_id,
      runId: request.run_id,
    }).catch((error: unknown) => {
      console.error("relay failed", request.run_id, error)
    })
  }
}

function main(): void {
  const streamPort = makeStreamPort()
  const replayStore = makeReplayStore(streamPort)

  void dispatchRelays(streamPort, replayStore).catch((error: unknown) => {
    console.error("dispatch loop crashed", error)
  })

  const server = buildServer({ streamPort, replayStore })
  server.listen(PORT, () => {
    console.log(`kokoro-session listening on :${PORT}`)
  })
}

main()
