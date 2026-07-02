import type { SessionEvent } from "../domain/session-event"

// SSE id 用 replay 流的 transport cursor（全局单调、可作 Last-Event-ID 续点）；
// event/data 用领域事件名与完整载荷；web 用 eventId 去重，用 session 派生 seq 做同 run UI 交错。
export function toSseChunk(transportCursor: string, event: SessionEvent) {
  return (
    `id: ${transportCursor}\n` +
    `event: ${event.event}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  )
}
