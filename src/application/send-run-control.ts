import { runCancelSchema, runResumeSchema, type ResumeDecision } from "../domain/run-control"
import type { StreamProtocol } from "./event-stream"
import { REQUESTS_STREAM } from "./stream-names"

// HITL 反向通道：把审批/取消翻译成 agent 入站消息（run.resume/run.cancel），发到 run.request 同一
// 请求流。agent worker 按 run_id 从共享 store 重建并据 checkpoint 续接（任一 pod 可处理，靠
// RunStateStore 原子去重 / 终态认领防重复执行）。
export type RunControlInput =
  | { kind: "run.cancel"; runId: string; sessionId: string }
  | { kind: "run.resume"; runId: string; sessionId: string; decisions: ResumeDecision[] }

export async function sendRunControl(
  input: RunControlInput,
  dependencies: { bus: StreamProtocol },
): Promise<void> {
  // 出站前过严格 schema：拒绝空 decisions / 未知键，不把脏控制消息写进请求流。
  const message =
    input.kind === "run.cancel"
      ? runCancelSchema.parse({
          kind: "run.cancel",
          run_id: input.runId,
          session_id: input.sessionId,
        })
      : runResumeSchema.parse({
          kind: "run.resume",
          run_id: input.runId,
          session_id: input.sessionId,
          decisions: input.decisions,
        })
  await dependencies.bus.publish(REQUESTS_STREAM, message)
}
