// Checks the ledger runs on what agents report to it.
//
//   work_update to complete   claims-done against the task's goal, criteria
//                             and accepted exceptions, plus the commit-path,
//                             data-only exception and parent roll-up checks;
//                             a failure keeps the task open
//   work_update to blocked    stop-reason, deferral and blocker triage
//   release with a report     gives-up, stop-reason and deferral
//   handoff                   handoff-complete
//   progress with a report    stalled, once the claim has several updates
//   work_claim                claim-overlap against other open claims
//   plan_publish / plan_edit  brief-scope over the plan change, task-duplicate
//                             for added tasks, plan-coverage against the goal
//
// Readings run outside the database transaction; their verdicts are written
// with the change they judge. When no source answers, an "unavailable" entry
// is written instead of a verdict and the change is applied as reported.

import type { Database, Transaction } from "../db.js";
import { childrenOf, planDetails, type PlanDetails } from "../details.js";
import type {
  PlanEdit,
  PlanPublish,
  ProjectId,
  TaskId,
  TaskRecord,
  WorkChange,
  WorkId,
  WorkRecord,
  WorkUpdate,
} from "../schemas.js";
import {
  blockerTriageBattery,
  briefScopeBattery,
  claimOverlapBattery,
  claimsDoneBattery,
  commitHonestyBattery,
  deferralBattery,
  givesUpBattery,
  handoffBattery,
  planCoverageBattery,
  stalledBattery,
  stopReasonBattery,
  taskDuplicateBattery,
} from "../jev/batteries.js";
import {
  checkDataOnlyPaths,
  readCommit,
  touchesPaths,
  type CommitInfo,
} from "../jev/code.js";
import {
  deterministicEntry,
  entryFor,
  type EntryContext,
} from "../jev/entries.js";
import { checkEnabled } from "../jev/config.js";
import { runCheck, type Judgment } from "../jev/judgment.js";
import {
  allowedReasonsText,
  exceptionsText,
  planText,
  taskText,
  workText,
} from "../jev/standard.js";
import {
  appendEntry,
  queryEntries,
  type NewEntry,
  type Outcome,
  type Subject,
} from "./store.js";

export interface VerificationItem {
  readonly check: string;
  readonly outcome: Outcome | "unavailable";
  readonly reason: string;
  readonly entry_id: string;
  readonly task_id?: string;
  readonly work_id?: string;
  readonly reported_status?: string;
  readonly applied_status?: string;
}

interface Pending {
  readonly subject: Subject;
  readonly entry: NewEntry;
}

export interface WorkUpdatePlan {
  /** Work whose requested completion is held open, with the reason. */
  readonly holds: ReadonlyMap<WorkId, string>;
  readonly pending: readonly Pending[];
}

import { DONE_CHECK_IDS as DONE_CHECKS } from "./status.js";

const STALL_AFTER = 3;
const OVERLAP_LIMIT = 8;
const DUPLICATE_PAIR_LIMIT = 30;

interface ChangeContext {
  readonly change: WorkChange;
  readonly work: WorkRecord;
  readonly task: TaskRecord;
  readonly previousReports: readonly string[];
  readonly children: readonly { id: TaskId; verified: boolean }[];
}

function requestedStatus(change: WorkChange, work: WorkRecord): string {
  if (change.action === "release") return "released";
  if (change.action === "handoff") return work.status;
  return change.status ?? work.status;
}

function describe(entry: NewEntry): {
  check: string;
  outcome: Outcome | "unavailable";
  reason: string;
} {
  switch (entry.kind) {
    case "verdict":
      return {
        check: entry.body.battery_id,
        outcome: entry.body.outcome,
        reason: entry.body.reason,
      };
    case "unavailable":
      return {
        check: entry.body.battery_id,
        outcome: "unavailable",
        reason: `reading unavailable: ${entry.body.error}`,
      };
    default:
      return { check: entry.kind, outcome: "passed", reason: "" };
  }
}

export class LedgerVerifier {
  readonly judgment: Judgment;

  constructor(judgment: Judgment) {
    this.judgment = judgment;
  }

