import { z } from "zod"

// A2UI v0_9 operation（session→web 线上格式）。对齐 @a2ui/web_core 的 A2uiMessage。
// 组件项除必填 id/component 外按各组件 schema 放行（passthrough），与 @a2ui 一致。

const a2uiComponentSchema = z
  .object({ id: z.string().min(1), component: z.string().min(1) })
  .passthrough()

const createSurfaceOp = z
  .object({
    version: z.literal("v0.9"),
    createSurface: z.object({ surfaceId: z.string().min(1), catalogId: z.string().min(1) }).strict(),
  })
  .strict()

const updateComponentsOp = z
  .object({
    version: z.literal("v0.9"),
    updateComponents: z
      .object({ surfaceId: z.string().min(1), components: z.array(a2uiComponentSchema) })
      .strict(),
  })
  .strict()

const updateDataModelOp = z
  .object({
    version: z.literal("v0.9"),
    updateDataModel: z
      .object({ surfaceId: z.string().min(1), path: z.string().optional(), value: z.unknown() })
      .strict(),
  })
  .strict()

export const a2uiOpSchema = z.union([createSurfaceOp, updateComponentsOp, updateDataModelOp])

export type A2uiOp = z.infer<typeof a2uiOpSchema>
export type A2uiComponent = z.infer<typeof a2uiComponentSchema>
