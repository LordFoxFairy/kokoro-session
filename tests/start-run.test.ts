import { createServer, request, type Server } from "node:http"

import { describe, expect, test } from "bun:test"

import { startRun } from "../src/application/start_run"
import type { SessionEvent } from "../src/domain/events"
import { buildServer } from "../src/interfaces/http"

describe("startRun", () => {
  test("collects replayable agent events and returns the run id", async () => {
    const result = await startRun(
      {
        sessionId: "ses_01",
        conversationId: "conv_01",
        input: "hello kokoro",
        executionStyle: "default",
      },
      {
        replayStore: {
          append() {},
          read() {
            return []
          },
        },
        agentClient: {
          async *streamRun() {
            yield {
              event: "session.created",
              event_id: "evt_01",
              session_id: "ses_01",
              conversation_id: "conv_01",
              run_id: "run_01",
              cursor: "run_01:0001",
              timestamp: "2026-05-29T12:00:00.000Z",
              payload: {
                session_id: "ses_01",
                conversation_id: "conv_01",
                owner_id: "kokoro-agent",
                title: "Kokoro Session",
              },
            } satisfies SessionEvent
            yield {
              event: "run.completed",
              event_id: "evt_02",
              session_id: "ses_01",
              conversation_id: "conv_01",
              run_id: "run_01",
              cursor: "run_01:0002",
              timestamp: "2026-05-29T12:00:01.000Z",
              payload: {
                run_id: "run_01",
                status: "completed",
                final_message_id: "msg_01",
              },
            } satisfies SessionEvent
          },
        },
      },
    )

    expect(result.runId).toBe("run_01")
    expect(result.events).toHaveLength(2)
    expect(result.events.at(0)?.event).toBe("session.created")
    expect(result.events.at(-1)?.event).toBe("run.completed")
  })

  test("writes replay through injected boundaries so session stays transport-driven", async () => {
    const replayLog: SessionEvent[][] = []
    const streamedEvents: SessionEvent[] = [
      {
        event: "session.created",
        event_id: "evt_10",
        session_id: "ses_02",
        conversation_id: "conv_02",
        run_id: "run_02",
        cursor: "run_02:0001",
        timestamp: "2026-05-29T12:01:00.000Z",
        payload: {
          session_id: "ses_02",
          conversation_id: "conv_02",
          owner_id: "kokoro-agent",
          title: "Kokoro Session",
        },
      },
      {
        event: "run.completed",
        event_id: "evt_11",
        session_id: "ses_02",
        conversation_id: "conv_02",
        run_id: "run_02",
        cursor: "run_02:0002",
        timestamp: "2026-05-29T12:01:01.000Z",
        payload: {
          run_id: "run_02",
          status: "completed",
          final_message_id: "msg_02",
        },
      },
    ]

    const result = await startRun(
      {
        sessionId: "ses_02",
        conversationId: "conv_02",
        input: "bridge me",
        executionStyle: "default",
      },
      {
        replayStore: {
          append(_sessionId, events) {
            replayLog.push(events)
          },
          read() {
            return []
          },
        },
        agentClient: {
          async *streamRun() {
            yield* streamedEvents
          },
        },
      },
    )

    expect(replayLog).toHaveLength(1)
    expect(replayLog[0]).toEqual(streamedEvents)
    expect(result.events).toEqual(streamedEvents)
    expect(result.runId).toBe("run_02")
  })

  test("allows browser clients to call the session bridge across loopback origins", async () => {
    const server = buildServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

    try {
      const address = server.address()
      if (!address || typeof address === "string") {
        throw new Error("expected an ephemeral HTTP port")
      }

      const requestPreflight = (origin: string) =>
        new Promise<{
          statusCode: number | undefined
          headers: Record<string, string | string[] | undefined>
        }>((resolve, reject) => {
          const req = request(
            {
              host: "127.0.0.1",
              port: address.port,
              path: "/sessions/ses_01/stream",
              method: "OPTIONS",
              headers: {
                origin,
              },
            },
            (res) => {
              res.resume()
              res.on("end", () => {
                resolve({
                  statusCode: res.statusCode,
                  headers: res.headers,
                })
              })
            },
          )

          req.on("error", reject)
          req.end()
        })

      const loopbackResponse = await requestPreflight("http://127.0.0.1:3000")
      const localhostResponse = await requestPreflight("http://localhost:3000")

      // 分仓浏览器直连依赖 CORS；没有这些头时 web 会直接退回 preview fallback。
      expect(loopbackResponse.statusCode).toBe(204)
      expect(loopbackResponse.headers["access-control-allow-origin"]).toBe(
        "http://127.0.0.1:3000",
      )
      expect(loopbackResponse.headers.vary).toBe("origin")
      expect(loopbackResponse.headers["access-control-allow-methods"]).toBe(
        "GET,POST,OPTIONS",
      )
      expect(loopbackResponse.headers["access-control-allow-headers"]).toBe(
        "content-type",
      )

      expect(localhostResponse.statusCode).toBe(204)
      expect(localhostResponse.headers["access-control-allow-origin"]).toBe(
        "http://localhost:3000",
      )
      expect(localhostResponse.headers.vary).toBe("origin")
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }
  })
})
