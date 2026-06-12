import { runRequestSchema } from "../domain/run-request"
import { Normalizer } from "./normalize"
import type { ReplayStore, StreamPort } from "./ports"
import { relayRun, REQUESTS_STREAM } from "./start-run"

function newEventId(): string {
  return `evt_${crypto.randomUUID().replace(/-/g, "")}`
}

// 后台调度：消费 run 请求流，为每个 run 起一条 relay（归一化 agent 事件 → replay）。
export async function dispatchRelays(
  streamPort: StreamPort,
  replayStore: ReplayStore,
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
