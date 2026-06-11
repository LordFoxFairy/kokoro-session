import type { SessionEvent } from "../domain/session-event"

// SSE id 用 replay 流的 transport cursor（全局单调、可作 Last-Event-ID 续点）；
// event/data 用领域事件名与完整载荷（含域 cursor，web 排序自取）。
export function toSseChunk(transportCursor: string, event: SessionEvent) {
  return (
    `id: ${transportCursor}\n` +
    `event: ${event.event}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  )
}