  /** Writes pending entries in the caller's transaction and summarizes them. */
  record(tx: Transaction, pending: readonly Pending[]): VerificationItem[] {
    return pending.map(({ subject, entry }) => {
      const id = appendEntry(tx, subject, entry);
      const summary = describe(entry);
      return {
        ...summary,
        entry_id: id,
        ...(subject.taskId == null ? {} : { task_id: subject.taskId }),
        ...(subject.workId == null ? {} : { work_id: subject.workId }),
        ...(entry.kind === "verdict" && entry.body.reported_status !== undefined
          ? { reported_status: entry.body.reported_status }
          : {}),
        ...(entry.kind === "verdict" && entry.body.applied_status !== undefined
          ? { applied_status: entry.body.applied_status }
          : {}),
      };
    });
  }

  // -------------------------------------------------------------------------
  // work_update
  // -------------------------------------------------------------------------

  async planWorkUpdate(
    database: Database,
    request: WorkUpdate,
    actorKey: string,
  ): Promise<WorkUpdatePlan | undefined> {
    const snapshot = await database.read(request.project_id, (tx) => {
      if (tx.getRequest(actorKey, request.request_id) !== undefined)
        return undefined;
      if (tx.findProject(tx.projectId) === undefined) return undefined;
      const details = planDetails(tx);
      const contexts: ChangeContext[] = [];
      for (const change of request.updates ?? []) {
        const work = tx.findWork(change.work_id);
        if (work === undefined) continue;
        const task = tx.findTask(work.task_id);
        if (task === undefined) continue;
        const previousReports = queryEntries(tx, {
          projectId: tx.projectId,
          workIds: [work.id],
          kinds: ["report"],
          newest: true,
          limit: 6,
        })
          .flatMap((entry) =>
            entry.kind === "report"
              ? [`${entry.body.status}: ${entry.body.report}`]
              : [],
          )
          .reverse();
        const children = childrenOf(details, task.id).map((id) => ({
          id,
          verified: isVerified(tx, id),
        }));
        contexts.push({ change, work, task, previousReports, children });
      }
      return { details, contexts, projectId: tx.projectId };
    });
    if (snapshot === undefined) return undefined;
    const holds = new Map<WorkId, string>();
    const pending: Pending[] = [];
    await Promise.all(
      snapshot.contexts.map(async (context) => {
        const result = await this.checkChange(
          snapshot.projectId,
          snapshot.details,
          context,
        );
        pending.push(...result.pending);
        if (result.hold !== undefined) holds.set(context.work.id, result.hold);
      }),
    );
    return { holds, pending };
  }

