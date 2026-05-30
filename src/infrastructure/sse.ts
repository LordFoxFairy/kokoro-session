import type { SessionEvent } from "../domain/events"
import type { A2uiOp } from "../domain/a2ui"

// SSE 输出保留 id/event/data，方便 web 侧直接承接游标与事件名。
export function toSseChunk(event: SessionEvent) {
  return (
    `id: ${event.cursor}\n` +
    `event: ${event.event}\n` +
    `data: ${JSON.stringify(event)}\n\n`
  )
}

// A2UI op 的 SSE 封装：每行一条 op，事件名固定 a2ui.op，id 用来源 cursor + op 序号便于将来续传。
export function toA2uiSseChunk(op: A2uiOp, id: string): string {
  return `id: ${id}\n` + `event: a2ui.op\n` + `data: ${JSON.stringify(op)}\n\n`
}
