import { controlEventSchema, type RunControlDecision } from "../domain/run-control"
import type { StreamProtocol } from "./event-stream"
import { controlStream } from "./stream-names"

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