  private async checkChange(
    projectId: ProjectId,
    details: PlanDetails,
    context: ChangeContext,
  ): Promise<{ pending: Pending[]; hold?: string }> {
    const { change, work, task } = context;
    const subject: Subject = {
      projectId,
      taskId: task.id,
      workId: work.id,
      sessionId: work.session_id,
    };
    const taskDetails = details.tasks.get(task.id);
    const standard = taskText(task, taskDetails);
    const report = change.report;
    const status = requestedStatus(change, work);
    const pending: Pending[] = [];
    const add = (entry: NewEntry | undefined) => {
      if (entry !== undefined) pending.push({ subject, entry });
    };
    const base: EntryContext = {
      source: `ledger:work_update`,
      evidence: {
        kind: "work_update",
        ref: `work:${work.id}`,
        ...(report === undefined ? {} : { excerpt: report.slice(0, 500) }),
      },
    };

    if (change.action === "handoff") {
      if (report === undefined) {
        add(
          deterministicEntry(
            handoffBattery.id,
            { work: workText(task, taskDetails, work) },
            { block: true },
            { ...base, outcome: "flagged", reason: "handoff has no note" },
          ),
        );
        return { pending };
      }
      const input = { work: workText(task, taskDetails, work), note: report };
      const result = await runCheck(this.judgment, handoffBattery, input);
      add(
        entryFor(handoffBattery, input, result, {
          ...base,
          gate: false,
          reason: (decision) =>
            decision.missing.length === 0
              ? "the note carries open work, state, blockers and next step"
              : `the note leaves out: ${decision.missing.join(", ")}`,
        }),
      );
      return { pending };
    }

    if (status === "complete" && work.status !== "complete")
      return this.checkCompletion(projectId, details, context, subject, base);

    const allowed = allowedReasonsText(details.policy, [taskDetails]);
    if (status === "blocked") {
      const blocker =
        (change.action === undefined || change.action === "progress"
          ? change.blocker
          : undefined) ??
        work.blocker ??
        "";
      const message = [blocker, report]
        .filter((part) => part !== undefined && part.length > 0)
        .join("\n");
      const [reason, deferral, triage] = await Promise.all([
        runCheck(this.judgment, stopReasonBattery, {
          passage: message,
          ...(allowed === undefined ? {} : { allowed }),
        }),
        runCheck(this.judgment, deferralBattery, { standard, message }),
        runCheck(this.judgment, blockerTriageBattery, {
          task: standard,
          blocker: message,
        }),
      ]);
      add(
        entryFor(
          stopReasonBattery,
          { passage: message, ...(allowed === undefined ? {} : { allowed }) },
          reason,
          {
            ...base,
            gate: false,
            reason: (decision) =>
              `reason reads as ${decision.kind} (${decision.confidence.toFixed(2)})`,
          },
        ),
      );
      add(
        entryFor(deferralBattery, { standard, message }, deferral, {
          ...base,
          gate: false,
          reason: (decision) => `defers ${decision.defers.toFixed(2)}`,
        }),
      );
      add(
        entryFor(
          blockerTriageBattery,
          { task: standard, blocker: message },
          triage,
          {
            ...base,
            gate: false,
            reason: (decision) =>
              `needs ${decision.needs}, urgency ${decision.urgency}`,
          },
        ),
      );
      return { pending };
    }

    if (change.action === "release") {
      if (report === undefined) return { pending };
      const [givesUp, reason, deferral] = await Promise.all([
        runCheck(this.judgment, givesUpBattery, { message: report }),
        runCheck(this.judgment, stopReasonBattery, {
          passage: report,
          ...(allowed === undefined ? {} : { allowed }),
        }),
        runCheck(this.judgment, deferralBattery, { standard, message: report }),
      ]);
      add(
        entryFor(givesUpBattery, { message: report }, givesUp, {
          ...base,
          gate: false,
          reason: (decision) => `gives up ${decision.givesUp.toFixed(2)}`,
        }),
      );
      add(
        entryFor(
          stopReasonBattery,
          { passage: report, ...(allowed === undefined ? {} : { allowed }) },
          reason,
          {
            ...base,
            gate: false,
            reason: (decision) =>
              `reason reads as ${decision.kind} (${decision.confidence.toFixed(2)})`,
          },
        ),
      );
      add(
        entryFor(deferralBattery, { standard, message: report }, deferral, {
          ...base,
          gate: false,
          reason: (decision) => `defers ${decision.defers.toFixed(2)}`,
        }),
      );
      return { pending };
    }

    if (report !== undefined && context.previousReports.length >= STALL_AFTER) {
      const updates = [...context.previousReports, `${status}: ${report}`]
        .map((line, index) => `${index + 1}. ${line}`)
        .join("\n");
      const input = { task: standard, updates };
      const result = await runCheck(this.judgment, stalledBattery, input);
      add(
        entryFor(stalledBattery, input, result, {
          ...base,
          gate: false,
          reason: (decision) =>
            `stuck ${decision.stuck.toFixed(2)}, abandoned ${decision.abandoned.toFixed(2)}`,
        }),
      );
    }
    return { pending };
  }

