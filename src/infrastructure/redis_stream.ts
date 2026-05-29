export type AgentEvent = {
  event: string
  runId: string
  [key: string]: unknown
}

export interface AgentStreamWriter {
  append(stream: string, event: AgentEvent): Promise<void>
}

export interface AgentStreamReader {
  read(stream: string): Promise<AgentEvent[]>
}

const streamStore = new Map<string, AgentEvent[]>()

export const memoryStreamWriter: AgentStreamWriter = {
  async append(stream, event) {
    const previous = streamStore.get(stream) ?? []
    streamStore.set(stream, [...previous, event])
  },
}

export const memoryStreamReader: AgentStreamReader = {
  async read(stream) {
    return streamStore.get(stream) ?? []
  },
}
