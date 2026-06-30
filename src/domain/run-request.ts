import { z } from "zod"

import { agentRunInputSchema } from "./agent-run-input"

// run 请求信封（session 写出到 kokoro:runs:requests）。run_id 由 session 生成。
export const runRequestSchema = z
  .object({
    kind: z.literal("run.request"),
    site_id: z.string().min(1),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    agent_run_input: agentRunInputSchema,
  })
  .strict()

export type RunRequest = z.infer<typeof runRequestSchema>