  private async checkCompletion(
    projectId: ProjectId,
    details: PlanDetails,
    context: ChangeContext,
    subject: Subject,
    base: EntryContext,
  ): Promise<{ pending: Pending[]; hold?: string }> {
    void projectId;
    const { change, work, task } = context;
    const taskDetails = details.tasks.get(task.id);
    const pending: Pending[] = [];
    const failures: string[] = [];
    const checks: string[] = [];
    const done: EntryContext = {
      ...base,
      reportedStatus: "complete",
    };
    const checkout =
      change.action === undefined || change.action === "progress"
        ? (change.location?.checkout ?? work.location.checkout)
        : work.location.checkout;
    const paths =
      change.action === undefined || change.action === "progress"
        ? (change.location?.paths ?? work.location.paths)
        : work.location.paths;
    const commitId =
      change.action === undefined || change.action === "progress"
        ? (change.commit ?? work.commit)
        : work.commit;
    const commit: CommitInfo | undefined =
      commitId === null ? undefined : readCommit(checkout, commitId);
    const deterministic: { entry: (applied: string) => NewEntry }[] = [];

    const enabled = (id: string) => checkEnabled(this.judgment.config, id);
    if (
      commit !== undefined &&
      paths.length > 0 &&
      enabled("vibecheck.commit-paths")
    ) {
      const touched = touchesPaths(commit.files, paths);
      const reason = touched
        ? `commit ${commit.commit.slice(0, 12)} changed files under the claimed paths`
        : `commit ${commit.commit.slice(0, 12)} changed no file under the claimed paths (${paths.join(", ")})`;
      if (!touched) {
        failures.push(reason);
        checks.push(reason);
      }
      deterministic.push({
        entry: (applied) =>
          deterministicEntry(
            "vibecheck.commit-paths",
            {
              commit: commit.commit,
              files: [...commit.files],
              paths: [...paths],
            },
            { block: !touched },
            {
              ...done,
              appliedStatus: applied,
              outcome: touched ? "passed" : "failed",
              reason,
            },
          ),
      });
    }

    for (const exception of taskDetails?.exceptions ?? []) {
      if (
        exception.data_only !== true ||
        exception.paths === undefined ||
        !enabled("vibecheck.exception-check")
      )
        continue;
      for (const result of checkDataOnlyPaths(checkout, exception.paths)) {
        const reason = result.dataOnly
          ? `${result.file} holds data only as recorded`
          : `${result.file} is recorded as data only but holds ${result.controlLines} control-flow lines`;
        if (!result.dataOnly) {
          failures.push(reason);
          checks.push(reason);
        }
        deterministic.push({
          entry: (applied) =>
            deterministicEntry(
              "vibecheck.exception-check",
              { ...result },
              { block: !result.dataOnly, controlLines: result.controlLines },
              {
                ...done,
                appliedStatus: applied,
                outcome: result.dataOnly ? "passed" : "failed",
                reason,
              },
            ),
        });
      }
    }

    let childSummary = "";
    if (context.children.length > 0 && enabled("vibecheck.parent-rollup")) {
      const unverified = context.children
        .filter((child) => !child.verified)
        .map((child) => child.id);
      const reason =
        unverified.length === 0
          ? `every child task is verified: ${context.children.map((child) => child.id).join(", ")}`
          : `child tasks not verified: ${unverified.join(", ")}`;
      if (unverified.length > 0) failures.push(reason);
      else
        childSummary = `\n\nChild tasks, each verified complete: ${context.children.map((child) => child.id).join(", ")}.`;
      deterministic.push({
        entry: (applied) =>
          deterministicEntry(
            "vibecheck.parent-rollup",
            { children: context.children.map((child) => ({ ...child })) },
            { block: unverified.length > 0 },
            {
              ...done,
              appliedStatus: applied,
              outcome: unverified.length > 0 ? "failed" : "passed",
              reason,
            },
          ),
      });
    }

    let reading:
      | {
          entry: (applied: string) => NewEntry | undefined;
          failed: string | undefined;
        }
      | undefined;
    const report = change.report;
    if (report !== undefined) {
      const exceptions = exceptionsText([taskDetails]);
      const input = {
        task: taskText(task, taskDetails),
        ...(exceptions === undefined ? {} : { exceptions }),
        ...(checks.length === 0 ? {} : { checks: checks.join("\n") }),
        report: `${report}${childSummary}`,
      };
      const result = await runCheck(this.judgment, claimsDoneBattery, input);
      const failed =
        result.kind === "verdict" && result.run.decision.block
          ? `the report claims done while its contents or checks show criteria unmet (overclaims ${result.run.decision.overclaims.toFixed(2)})`
          : undefined;
      reading = {
        failed,
        entry: (applied) =>
          entryFor(claimsDoneBattery, input, result, {
            ...done,
            appliedStatus: applied,
            gate: true,
            reason: (decision) =>
              decision.block
                ? `overclaims ${decision.overclaims.toFixed(2)}: the report presents the task as done while it shows work left`
                : `the report supports done (overclaims ${decision.overclaims.toFixed(2)})`,
          }),
      };
      if (failed !== undefined) failures.push(failed);
    }

    if (commit !== undefined) {
      const input = {
        task: taskText(task, taskDetails),
        message: commit.message,
        files: commit.files.join("\n"),
      };
      const result = await runCheck(this.judgment, commitHonestyBattery, input);
      const entry = entryFor(commitHonestyBattery, input, result, {
        ...base,
        gate: false,
        reason: (decision) =>
          `message matches task ${decision.matchesTask.toFixed(2)}, files ${decision.matchesFiles.toFixed(2)}, overstates ${decision.overstates.toFixed(2)}`,
      });
      if (entry !== undefined) pending.push({ subject, entry });
    }

    const hold = failures.length === 0 ? undefined : failures.join("; ");
    const applied = hold === undefined ? "complete" : work.status;
    for (const item of deterministic)
      pending.push({ subject, entry: item.entry(applied) });
    const readingEntry = reading?.entry(applied);
    if (readingEntry !== undefined)
      pending.push({ subject, entry: readingEntry });
    if (report === undefined && deterministic.length === 0)
      pending.push({
        subject,
        entry: deterministicEntry(
          claimsDoneBattery.id,
          null,
          { block: false, review: true },
          {
            ...done,
            appliedStatus: applied,
            outcome: "review",
            reason:
              "reported complete with no report text, so the done claim could not be read",
          },
        ),
      });
    return hold === undefined ? { pending } : { pending, hold };
  }

