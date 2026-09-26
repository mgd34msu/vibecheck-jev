import { z } from "zod";
import {
  cursorSchema,
  planRevisionSchema,
  recordRevisionSchema,
  sessionIdSchema,
  taskMapSchema,
  taskRecordSchema,
  taskStateSchema,
  timestampSchema,
  workIdSchema,
  workRecordSchema,
} from "./schemas.js";
import { compactStatusResponseSchema } from "./queries.js";
import { projectPolicySchema } from "./schemas.js";

export const verificationItemSchema = z.strictObject({
  check: z.string(),
  outcome: z.enum(["passed", "failed", "flagged", "review", "unavailable"]),
  reason: z.string(),
  entry_id: z.string(),
  task_id: z.string().optional(),
  work_id: z.string().optional(),
  reported_status: z.string().optional(),
  applied_status: z.string().optional(),
});
const verification = z.array(verificationItemSchema).optional();

export const mutationFooterSchema = z.strictObject({
  cursor: cursorSchema,
  plan_revision: planRevisionSchema,
  map_hint: z.literal("include_map:true"),
});
export type MutationFooter = z.infer<typeof mutationFooterSchema>;
const footer = mutationFooterSchema.shape;

export const projectJoinResponseSchema = z.strictObject({
  ...footer,
  session_id: sessionIdSchema,
  snapshot: compactStatusResponseSchema,
});
export const planMutationResponseSchema = z.strictObject({
  ...footer,
  task_map: taskMapSchema,
  tasks: z.record(
    z.string(),
    z.strictObject({
      revision: recordRevisionSchema,
      status: taskStateSchema,
      owner_work_id: workIdSchema.optional(),
    }),
  ),
  policy: projectPolicySchema.optional(),
  verification,
});
export const planAckResponseSchema = z.strictObject({
  ...footer,
  session_id: sessionIdSchema,
  acknowledged_plan_revision: planRevisionSchema,
  acknowledged_at: timestampSchema,
});
export const workClaimResponseSchema = z.strictObject({
  ...footer,
  task: taskRecordSchema,
  work: workRecordSchema,
  verification,
});
export const workUpdateResponseSchema = z.strictObject({
  ...footer,
  tasks: z.array(taskRecordSchema),
  work: z.array(workRecordSchema),
  verification,
});
export type ProjectJoinResult = z.infer<typeof projectJoinResponseSchema>;
export type PlanMutationResult = z.infer<typeof planMutationResponseSchema>;
export type PlanAckResult = z.infer<typeof planAckResponseSchema>;
export type WorkClaimResult = z.infer<typeof workClaimResponseSchema>;
export type WorkUpdateResult = z.infer<typeof workUpdateResponseSchema>;
