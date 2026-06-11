import { runRequestSchema } from "../domain/run-request"
import type { ReplayStore, StreamPort } from "./ports"
import type { Normalizer } from "./normalize"

// run_id 生成器：可注入以便测试确定性（start-run 的测试 seam，非被 infra 实现的端口）。
type RunIdFactory = () => string

// session 不再 HTTP 同步调 agent：生成 run_id，把合法 run.request 发到请求流，
// agent worker 消费后把原始事件回写到 run 事件流，由 relayRun 归一化进 replay。

export const REQUESTS_STREAM = "kokoro:runs:requests"

export function runEventsStream(runId: string): string {
  return `kokoro:run:${runId}:events`
}

export type StartRunInput = {
  sessionId: string
  conversationId?: string
  input: string
  executionStyle?: string
}

export type StartRunDependencies = {
  streamPort: StreamPort
  newRunId?: RunIdFactory
}

function defaultRunId(): string {
  return `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

export async function startRun(
  input: StartRunInput,
  dependencies: StartRunDependencies,
): Promise<{ runId: string }> {
  const runId = (dependencies.newRunId ?? defaultRunId)()
  const conversationId = input.conversationId ?? input.sessionId

  // 出站请求前先过严格 schema：拒绝空 input / 多余键，绝不把脏请求写进流。
  const request = runRequestSchema.parse({
    kind: "run.request",
    run_id: runId,
    session_id: input.sessionId,
    conversation_id: conversationId,
    input: input.input,
    ...(input.executionStyle !== undefined
      ? { execution_style: input.executionStyle }
      : {}),
  })

  await dependencies.streamPort.publish(REQUESTS_STREAM, request)
  return { runId }
}

export type RelayRunInput = {
  streamPort: StreamPort
  replayStore: ReplayStore
  normalizer: Normalizer
  sessionId: string
  runId: string
}

// 消费某 run 的事件流 → 归一化 → 追加 replay。遇到终态（run.completed/run.failed）收束，
// 避免连接一直挂等。重复 seq 由 normalizer 去重，断连/空流不崩。
export async function relayRun(input: RelayRunInput): Promise<void> {
  const stream = runEventsStream(input.runId)
  for await (const item of input.streamPort.subscribe(stream)) {
    const envelopes = input.normalizer.ingest(item.event)
    if (envelopes.length > 0) {
      await input.replayStore.append(input.sessionId, envelopes)
    }
    if (envelopes.some((e) => e.event === "run.completed" || e.event === "run.failed")) {
      return
    }
  }
}
