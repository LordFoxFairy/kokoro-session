import { z } from "zod"

// approve/reject 针对待批工具;cancel 放弃整个 run(worker 取消 run task,解阻塞所有待批门)。
export const runControlDecisionSchema = z.enum(["approve", "reject", "cancel"])

export type RunControlDecision = z.infer<typeof runControlDecisionSchema>

// 工具参数为 tool 专属、session 不知其形状：以 record 透传，真实校验在 agent 的 Pydantic 边界。
export const runControlArgsSchema = z.record(z.string(), z.unknown())

// HITL 反向通道控制信封（session 写出到 kokoro:run:<id>:control）。args 仅 approve 有意义：
// 用户在审批暂停时编辑后的工具参数，整体替换模型原参数。
export const controlEventSchema = z
  .object({
    kind: z.literal("control"),
    decision: runControlDecisionSchema,
    args: runControlArgsSchema.optional(),
  })
  .strict()

// 边界入参（HTTP query 等）解析：错误体定位到 decision 字段，非法/缺失抛 ZodError。
const decisionInputSchema = z.object({ decision: runControlDecisionSchema })
export function parseRunControlDecision(raw: string | null): RunControlDecision {
  return decisionInputSchema.parse({ decision: raw }).decision
}

// 可选 args query（urlencoded JSON）解析：非法 JSON / 非对象抛 ZodError → 顶层归 400。
const argsInputSchema = z
  .string()
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "args is not valid JSON", path: ["args"] })
      return z.NEVER
    }
  })
  .pipe(runControlArgsSchema)
export function parseRunControlArgs(raw: string | null): Record<string, unknown> | undefined {
  return raw === null ? undefined : argsInputSchema.parse(raw)
}
