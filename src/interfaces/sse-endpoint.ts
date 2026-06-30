import type { IncomingMessage, ServerResponse } from "node:http"

import { ZodError } from "zod"

import type { StreamProtocol } from "../application/event-stream"
import type { SessionStore } from "../application/session-store"
import { parseSessionEvent, type SessionEvent } from "../domain/session-event"
import { sessionEventFromLog } from "../domain/session-event-log"
import { liveStream } from "../infrastructure/live-bus"
import { toSseChunk } from "../infrastructure/sse"

export function resumeEventId(lastEventId: string | string[] | undefined): string | undefined {
  if (typeof lastEventId !== "string") return undefined
  return lastEventId.length > 0 ? lastEventId : undefined
}

// 续订：先启动 live tail，再从 SessionStore（Mongo）按 Last-Event-ID 回放历史，最后接上 live。
// relay 是 DB-first，所以这能覆盖「历史查询」和「实时订阅」之间的竞态；SSE id 使用 opaque event_id。
export async function streamSession(
  req: IncomingMessage,
  res: ServerResponse,
  bus: StreamProtocol,
  sessionStore: SessionStore,
  siteId: string,
  sessionId: string,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })

  const fromEventId = resumeEventId(req.headers["last-event-id"])
  let aborted = false
  req.on("close", () => {
    aborted = true
  })

  const liveIterator = bus.subscribe(liveStream(sessionId), "$")[Symbol.asyncIterator]()
  let nextLive = liveIterator.next()

  try {
    const history = await sessionStore.listEvents(
      siteId,
      sessionId,
      fromEventId === undefined ? undefined : { afterEventId: fromEventId },
    )
    const delivered = new Set<string>()
    for (const entry of history) {
      if (aborted) {
        res.end()
        return
      }
      const event = sessionEventFromLog(entry)
      delivered.add(event.event_id)
      res.write(toSseChunk(event.event_id, event))
    }

    while (!aborted) {
      const result = await nextLive
      if (result.done) break
      nextLive = liveIterator.next()
      let event: SessionEvent
      try {
        event = parseSessionEvent(result.value.event)
      } catch (error) {
        if (!(error instanceof ZodError)) throw error
        console.error("dropping malformed session event", result.value.cursor, error.message)
        continue
      }
      if (delivered.has(event.event_id)) continue
      delivered.add(event.event_id)
      res.write(toSseChunk(event.event_id, event))
    }
  } finally {
    await liveIterator.return?.()
  }
  res.end()
}
