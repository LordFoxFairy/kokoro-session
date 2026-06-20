import { runRequestSchema } from "../domain/run-request"
import type { StreamProtocol } from "./event-stream"
import { REQUESTS_STREAM } from "./stream-names"

// run_id 生成器：可注入以便测试确定性（start-run 的测试 seam，非被 infra 实现的端口）。
type RunIdFactory = () => string

// session 不再 HTTP 同步调 agent：生成 run_id，把合法 run.request 发到请求流，
// agent worker 消费后把原始事件回写到 run 事件流，由 relayRun 归一化进 replay。

export type StartRunInput = {
  sessionId: string
  conversationId?: string
  input: string
  executionStyle?: string
  permissionMode?: string
}

export type StartRunDependencies = {
  bus: StreamProtocol
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

  // 出站请求前先过严格 schema：拒绝空 input / 多余键，不将脏请求写进流。
  const request = runRequestSchema.parse({
    kind: "run.request",
    run_id: runId,
    session_id: input.sessionId,
    conversation_id: conversationId,
    input: input.input,
    ...(input.executionStyle !== undefined
      ? { execution_style: input.executionStyle }
      : {}),
    ...(input.permissionMode !== undefined
      ? { permission_mode: input.permissionMode }
      : {}),
  })

  await dependencies.bus.publish(REQUESTS_STREAM, request)
  return { runId }
}
