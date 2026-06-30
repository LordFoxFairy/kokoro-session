import type { SessionEvent } from "../domain/session-event"

// SSE id 使用 opaque event_id；Last-Event-ID 只作为 DB replay 锚点，不承担排序语义。
export function toSseChunk(sseId: string, event: SessionEvent) {
  return (
    `id: ${sseId}\n` +
    `event: ${event.event}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  )
}
