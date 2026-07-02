import type { IncomingMessage, ServerResponse } from "node:http"

import { ZodError } from "zod"

import type { MessageStore, StreamProtocol } from "../application/event-stream"
import { parseSessionEvent, type SessionEvent } from "../domain/session-event"
import { liveStream } from "../infrastructure/live-bus"
import { toSseChunk } from "../infrastructure/sse"

// Last-Event-ID 仅当是传输层游标（memory 纯数字 / redis "ms-seq"）才作续点；畸形值
// 一律忽略、退回全量重放（reducer 端 eventId 去重），避免坏续点造成空流。
export function resumeCursor(lastEventId: string | string[] | undefined): string | undefined {
  if (typeof lastEventId !== "string") return undefined
  return /^\d+(-\d+)?$/.test(lastEventId) ? lastEventId : undefined
}

// 续订：先从 MessageStore（DB，长期真源）回放历史（afterCursor 续点），再从 live 总线 tail 实时。
// 历史与 live 在续点处的重叠由 web 端 event_id 去重兜底（见 normalize 终态去重同理）。正确性不依赖
// live 流的保留时长——被 MAXLEN 裁掉的老历史一律由 DB 补全，故 redis 可大胆裁剪。
export async function streamSession(
  req: IncomingMessage,
  res: ServerResponse,
  bus: StreamProtocol,
  messageStore: MessageStore,
  sessionId: string,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })

  const fromCursor = resumeCursor(req.headers["last-event-id"])
  let aborted = false
  req.on("close", () => {
    aborted = true
  })

  // 1) 历史：DB 持久库（afterCursor 续点）。出库已过 Zod，直接写。
  const history = await messageStore.read(
    sessionId,
    fromCursor === undefined ? undefined : { afterCursor: fromCursor },
  )
  for (const stored of history) {
    if (aborted) {
      res.end()
      return
    }
    res.write(toSseChunk(stored.cursor, stored.event))
  }

  // 2) 实时：从同一续点 tail live 总线（重叠交 web 去重）。从 fromCursor 起而非历史末游标，
  //    以覆盖跨 run 异步落库重排的缝隙（live 必含该窗口事件，DB 终会补全，二者并取无遗漏）。
  for await (const item of bus.subscribe(liveStream(sessionId), fromCursor)) {
    if (aborted) break
    // 跳过单条脏事件（损坏/裁剪残留）而不中断 SSE 流：否则此后所有事件都断供。
    let event: SessionEvent
    try {
      event = parseSessionEvent(item.event)
    } catch (error) {
      if (!(error instanceof ZodError)) throw error
      console.error("dropping malformed session event", item.cursor, error.message)
      continue
    }
    res.write(toSseChunk(item.cursor, event))
  }
  res.end()
}
