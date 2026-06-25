import type { SessionEvent } from "../domain/session-event"
import type { ReplayStore, StreamProtocol } from "./event-stream"
import type { Normalizer } from "./normalize"
import { runEventsStream } from "./stream-names"

export type RelayRunInput = {
  bus: StreamProtocol
  replayStore: ReplayStore
  normalizer: Normalizer
  sessionId: string
  runId: string
}

// 消费某 run 的事件流 → 归一化 → 追加 replay。遇到终态（run.completed/run.failed）收束，
// 避免连接一直挂等。cursor 是定序唯一源兼去重锚（agent 不再发 seq），断连/空流不崩。
export async function relayRun(input: RelayRunInput): Promise<void> {
  const stream = runEventsStream(input.runId)
  for await (const item of input.bus.subscribe(stream)) {
    let envelopes: SessionEvent[]
    try {
      envelopes = input.normalizer.ingest(item.event, item.cursor)
    } catch (error) {
      // 跳过单条脏事件而不中断整条流：否则其后的终态永不落 replay，web 该轮停留在「进行中」。
      console.error("skipping dirty agent event", input.runId, error)
      continue
    }
    if (envelopes.length > 0) {
      await input.replayStore.append(input.sessionId, envelopes)
    }
    if (envelopes.some((e) => e.event === "run.completed" || e.event === "run.failed")) {
      // 终态即收束 relay：不再读取该 run 的事件流，连接释放。resume/cancel 走共享请求流、
      // 非 per-run 流，无需在此清理（agent 对未知/终态 run 的迟到控制消息直接丢弃）。
      return
    }
  }
}
