import type { ReplayStore, StreamProtocol } from "../application/event-stream"

// 每个 session 一条流 kokoro:session:{id}:replay；跨进程订阅由 interfaces 层经 StreamProtocol.subscribe 续订。
export function replayStream(sessionId: string): string {
  return `kokoro:session:${sessionId}:replay`
}

export function makeReplayStore(bus: StreamProtocol): ReplayStore {
  return {
    async append(sessionId, events) {
      const stream = replayStream(sessionId)
      for (const event of events) {
        await bus.publish(stream, event)
      }
    },
  }
}
