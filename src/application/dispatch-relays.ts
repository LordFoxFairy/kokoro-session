import { runRequestSchema } from "../domain/run-request"
import { Normalizer } from "./normalize"
import type { StreamProtocol } from "./event-stream"
import { relayRun } from "./relay-run"
import type { SessionStore } from "./session-store"
import { REQUESTS_STREAM } from "./stream-names"

// 后台调度：消费 run 请求流，为每个 run 起一条 relay（归一化 agent 事件 → live 发布 + DB 持久）。
export async function dispatchRelays(
  bus: StreamProtocol,
  sessionStore: SessionStore,
): Promise<void> {
  for await (const item of bus.subscribe(REQUESTS_STREAM)) {
    // 跳过单条脏请求而不中断循环（skip-and-continue）：否则此后所有新 run 不再被调度。
    const parsed = runRequestSchema.safeParse(item.event)
    if (!parsed.success) {
      console.error("dropping malformed run.request", parsed.error.message)
      continue
    }
    const request = parsed.data
    const normalizer = new Normalizer(
      {
        sessionId: request.session_id,
        conversationId: request.session_id,
        runId: request.run_id,
      },
      { now: () => new Date() },
    )
    // 每个 run 独立 relay，互不阻塞；失败仅记录，不影响调度循环。
    void relayRun({
      bus,
      sessionStore,
      normalizer,
      siteId: request.site_id,
      sessionId: request.session_id,
      runId: request.run_id,
    }).catch((error: unknown) => {
      console.error("relay failed", request.run_id, error)
    })
  }
}
