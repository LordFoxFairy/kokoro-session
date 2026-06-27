import { z } from "zod"

// HITL 审批决策：镜像 kokoro-agent inbound.py 的 ResumeDecision 判别联合。各型按 type 判别、恰好
// 携带其必需字段；每个决策显式带 tool_id（同帧多工具的归属键，agent 据此重排对齐到 pending 顺序）。
const approveDecisionSchema = z
  .object({ type: z.literal("approve"), tool_id: z.string().min(1) })
  .strict()
const editDecisionSchema = z
  .object({
    type: z.literal("edit"),
    tool_id: z.string().min(1),
    // 用户改后的工具调用，整体替换模型原参数；具体形状由 agent Pydantic 边界校验，session 仅透传。
    edited_action: z.record(z.string(), z.unknown()),
  })
  .strict()
const rejectDecisionSchema = z
  .object({ type: z.literal("reject"), tool_id: z.string().min(1), message: z.string() })
  .strict()
const respondDecisionSchema = z
  .object({ type: z.literal("respond"), tool_id: z.string().min(1), message: z.string() })
  .strict()

export const resumeDecisionSchema = z.discriminatedUnion("type", [
  approveDecisionSchema,
  editDecisionSchema,
  rejectDecisionSchema,
  respondDecisionSchema,
])
export type ResumeDecision = z.infer<typeof resumeDecisionSchema>

// 出站到 agent 请求流（kokoro:runs:requests，与 run.request 同流）的 HITL 反向消息。run_id 由
// session 据 URL 注入。run.resume 携逐工具决策恢复暂停；run.cancel 放弃整个 run。
export const runResumeSchema = z
  .object({
    kind: z.literal("run.resume"),
    run_id: z.string().min(1),
    decisions: z.array(resumeDecisionSchema).min(1),
  })
  .strict()
export const runCancelSchema = z
  .object({ kind: z.literal("run.cancel"), run_id: z.string().min(1) })
  .strict()

// HTTP 入站体（web POST /control 的 JSON body）：与出站消息同形但不含 run_id（由路径参数注入）。
export const runControlBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.cancel") }).strict(),
  z
    .object({
      kind: z.literal("run.resume"),
      decisions: z.array(resumeDecisionSchema).min(1),
    })
    .strict(),
])
export type RunControlBody = z.infer<typeof runControlBodySchema>
