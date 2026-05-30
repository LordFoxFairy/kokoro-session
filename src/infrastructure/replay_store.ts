import { parseSessionEvent, type SessionEvent } from "../domain/events"
import { MemoryStreamPort, type StreamPort } from "./stream-port"

// Replay store：会话级 AGUI 事件的持久回放，由 StreamPort 背书（memory/redis 可换）。
// 每个 session 一条流 kokoro:session:{id}:replay。
export interface ReplayStore {
  append(sessionId: string, events: SessionEvent[]): Promise<void> | void
  read(sessionId: string): SessionEvent[]
}

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

// 从 StreamPort 读出某 session 的全量 replay 快照（跨进程，供 http 层 SSE 首屏使用）。
export async function readReplaySnapshot(
  streamPort: StreamPort,
  sessionId: string,
): Promise<SessionEvent[]> {
  const items = await streamPort.readAll(replayStream(sessionId))
  return items.map((item) => parseSessionEvent(item.event))
}