  // -------------------------------------------------------------------------
  // work_claim
  // -------------------------------------------------------------------------

  async afterClaim(
    database: Database,
    projectId: ProjectId,
    claimed: WorkRecord,
  ): Promise<VerificationItem[]> {
    if (claimed.role !== "owner") return [];
    const snapshot = await database.read(projectId, (tx) => {
      const details = planDetails(tx);
      const tasks = new Map(tx.allTasks().map((task) => [task.id, task]));
      const others = tx
        .allWork()
        .filter(
          (work) =>
            work.id !== claimed.id &&
            work.role === "owner" &&
            work.task_id !== claimed.task_id &&
            [
              "pending",
              "in_progress",
              "blocked",
              "awaiting_integration",
            ].includes(work.status),
        )
        .sort((left, right) => (left.updated_at < right.updated_at ? 1 : -1))
        .slice(0, OVERLAP_LIMIT);
      return { details, tasks, others };
    });
    const task = snapshot.tasks.get(claimed.task_id);
    if (task === undefined || snapshot.others.length === 0) return [];
    const claimText = (work: WorkRecord, record: TaskRecord) =>
      `${taskText(record, snapshot.details.tasks.get(record.id))}${work.location.paths.length === 0 ? "" : `\nPaths: ${work.location.paths.join(", ")}`}`;
    const first = claimText(claimed, task);
    const pending: Pending[] = [];
    await Promise.all(
      snapshot.others.map(async (other) => {
        const otherTask = snapshot.tasks.get(other.task_id);
        if (otherTask === undefined) return;
        const input = { first, second: claimText(other, otherTask) };
        const result = await runCheck(
          this.judgment,
          claimOverlapBattery,
          input,
        );
        const entry = entryFor(claimOverlapBattery, input, result, {
          source: "ledger:work_claim",
          evidence: { kind: "claim", ref: `work:${other.id}` },
          gate: false,
          reason: (decision) =>
            `overlaps work ${other.id} on task ${other.task_id}: duplicate ${decision.duplicate.toFixed(2)}, conflict ${decision.conflict.toFixed(2)}`,
        });
        if (entry !== undefined)
          pending.push({
            subject: {
              projectId,
              taskId: task.id,
              workId: claimed.id,
              sessionId: claimed.session_id,
            },
            entry,
          });
      }),
    );
    if (pending.length === 0) return [];
    return database.write(projectId, (tx) => this.record(tx, pending));
  }

