import { createServer } from "node:http"

import { startRun } from "../application/start_run"
import { memoryReplayStore } from "../infrastructure/replay_store"

export function buildServer() {
  return createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/sessions/ses_01/runs") {
      const result = await startRun({
        sessionId: "ses_01",
        input: "hello kokoro",
        executionStyle: "default",
      })
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(result))
      return
    }

    if (req.method === "GET" && req.url === "/sessions/ses_01/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })

      for (const event of memoryReplayStore.read("ses_01")) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.end()
      return
    }

    res.statusCode = 404
    res.end("not found")
  })
}
