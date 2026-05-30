import type { StreamPort } from "../infrastructure/stream-port"
import type { ReplayStore } from "../infrastructure/replay_store"

// 应用层端口聚合，方便接口层注入。
export type { StreamPort, ReplayStore }

// run_id 生成器：可注入以便测试确定性。
export interface RunIdFactory {
  (): string
}