  // -------------------------------------------------------------------------
  // plan_publish and plan_edit
  // -------------------------------------------------------------------------

  async planSnapshot(
    database: Database,
    projectId: ProjectId,
  ): Promise<PlanSnapshot | undefined> {
    return database.read(projectId, (tx) => {
      const project = tx.findProject(tx.projectId);
      if (project === undefined) return undefined;
      return snapshotOf(tx, project.plan_revision);
    });
  }

  async afterPlanChange(
    database: Database,
    projectId: ProjectId,
    before: PlanSnapshot | undefined,
    request: PlanPublish | PlanEdit,
  ): Promise<VerificationItem[]> {
    const after = await database.read(projectId, (tx) => {
      const project = tx.getProject(tx.projectId);
      return snapshotOf(tx, project.plan_revision);
    });
    const pending: Pending[] = [];
    const planSubject: Subject = { projectId, sessionId: request.session_id };
    const base = (ref: string): EntryContext => ({
      source:
        request.expected_revision === 0
          ? "ledger:plan_publish"
          : `ledger:${"operations" in request ? "plan_edit" : "plan_publish"}`,
      evidence: { kind: "plan", ref },
    });
    const jobs: Promise<void>[] = [];

    if (before !== undefined && before.revision > 0) {
      const change = describePlanChange(before, after);
      if (change.length > 0) {
        const input = {
          standard: planText(before.tasks, before.details),
          brief: `Plan change:\n${change}`,
        };
        jobs.push(
          runCheck(this.judgment, briefScopeBattery, input).then((result) => {
            const entry = entryFor(briefScopeBattery, input, result, {
              ...base(`plan:${before.revision}->${after.revision}`),
              gate: false,
              reason: (decision) =>
                `the change narrows accepted work ${decision.narrows.toFixed(2)}, defers ${decision.defers.toFixed(2)}`,
            });
            if (entry !== undefined)
              pending.push({ subject: planSubject, entry });
          }),
        );
      }
    }

    const previous = new Set(before?.tasks.map((task) => task.id) ?? []);
    const added = after.tasks.filter((task) => !previous.has(task.id));
    const existing = after.tasks.filter(
      (task) => previous.has(task.id) && task.status !== "cancelled",
    );
    const pairs: [TaskRecord, TaskRecord][] = [];
    for (const task of added)
      for (const other of existing) pairs.push([task, other]);
    for (let index = 0; index < added.length; index++)
      for (let other = 0; other < index; other++) {
        const left = added[index];
        const right = added[other];
        if (left !== undefined && right !== undefined)
          pairs.push([left, right]);
      }
    for (const [task, other] of pairs.slice(0, DUPLICATE_PAIR_LIMIT)) {
      const input = {
        newTask: taskText(task, after.details.tasks.get(task.id)),
        existingTask: taskText(other, after.details.tasks.get(other.id)),
      };
      jobs.push(
        runCheck(this.judgment, taskDuplicateBattery, input).then((result) => {
          const entry = entryFor(taskDuplicateBattery, input, result, {
            ...base(`task:${other.id}`),
            gate: false,
            reason: (decision) =>
              `against task ${other.id}: duplicate ${decision.duplicate.toFixed(2)}, overlap ${decision.overlap.toFixed(2)}`,
          });
          if (entry !== undefined)
            pending.push({
              subject: { ...planSubject, taskId: task.id },
              entry,
            });
        }),
      );
    }

    const goal = after.details.policy?.goal;
    if (goal !== undefined) {
      const tasks = planText(after.tasks, {
        policy: undefined,
        tasks: after.details.tasks,
      });
      const input = { goal, tasks };
      jobs.push(
        runCheck(this.judgment, planCoverageBattery, input).then((result) => {
          const entry = entryFor(planCoverageBattery, input, result, {
            ...base(`plan:${after.revision}`),
            gate: false,
            reason: (decision) =>
              `the tasks cover the goal ${decision.covers.toFixed(2)}`,
          });
          if (entry !== undefined)
            pending.push({ subject: planSubject, entry });
        }),
      );
    }
    await Promise.all(jobs);
    if (pending.length === 0) return [];
    return database.write(projectId, (tx) => this.record(tx, pending));
  }
}

