import type { MessageStore, StoredEvent, StreamProtocol } from "./event-stream"
import type { Normalizer } from "./normalize"
import { LIVE_STREAM_MAXLEN, liveStream } from "../infrastructure/live-bus"
import { runEventsStream } from "./stream-names"

export type RelayRunInput = {
  bus: StreamProtocol
  messageStore: MessageStore
  normalizer: Normalizer
  sessionId: string
  runId: string
}

// 消费某 run 的事件流 → 归一化 → 发布 live（供 SSE 实时）+ 持久 DB（长期真源）。先 publish 拿 cursor、
// 再以该 cursor 落 DB：DB 只存在过 live 的 cursor，两者共用唯一 id 轴。遇终态（run.completed/failed）
// 收束，避免连接挂等。cursor 是定序唯一源兼 SSE 续点；断连/空流不崩。
export async function relayRun(input: RelayRunInput): Promise<void> {
  const stream = runEventsStream(input.runId)
  const live = liveStream(input.sessionId)
  for await (const item of input.bus.subscribe(stream)) {
    let envelopes
    try {
      envelopes = input.normalizer.ingest(item.event, item.cursor)
    } catch (error) {
      // 跳过单条脏事件而不中断整条流：否则其后的终态永不落库，web 该轮停留在「进行中」。
      console.error("skipping dirty agent event", input.runId, error)
      continue
    }
    if (envelopes.length > 0) {
      const stored: StoredEvent[] = []
      for (const event of envelopes) {
        const cursor = await input.bus.publish(live, event, { maxlen: LIVE_STREAM_MAXLEN })
        stored.push({ cursor, event })
      }
      await input.messageStore.append(input.sessionId, stored)
    }
    if (envelopes.some((e) => e.event === "run.completed" || e.event === "run.failed")) {
      // 终态即收束 relay：不再读取该 run 的事件流，连接释放。resume/cancel 走共享请求流、
      // 非 per-run 流，无需在此清理（agent 对未知/终态 run 的迟到控制消息直接丢弃）。
      return
    }
  }
}
