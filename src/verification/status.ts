// What status shows from verification history: each task as reported and as
// verified, and an attention list that leads the response with what needs a
// person or an agent now.

import { z } from "zod";
import type { Transaction } from "../db.js";
import type { TaskRecord, WorkRecord } from "../schemas.js";
import { queryEntries, type Entry, type VerdictEntry } from "./store.js";

export const attentionItemSchema = z.strictObject({
  kind: z.enum([
    "held_done",
    "blocker",
    "stalled",
    "overlap",
    "unverified_done",
    "flag",
  ]),
  check: z.string(),
  reason: z.string(),
  entry_id: z.string(),
  at: z.string(),
  task_id: z.string().optional(),
  work_id: z.string().optional(),
  needs: z.string().optional(),
  urgency: z.string().optional(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const taskVerificationSchema = z.strictObject({
  reported: z.string(),
  verified: z.enum(["verified", "held", "unverified"]),
  reason: z.string(),
  entry_id: z.string(),
  at: z.string(),
});
export type TaskVerification = z.infer<typeof taskVerificationSchema>;

export const DONE_CHECK_IDS = new Set([
  "vibecheck.claims-done",
  "vibecheck.parent-rollup",
  "vibecheck.commit-paths",
  "vibecheck.exception-check",
]);

const FLAG_CHECKS = new Set([
  "vibecheck.stop-reason",
  "vibecheck.deferral",
  "vibecheck.gives-up",
  "vibecheck.handoff-complete",
  "vibecheck.commit-honesty",
  "vibecheck.brief-scope",
  "vibecheck.task-duplicate",
  "vibecheck.plan-coverage",
]);

const OPEN_WORK = new Set([
  "pending",
  "in_progress",
  "blocked",
  "awaiting_integration",
]);
const MAX_ITEMS = 50;
const REASON_LIMIT = 300;

function clip(text: string): string {
  return text.length > REASON_LIMIT
    ? `${text.slice(0, REASON_LIMIT)}...`
    : text;
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const field = Object.entries(value).find(([name]) => name === key)?.[1];
  return typeof field === "string" ? field : undefined;
}

function item(
  kind: AttentionItem["kind"],
  entry: VerdictEntry,
  extra: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    kind,
    check: entry.body.battery_id,
    reason: clip(entry.body.reason),
    entry_id: entry.id,
    at: entry.created_at,
    ...(entry.task_id === null ? {} : { task_id: entry.task_id }),
    ...(entry.work_id === null ? {} : { work_id: entry.work_id }),
    ...extra,
  };
}

export interface VerificationView {
  readonly attention: AttentionItem[];
  readonly tasks: Map<string, TaskVerification>;
}

/** Reads recent verification history for a project into status fields. */
export function verificationView(
  tx: Transaction,
  tasks: ReadonlyMap<string, TaskRecord>,
): VerificationView {
  const entries = queryEntries(tx, {
    projectId: tx.projectId,
    kinds: ["verdict", "unavailable"],
    newest: true,
    limit: 2000,
  });
  const view: VerificationView = { attention: [], tasks: new Map() };
  if (entries.length === 0) return view;
  const work = new Map<string, WorkRecord>(
    tx.allWork().map((record) => [record.id, record]),
  );
  const workOpen = (id: string | null) =>
    id !== null && OPEN_WORK.has(work.get(id)?.status ?? "");
  const verdicts = entries.filter(
    (entry): entry is VerdictEntry => entry.kind === "verdict",
  );

  // Each task's latest done check: every done verdict written with it.
  const doneGroups = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (entry.task_id === null) continue;
    const isDone =
      (entry.kind === "verdict" || entry.kind === "unavailable") &&
      DONE_CHECK_IDS.has(entry.body.battery_id);
    if (!isDone) continue;
    const group = doneGroups.get(entry.task_id);
    if (group === undefined) doneGroups.set(entry.task_id, [entry]);
    else if (group[0]?.created_at === entry.created_at) group.push(entry);
  }
  const held: AttentionItem[] = [];
  const unverified: AttentionItem[] = [];
  for (const [taskId, group] of doneGroups) {
    const task = tasks.get(taskId);
    if (task === undefined) continue;
    const failed = group.find(
      (entry): entry is VerdictEntry =>
        entry.kind === "verdict" && entry.body.outcome === "failed",
    );
    const doubtful = group.find(
      (entry) =>
        entry.kind === "unavailable" ||
        (entry.kind === "verdict" && entry.body.outcome === "review"),
    );
    const first = group[0];
    if (first === undefined) continue;
    const state: TaskVerification["verified"] =
      failed !== undefined
        ? "held"
        : doubtful !== undefined
          ? "unverified"
          : "verified";
    const source = failed ?? doubtful ?? first;
    const reason =
      source.kind === "verdict"
        ? source.body.reason
        : source.kind === "unavailable"
          ? `reading unavailable: ${source.body.error}`
          : "";
    view.tasks.set(taskId, {
      reported: "complete",
      verified: state,
      reason: clip(reason),
      entry_id: source.id,
      at: source.created_at,
    });
    if (failed !== undefined && task.status !== "complete")
      held.push(item("held_done", failed));
    if (
      state === "unverified" &&
      task.status === "complete" &&
      doubtful !== undefined
    )
      unverified.push({
        kind: "unverified_done",
        check:
          doubtful.kind === "verdict" || doubtful.kind === "unavailable"
            ? doubtful.body.battery_id
            : "",
        reason: clip(reason),
        entry_id: doubtful.id,
        at: doubtful.created_at,
        task_id: taskId,
      });
  }

  const latest = new Map<string, VerdictEntry>();
  for (const entry of verdicts) {
    const key = `${entry.body.battery_id}|${entry.work_id ?? entry.task_id ?? "plan"}|${entry.body.evidence?.ref ?? ""}`;
    if (!latest.has(key)) latest.set(key, entry);
  }
  const blockers: AttentionItem[] = [];
  const stalled: AttentionItem[] = [];
  const overlaps: AttentionItem[] = [];
  const flags: AttentionItem[] = [];
  let planFlagSeen = false;
  for (const entry of latest.values()) {
    const battery = entry.body.battery_id;
    if (battery === "vibecheck.blocker-triage") {
      if (
        entry.work_id === null ||
        work.get(entry.work_id)?.status !== "blocked"
      )
        continue;
      const needs = stringField(entry.body.decision, "needs");
      const urgency = stringField(entry.body.decision, "urgency");
      blockers.push(
        item("blocker", entry, {
          ...(needs === undefined ? {} : { needs }),
          ...(urgency === undefined ? {} : { urgency }),
        }),
      );
      continue;
    }
    if (entry.body.outcome !== "flagged") continue;
    if (battery === "vibecheck.stalled") {
      if (workOpen(entry.work_id)) stalled.push(item("stalled", entry));
      continue;
    }
    if (battery === "vibecheck.claim-overlap") {
      const other = entry.body.evidence?.ref.replace(/^work:/u, "") ?? null;
      if (workOpen(entry.work_id) && workOpen(other))
        overlaps.push(item("overlap", entry));
      continue;
    }
    if (!FLAG_CHECKS.has(battery)) continue;
    if (entry.work_id !== null) {
      if (workOpen(entry.work_id)) flags.push(item("flag", entry));
    } else if (entry.task_id !== null) {
      const task = tasks.get(entry.task_id);
      if (
        task !== undefined &&
        task.status !== "complete" &&
        task.status !== "cancelled"
      )
        flags.push(item("flag", entry));
    } else if (!planFlagSeen) {
      planFlagSeen = true;
      flags.push(item("flag", entry));
    }
  }
  const urgent = (entry: AttentionItem) =>
    entry.needs === "user" || entry.urgency === "high";
  const rank: Record<string, number> = { high: 0, normal: 1, low: 2 };
  blockers.sort(
    (left, right) =>
      Number(!urgent(left)) - Number(!urgent(right)) ||
      (rank[left.urgency ?? "low"] ?? 3) - (rank[right.urgency ?? "low"] ?? 3),
  );
  view.attention.push(
    ...held,
    ...blockers.filter(urgent),
    ...stalled,
    ...overlaps,
    ...unverified,
    ...flags,
    ...blockers.filter((entry) => !urgent(entry)),
  );
  view.attention.splice(MAX_ITEMS);
  return view;
}
