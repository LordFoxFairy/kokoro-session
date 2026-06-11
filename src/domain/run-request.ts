import { z } from "zod"

// run 请求信封（session 写出到 kokoro:runs:requests）。run_id 由 session 生成。
export const runRequestSchema = z
  .object({
    kind: z.literal("run.request"),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    conversation_id: z.string().min(1),
    input: z.string().min(1),
    execution_style: z.enum(["fast", "thinking"]).optional(),
  })
  .strict()
