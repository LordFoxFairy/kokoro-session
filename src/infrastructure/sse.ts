import type { SessionEvent } from "../domain/session-event"

// SSE 输出保留 id/event/data，方便 web 侧直接承接游标与事件名。
export function toSseChunk(event: SessionEvent) {
  return (
    `id: ${event.cursor}\n` +
    `event: ${event.event}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  )
}
