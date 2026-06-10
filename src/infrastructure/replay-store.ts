import type { ReplayStore, StreamPort } from "../application/ports"
import type { SessionEvent } from "../domain/session-event"
import { MemoryStreamPort } from "./stream-port"

// ReplayStore 契约见 application/ports；这里是 StreamPort 背书的实现。
// 每个 session 一条流 kokoro:session:{id}:replay。

export function replayStream(sessionId: string): string {
  return `kokoro:session:${sessionId}:replay`
}

// StreamPort 背书的实现。read 走内存快照（同步），保留与现有调用方一致的同步读语义；
// 跨进程订阅由 interfaces 层直接用 StreamPort.subscribe 续订（见 http.ts）。
export function makeReplayStore(streamPort: StreamPort): ReplayStore {
  // read 需要同步返回；用本地镜像缓存 append 过的事件，避免在同步路径里 await。
  const mirror = new Map<string, SessionEvent[]>()

  return {
    async append(sessionId, events) {
      const stream = replayStream(sessionId)
      const local = mirror.get(sessionId) ?? []
      for (const event of events) {
        await streamPort.publish(stream, event)
        local.push(event)
      }
      mirror.set(sessionId, local)
    },
    read(sessionId) {
      return [...(mirror.get(sessionId) ?? [])]
    },
  }
}

// 便捷构造：内存 StreamPort 背书。测试与单进程默认用它。
export function memoryReplayStore(): ReplayStore {
  return makeReplayStore(new MemoryStreamPort())
}
