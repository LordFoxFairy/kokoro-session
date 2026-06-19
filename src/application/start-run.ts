import { runRequestSchema } from "../domain/run-request"
import {
  controlEventSchema,
  type RunControlDecision,
} from "../domain/run-control"
import type { ReplayStore, StreamProtocol } from "./event-stream"
import type { Normalizer } from "./normalize"

// run_id 生成器：可注入以便测试确定性（start-run 的测试 seam，非被 infra 实现的端口）。
type RunIdFactory = () => string

// session 不再 HTTP 同步调 agent：生成 run_id，把合法 run.request 发到请求流，
// agent worker 消费后把原始事件回写到 run 事件流，由 relayRun 归一化进 replay。

export const REQUESTS_STREAM = "kokoro:runs:requests"

export function runEventsStream(runId: string): string {
  return `kokoro:run:${runId}:events`
}

// HITL 反向通道：web 的批准/拒绝经此流送达 agent worker（被门控工具在其上阻塞等决定）。
export function controlStream(runId: string): string {
  return `kokoro:run:${runId}:control`
}

export async function sendRunControl(
  input: { runId: string; decision: RunControlDecision; args?: Record<string, unknown> },
  dependencies: { bus: StreamProtocol },
): Promise<void> {
  // 出站前过严格 schema：拒绝非法 decision / 多余键，不将脏控制事件写进流。args 仅 approve 透传。
  const event = controlEventSchema.parse({
    kind: "control",
    decision: input.decision,
    ...(input.args !== undefined ? { args: input.args } : {}),
  })
  await dependencies.bus.publish(controlStream(input.runId), event)
}

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

export type RelayRunInput = {
  bus: StreamProtocol
  replayStore: ReplayStore
  normalizer: Normalizer
  sessionId: string
  runId: string
}

// 消费某 run 的事件流 → 归一化 → 追加 replay。遇到终态（run.completed/run.failed）收束，
// 避免连接一直挂等。重复 seq 由 normalizer 去重，断连/空流不崩。
export async function relayRun(input: RelayRunInput): Promise<void> {
  const stream = runEventsStream(input.runId)
  for await (const item of input.bus.subscribe(stream)) {
    let envelopes: ReturnType<Normalizer["ingest"]>
    try {
      envelopes = input.normalizer.ingest(item.event)
    } catch (error) {
      // 跳过单条脏事件而不中断整条流：否则其后的终态永不落 replay，web 该轮停留在「进行中」。
      console.error("skipping dirty agent event", input.runId, error)
      continue
    }
    if (envelopes.length > 0) {
      await input.replayStore.append(input.sessionId, envelopes)
    }
    if (envelopes.some((e) => e.event === "run.completed" || e.event === "run.failed")) {
      // 终态后控制流不再被读取：删除它，避免审批/拒绝指令在 redis 中无限留存。
      await input.bus.delete(controlStream(input.runId))
      return
    }
  }
}
