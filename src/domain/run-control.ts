import { z } from "zod"

// approve/reject 针对待批工具;cancel 放弃整个 run(worker 取消 run task,解阻塞所有待批门)。
export const runControlDecisionSchema = z.enum(["approve", "reject", "cancel"])

export type RunControlDecision = z.infer<typeof runControlDecisionSchema>

// HITL 反向通道控制信封（session 写出到 kokoro:run:<id>:control）。
export const controlEventSchema = z
  .object({
    kind: z.literal("control"),
    decision: runControlDecisionSchema,
  })
  .strict()

// 边界入参（HTTP query 等）解析：错误体定位到 decision 字段，非法/缺失抛 ZodError。
const decisionInputSchema = z.object({ decision: runControlDecisionSchema })
export function parseRunControlDecision(raw: string | null): RunControlDecision {
  return decisionInputSchema.parse({ decision: raw }).decision
}
