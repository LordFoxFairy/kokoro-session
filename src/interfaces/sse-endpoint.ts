import type { IncomingMessage, ServerResponse } from "node:http"

import { ZodError } from "zod"

import type { StreamProtocol } from "../application/event-stream"
import { parseSessionEvent, type SessionEvent } from "../domain/session-event"
import { replayStream } from "../infrastructure/replay-store"
import { toSseChunk } from "../infrastructure/sse"

// Last-Event-ID 仅当是传输层游标（memory 纯数字 / redis "ms-seq"）才作续点；域 cursor 或畸形值
// 一律忽略、退回全量重放（reducer 端 eventId 去重），避免升级过渡期出现空流。
export function resumeCursor(lastEventId: string | string[] | undefined): string | undefined {
  if (typeof lastEventId !== "string") return undefined
  return /^\d+(-\d+)?$/.test(lastEventId) ? lastEventId : undefined
}

// 续订：带 Last-Event-ID（= 上次 SSE id = replay 流 transport cursor）则从该续点增量续传；
// 否则从流首全量回放（先历史后实时）。transport cursor 全局单调、可作续点，区别于 per-run 域 cursor。
export async function streamSession(
  req: IncomingMessage,
  res: ServerResponse,
  bus: StreamProtocol,
  sessionId: string,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })

  const stream = replayStream(sessionId)
  const fromCursor = resumeCursor(req.headers["last-event-id"])
  let aborted = false
  req.on("close", () => {
    aborted = true
  })

  for await (const item of bus.subscribe(stream, fromCursor)) {
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
