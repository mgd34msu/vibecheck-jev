// Plan details: the project's policy (goal, standing rules, authorizations,
// accepted reasons for stopping) and each task's goal, acceptance criteria,
// rules, accepted exceptions and parent. They are the standard every check
// judges against.
//
// Details live in their own table, one immutable row per changed entry and
// plan revision, so task records keep the schema earlier releases read.

import { z } from "zod";
import { encode, type Transaction } from "./db.js";
import { BoardError } from "./errors.js";
import {
  projectPolicySchema,
  taskDetailsSchema,
  taskIdSchema,
  type ProjectPolicy,
  type TaskDetails,
  type TaskId,
} from "./schemas.js";

export interface PlanDetails {
  readonly policy: ProjectPolicy | undefined;
  readonly tasks: ReadonlyMap<TaskId, TaskDetails>;
}

const detailRowSchema = z.object({
  scope: z.enum(["project", "task"]),
  id: z.string(),
  body: z.string(),
});

/** The details in force at a plan revision (the current one by default). */
export function planDetails(
  tx: Transaction,
  planRevision?: number,
): PlanDetails {
  const revision =
    planRevision ?? tx.findProject(tx.projectId)?.plan_revision ?? 0;
  const rows = tx.queryRows(
    detailRowSchema,
    `SELECT scope, id, body FROM plan_details AS detail
     WHERE project_id = ? AND plan_revision = (
       SELECT MAX(plan_revision) FROM plan_details AS latest
       WHERE latest.project_id = detail.project_id AND latest.scope = detail.scope
         AND latest.id = detail.id AND latest.plan_revision <= ?)
     ORDER BY scope, id`,
    [tx.projectId, revision],
  );
  let policy: ProjectPolicy | undefined;
  const tasks = new Map<TaskId, TaskDetails>();
  for (const row of rows) {
    const body: unknown = JSON.parse(row.body);
    if (row.scope === "project") policy = projectPolicySchema.parse(body);
    else tasks.set(taskIdSchema.parse(row.id), taskDetailsSchema.parse(body));
  }
  return { policy, tasks };
}

function hasContent(details: object): boolean {
  return Object.values(details).some((value) => value !== undefined);
}

/** Picks the detail fields present in a task definition or update. */
export function detailPatch(source: TaskDetails): TaskDetails | undefined {
  const patch: TaskDetails = {
    ...(source.goal === undefined ? {} : { goal: source.goal }),
    ...(source.criteria === undefined ? {} : { criteria: source.criteria }),
    ...(source.rules === undefined ? {} : { rules: source.rules }),
    ...(source.exceptions === undefined
      ? {}
      : { exceptions: source.exceptions }),
    ...(source.parent === undefined ? {} : { parent: source.parent }),
  };
  return hasContent(patch) ? patch : undefined;
}

/**
 * Applies detail patches for a new plan revision. Fields a patch carries
 * replace the stored ones; fields it omits are kept, so callers that never
 * send details leave them untouched.
 */
export function saveDetails(
  tx: Transaction,
  planRevision: number,
  taskIds: ReadonlySet<TaskId>,
  patches: ReadonlyMap<TaskId, TaskDetails>,
  policy: ProjectPolicy | undefined,
): PlanDetails {
  const current = planDetails(tx, planRevision - 1);
  const tasks = new Map(current.tasks);
  for (const [taskId, patch] of patches)
    tasks.set(taskId, { ...tasks.get(taskId), ...patch });
  for (const [taskId, details] of tasks) {
    if (details.parent === undefined) continue;
    if (!taskIds.has(details.parent))
      throw new BoardError("invalid", "Unknown task in parent", {
        task_id: details.parent,
      });
    const seen = new Set<TaskId>([taskId]);
    let parent: TaskId | undefined = details.parent;
    while (parent !== undefined) {
      if (seen.has(parent))
        throw new BoardError(
          "invalid",
          "Task parent references contain a cycle",
          {
            task_id: taskId,
          },
        );
      seen.add(parent);
      parent = tasks.get(parent)?.parent;
    }
  }
  for (const taskId of patches.keys()) {
    const details = tasks.get(taskId);
    if (details === undefined) continue;
    tx.execute(
      "INSERT INTO plan_details(project_id, scope, id, plan_revision, body) VALUES(?, 'task', ?, ?, ?)",
      [tx.projectId, taskId, planRevision, encode(details)],
    );
  }
  let merged = current.policy;
  if (policy !== undefined) {
    merged = { ...current.policy, ...policy };
    tx.execute(
      "INSERT INTO plan_details(project_id, scope, id, plan_revision, body) VALUES(?, 'project', ?, ?, ?)",
      [tx.projectId, tx.projectId, planRevision, encode(merged)],
    );
  }
  return { policy: merged, tasks };
}

/** Children of a task: the tasks whose details name it as parent. */
export function childrenOf(details: PlanDetails, taskId: TaskId): TaskId[] {
  return [...details.tasks]
    .filter(([, entry]) => entry.parent === taskId)
    .map(([id]) => id)
    .sort();
}
