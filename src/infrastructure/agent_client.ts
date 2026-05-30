import type { AgentRunStreamClient } from "../application/ports"
import { parseSessionEvent, type SessionEvent } from "../domain/events"
import type { StartRunInput } from "../domain/sessions"

export type AgentClientConfig = {
  baseUrl: string
}

async function* readEventStream(response: Response): AsyncIterable<SessionEvent> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error("agent response body is missing")
  }

  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary < 0) {
        break
      }

      const chunk = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      const dataLine = chunk
        .split("\n")
        .find((line) => line.startsWith("data: "))

      if (!dataLine) {
        continue
      }

      const payload = JSON.parse(dataLine.slice(6)) as unknown
      const event = parseSessionEvent(payload)

      yield event

      // agent 侧当前按单次 run 输出有限事件流；遇到终态后主动收束，避免 session 一直挂等连接关闭。
      if (event.event === "run.completed" || event.event === "run.failed") {
        return
      }
    }
  }
}

export function createAgentRunStreamClient(
  config: AgentClientConfig,
): AgentRunStreamClient {
  return {
    async *streamRun(input: StartRunInput) {
      const response = await fetch(
        `${config.baseUrl}/sessions/${input.sessionId}/runs/stream`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            conversation_id: input.conversationId,
            input: input.input,
            execution_style: input.executionStyle,
          }),
        },
      )

      if (!response.ok) {
        throw new Error(`agent request failed with status ${response.status}`)
      }

      yield* readEventStream(response)
    },
  }
}
