// run 相关 redis 流地址：请求流 + 每 run 的事件流。HITL 反向通道（resume/cancel）复用请求流，
// 不再有 per-run 控制流。

export const REQUESTS_STREAM = "kokoro:runs:requests"

export function runEventsStream(runId: string): string {
  return `kokoro:run:${runId}:events`
}
