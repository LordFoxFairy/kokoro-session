// run 相关 redis 流地址：请求流 + 每 run 的事件流/控制流命名，三条链路共享的基础。

export const REQUESTS_STREAM = "kokoro:runs:requests"

export function runEventsStream(runId: string): string {
  return `kokoro:run:${runId}:events`
}

// HITL 反向通道：web 的批准/拒绝经此流送达 agent worker（被门控工具在其上阻塞等决定）。
export function controlStream(runId: string): string {
  return `kokoro:run:${runId}:control`
}