export interface PlanSnapshot {
  readonly revision: number;
  readonly tasks: readonly TaskRecord[];
  readonly details: PlanDetails;
}

function snapshotOf(tx: Transaction, revision: number): PlanSnapshot {
  return { revision, tasks: tx.allTasks(), details: planDetails(tx, revision) };
}

/** Plain-language lines for what a plan revision changed. */
export function describePlanChange(
  before: PlanSnapshot,
  after: PlanSnapshot,
): string {
  const lines: string[] = [];
  const old = new Map(before.tasks.map((task) => [task.id, task]));
  for (const task of after.tasks) {
    const prior = old.get(task.id);
    const now = after.details.tasks.get(task.id);
    const was = before.details.tasks.get(task.id);
    if (prior === undefined) {
      lines.push(`add task ${taskText(task, now).replaceAll("\n", " ")}`);
      continue;
    }
    if (prior.status !== "cancelled" && task.status === "cancelled")
      lines.push(`cancel task ${task.id} (${task.label})`);
    if (prior.status === "cancelled" && task.status !== "cancelled")
      lines.push(`restore task ${task.id}`);
    if (prior.label !== task.label)
      lines.push(
        `rename task ${task.id} from '${prior.label}' to '${task.label}'`,
      );
    if (was?.goal !== now?.goal)
      lines.push(
        `change the goal of ${task.id} from '${was?.goal ?? "none"}' to '${now?.goal ?? "none"}'`,
      );
    if (
      JSON.stringify(was?.criteria ?? []) !==
      JSON.stringify(now?.criteria ?? [])
    )
      lines.push(
        `change the criteria of ${task.id} from '${(was?.criteria ?? []).join("; ")}' to '${(now?.criteria ?? []).join("; ")}'`,
      );
    if (
      JSON.stringify(was?.exceptions ?? []) !==
      JSON.stringify(now?.exceptions ?? [])
    )
      lines.push(
        `set the accepted exceptions of ${task.id} to '${(now?.exceptions ?? []).map((item) => item.description).join("; ") || "none"}'`,
      );
    if (JSON.stringify(was?.rules ?? []) !== JSON.stringify(now?.rules ?? []))
      lines.push(
        `set the rules of ${task.id} to '${(now?.rules ?? []).join("; ") || "none"}'`,
      );
    if (JSON.stringify(prior.depends_on) !== JSON.stringify(task.depends_on))
      lines.push(
        `set the dependencies of ${task.id} to ${task.depends_on.join(", ") || "none"}`,
      );
  }
  if (
    JSON.stringify(before.details.policy ?? {}) !==
    JSON.stringify(after.details.policy ?? {})
  )
    lines.push(
      `change the project policy to ${JSON.stringify(after.details.policy ?? {})}`,
    );
  return lines.map((line) => `- ${line}`).join("\n");
}

/** Whether a task's latest done check passed and the task is complete. */
export function isVerified(tx: Transaction, taskId: TaskId): boolean {
  const task = tx.findTask(taskId);
  if (task?.status !== "complete") return false;
  const verdicts = queryEntries(tx, {
    projectId: tx.projectId,
    taskIds: [taskId],
    kinds: ["verdict"],
    newest: true,
    limit: 20,
  });
  const latest = verdicts.find(
    (entry) =>
      entry.kind === "verdict" && DONE_CHECKS.has(entry.body.battery_id),
  );
  if (latest === undefined || latest.kind !== "verdict") return false;
  const sameRun = verdicts.filter(
    (entry) =>
      entry.kind === "verdict" &&
      entry.created_at === latest.created_at &&
      DONE_CHECKS.has(entry.body.battery_id),
  );
  return sameRun.every(
    (entry) => entry.kind === "verdict" && entry.body.outcome === "passed",
  );
}
