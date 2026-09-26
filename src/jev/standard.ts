// Ledger records rendered as the text a check reads: the plan, one task with
// its goal and acceptance criteria, accepted exceptions, rules,
// authorizations and accepted reasons for stopping.

import type { PlanDetails } from "../details.js";
import type {
  ProjectPolicy,
  TaskDetails,
  TaskRecord,
  WorkRecord,
} from "../schemas.js";

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function taskText(task: TaskRecord, details?: TaskDetails): string {
  const lines = [`Task ${task.id}: ${task.label}`];
  if (details?.goal !== undefined) lines.push(`Goal: ${details.goal}`);
  if (details?.criteria !== undefined && details.criteria.length > 0)
    lines.push(`Acceptance criteria:\n${bullets(details.criteria)}`);
  if (details?.rules !== undefined && details.rules.length > 0)
    lines.push(`Task rules:\n${bullets(details.rules)}`);
  return lines.join("\n");
}

export function planText(
  tasks: Iterable<TaskRecord>,
  details: PlanDetails,
): string {
  const lines: string[] = [];
  if (details.policy?.goal !== undefined)
    lines.push(`Plan goal: ${details.policy.goal}`);
  const open = [...tasks].filter((task) => task.status !== "cancelled");
  lines.push("Tasks:");
  for (const task of open) {
    const entry = details.tasks.get(task.id);
    const criteria =
      entry?.criteria === undefined || entry.criteria.length === 0
        ? ""
        : ` (criteria: ${entry.criteria.join("; ")})`;
    const goal = entry?.goal === undefined ? "" : ` Goal: ${entry.goal}`;
    lines.push(
      `- ${task.id} [${task.status}]: ${task.label}.${goal}${criteria}`,
    );
  }
  return lines.join("\n");
}

export function exceptionsText(
  details: Iterable<TaskDetails | undefined>,
): string | undefined {
  const lines: string[] = [];
  for (const entry of details)
    for (const exception of entry?.exceptions ?? [])
      lines.push(
        `${exception.description}${exception.paths === undefined ? "" : ` (paths: ${exception.paths.join(", ")})`}`,
      );
  return lines.length === 0 ? undefined : bullets(lines);
}

export function rulesText(
  policy: ProjectPolicy | undefined,
  details: Iterable<TaskDetails | undefined>,
): string | undefined {
  const rules = [...(policy?.rules ?? [])];
  for (const entry of details) rules.push(...(entry?.rules ?? []));
  return rules.length === 0 ? undefined : bullets([...new Set(rules)]);
}

export function authorizationsText(
  policy: ProjectPolicy | undefined,
): string | undefined {
  const items = policy?.authorizations ?? [];
  return items.length === 0
    ? undefined
    : `Authorizations recorded for this project:\n${bullets(items)}`;
}

export function allowedReasonsText(
  policy: ProjectPolicy | undefined,
  details: Iterable<TaskDetails | undefined>,
): string | undefined {
  const reasons = [...(policy?.stop_reasons ?? [])];
  for (const entry of details)
    for (const exception of entry?.exceptions ?? [])
      reasons.push(`accepted exception: ${exception.description}`);
  return reasons.length === 0
    ? undefined
    : `Accepted reasons for leaving work:\n${bullets(reasons)}`;
}

export function workText(
  task: TaskRecord,
  details: TaskDetails | undefined,
  work: WorkRecord,
): string {
  return [
    taskText(task, details),
    `Status: ${work.status}.`,
    work.blocker === null ? "No blocker." : `Blocker: ${work.blocker}.`,
    work.location.paths.length === 0
      ? ""
      : `Paths: ${work.location.paths.join(", ")}.`,
  ]
    .filter((line) => line.length > 0)
    .join(" ");
}
