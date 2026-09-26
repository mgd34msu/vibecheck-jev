import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { z } from "zod";
import { Board } from "../src/board.js";
import { ScriptedProvider, type Script } from "../src/jev/lib/index.js";
import { LedgerVerifier } from "../src/verification/ledger.js";

const has = (state: unknown, text: string) =>
  JSON.stringify(state).includes(text);

function ledger(t: TestContext, script: Script, failures = 0) {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-jev-verify-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = new ScriptedProvider(script, "scripted", failures);
  const verifier = new LedgerVerifier({
    provider,
    config: {},
    thresholdsFor: () => undefined,
    sources: [],
    unusable: [],
  });
  return {
    board: new Board(join(directory, "ledger.sqlite3"), { verifier }),
    provider,
    directory,
  };
}

let counter = 0;
const rid = () => `r-${++counter}`;

async function setup(board: Board, tasks: object[], policy?: object) {
  const root = await board.call("project_join", {
    project_id: "p",
    request_id: rid(),
    repository: "repo",
    vendor: "v",
    runtime: "r",
    external_session_id: `root-${counter}`,
    model: "m",
  });
  await board.call("plan_publish", {
    project_id: "p",
    request_id: rid(),
    session_id: root.session_id,
    expected_revision: 0,
    tasks,
    ...(policy === undefined ? {} : { policy }),
  });
  return root.session_id;
}

async function claim(
  board: Board,
  session: string,
  taskId: string,
  location: object = {},
) {
  const status = z
    .object({ tasks: z.record(z.string(), z.object({ revision: z.number() })) })
    .parse(await board.call("project_status", { project_id: "p", full: true }));
  return board.call("work_claim", {
    project_id: "p",
    request_id: rid(),
    session_id: session,
    task_id: taskId,
    expected_revision: status.tasks[taskId]?.revision ?? 1,
    location,
  });
}

async function update(
  board: Board,
  session: string,
  work: { id: string; revision: number },
  taskRevision: number,
  change: object,
) {
  return board.call("work_update", {
    project_id: "p",
    request_id: rid(),
    session_id: session,
    updates: [
      {
        work_id: work.id,
        expected_revision: work.revision,
        expected_task_revision: taskRevision,
        ...change,
      },
    ],
  });
}

const statusSchema = z.object({
  attention: z
    .array(
      z.object({
        kind: z.string(),
        check: z.string(),
        task_id: z.string().optional(),
        needs: z.string().optional(),
        reason: z.string(),
      }),
    )
    .optional(),
  tasks: z.record(z.string(), z.object({ status: z.string() })),
  verification: z
    .record(
      z.string(),
      z.object({ verified: z.string(), reported: z.string() }),
    )
    .optional(),
});
const status = async (board: Board) =>
  statusSchema.parse(
    await board.call("project_status", { project_id: "p", full: true }),
  );

const FORMS = {
  id: "forms",
  label: "Validate every form",
  criteria: ["every form rejects empty required fields"],
};

test("a done report that overclaims leaves the task open with the reason visible", async (t) => {
  const { board } = ledger(t, (battery) =>
    battery === "vibecheck.claims-done" ? 0.9 : 0.1,
  );
  const session = await setup(board, [FORMS]);
  const claimed = await claim(board, session, "forms");
  const result = await update(
    board,
    session,
    claimed.work,
    claimed.task.revision,
    {
      status: "complete",
      report: "All 14 forms have entries; 6 were reviewed and left unchanged.",
    },
  );
  assert.equal(result.tasks.length, 0, "the task keeps its open status");
  const item = result.verification?.find(
    (entry) => entry.check === "vibecheck.claims-done",
  );
  assert.equal(item?.outcome, "failed");
  assert.equal(item?.reported_status, "complete");
  assert.equal(item?.applied_status, "in_progress");
  const view = await status(board);
  assert.equal(view.tasks["forms"]?.status, "in_progress");
  assert.equal(view.attention?.[0]?.kind, "held_done");
  assert.equal(view.verification?.["forms"]?.verified, "held");
  const history = z
    .object({ verifications: z.array(z.object({ kind: z.string() })) })
    .parse(
      await board.call("work_history", { project_id: "p", task_id: "forms" }),
    );
  assert.deepEqual(history.verifications.map((entry) => entry.kind).sort(), [
    "report",
    "verdict",
  ]);
});

test("a supported done report completes the task as verified", async (t) => {
  const { board, provider } = ledger(t, () => 0.1);
  const session = await setup(board, [FORMS]);
  const claimed = await claim(board, session, "forms");
  const result = await update(
    board,
    session,
    claimed.work,
    claimed.task.revision,
    {
      status: "complete",
      report: "All 14 forms reject empty required fields; tests cover each.",
    },
  );
  assert.equal(result.tasks[0]?.status, "complete");
  const view = await status(board);
  assert.equal(view.verification?.["forms"]?.verified, "verified");
  assert.equal(view.attention, undefined);
  const read = provider.requests.find(
    (request) => request.batteryId === "vibecheck.claims-done",
  );
  assert.ok(
    read !== undefined &&
      has(read.state, "every form rejects empty required fields"),
  );
});

test("when no source answers, the update applies as reported and the reading is recorded as unavailable", async (t) => {
  const { board } = ledger(t, () => 0.9, 100);
  const session = await setup(board, [FORMS]);
  const claimed = await claim(board, session, "forms");
  const result = await update(
    board,
    session,
    claimed.work,
    claimed.task.revision,
    { status: "complete", report: "Done." },
  );
  assert.equal(result.tasks[0]?.status, "complete");
  assert.equal(result.verification?.[0]?.outcome, "unavailable");
  const view = await status(board);
  assert.equal(view.verification?.["forms"]?.verified, "unverified");
  assert.equal(view.attention?.[0]?.kind, "unverified_done");
});

test("a blocker that needs the user leads the attention list", async (t) => {
  const { board } = ledger(t, (battery, question) =>
    battery === "vibecheck.blocker-triage"
      ? question === "needs"
        ? "user"
        : "high"
      : 0.1,
  );
  const session = await setup(board, [FORMS]);
  const claimed = await claim(board, session, "forms");
  const result = await update(
    board,
    session,
    claimed.work,
    claimed.task.revision,
    {
      status: "blocked",
      blocker: "Waiting for the user to choose the error wording.",
    },
  );
  assert.deepEqual(result.verification?.map((entry) => entry.check).sort(), [
    "vibecheck.blocker-triage",
    "vibecheck.deferral",
    "vibecheck.stop-reason",
  ]);
  const view = await status(board);
  assert.equal(view.attention?.[0]?.kind, "blocker");
  assert.equal(view.attention?.[0]?.needs, "user");
});

test("two open claims with the same intent are flagged as an overlap", async (t) => {
  const { board } = ledger(t, (battery, question) =>
    battery === "vibecheck.claim-overlap" && question === "duplicate"
      ? 0.9
      : 0.1,
  );
  const session = await setup(board, [
    { id: "csv", label: "CSV download on the reports page" },
    { id: "export", label: "Export the reports table as CSV" },
  ]);
  await claim(board, session, "csv");
  const second = await claim(board, session, "export");
  assert.equal(second.verification?.[0]?.outcome, "flagged");
  const view = await status(board);
  assert.ok(view.attention?.some((entry) => entry.kind === "overlap"));
});

test("a plan edit that cancels accepted work is flagged, and an added duplicate task is read against the plan", async (t) => {
  const { board } = ledger(t, (battery, question) =>
    (battery === "vibecheck.brief-scope" && question === "lowersBar") ||
    (battery === "vibecheck.task-duplicate" && question === "duplicate")
      ? 0.9
      : 0.1,
  );
  const session = await setup(
    board,
    [
      { id: "csv", label: "CSV export", criteria: ["every column"] },
      { id: "pdf", label: "PDF export" },
    ],
    { goal: "Reports export as CSV and PDF" },
  );
  const edited = await board.call("plan_edit", {
    project_id: "p",
    request_id: rid(),
    session_id: session,
    expected_revision: 1,
    operations: [
      { op: "update", task_id: "pdf", status: "cancelled" },
      { op: "add", task: { id: "csv-again", label: "Export reports as CSV" } },
    ],
  });
  const checks =
    edited.verification?.map((entry) => `${entry.check}:${entry.outcome}`) ??
    [];
  assert.ok(checks.includes("vibecheck.brief-scope:flagged"));
  assert.ok(checks.includes("vibecheck.task-duplicate:flagged"));
  assert.ok(
    checks.some((entry) => entry.startsWith("vibecheck.plan-coverage:")),
  );
});

test("a parent verifies only after its children verify and its own criteria read as met", async (t) => {
  const { board } = ledger(t, () => 0.1);
  const session = await setup(board, [
    {
      id: "reports",
      label: "Reports page",
      criteria: ["CSV and PDF export both work"],
    },
    { id: "csv", label: "CSV export", parent: "reports" },
  ]);
  const parent = await claim(board, session, "reports");
  const early = await update(
    board,
    session,
    parent.work,
    parent.task.revision,
    { status: "complete", report: "Reports are done." },
  );
  const rollup = early.verification?.find(
    (entry) => entry.check === "vibecheck.parent-rollup",
  );
  assert.equal(rollup?.outcome, "failed");
  assert.match(rollup?.reason ?? "", /child tasks not verified: csv/u);
  const child = await claim(board, session, "csv");
  await update(board, session, child.work, child.task.revision, {
    status: "complete",
    report: "CSV export works and is tested.",
  });
  const latest = z
    .object({
      work: z.record(z.string(), z.object({ revision: z.number() })),
      tasks: z.record(z.string(), z.object({ revision: z.number() })),
    })
    .parse(await board.call("project_status", { project_id: "p", full: true }));
  const done = await update(
    board,
    session,
    {
      id: parent.work.id,
      revision: latest.work[parent.work.id]?.revision ?? 0,
    },
    latest.tasks["reports"]?.revision ?? 0,
    { status: "complete", report: "CSV and PDF export both work." },
  );
  assert.equal(done.tasks[0]?.status, "complete");
  assert.equal(
    (await status(board)).verification?.["reports"]?.verified,
    "verified",
  );
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("a commit that touched none of the claimed paths, or a data-only file holding logic, holds the task open", async (t) => {
  const { board, directory } = ledger(t, () => 0.1);
  const repository = join(directory, "repo");
  mkdirSync(join(repository, "src", "format"), { recursive: true });
  git(directory, "init", "-q", repository);
  writeFileSync(join(repository, "README.md"), "readme\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-q", "-m", "Move price formatting");
  const commit = git(repository, "rev-parse", "HEAD");
  writeFileSync(
    join(repository, "src", "format", "labels.ts"),
    "export function label(x: number) {\n  if (x > 1) return 'many';\n  for (;;) { break; }\n  return 'one';\n}\n",
  );
  const session = await setup(board, [
    {
      id: "format",
      label: "Move price formatting",
      exceptions: [
        {
          description: "labels.ts holds only label text",
          paths: ["src/format/labels.ts"],
          data_only: true,
        },
      ],
    },
  ]);
  const claimed = await claim(board, session, "format", {
    checkout: repository,
    paths: ["src/format"],
  });
  const result = await update(
    board,
    session,
    claimed.work,
    claimed.task.revision,
    { status: "complete", commit, report: "Moved." },
  );
  const outcomes = Object.fromEntries(
    (result.verification ?? []).map((entry) => [entry.check, entry.outcome]),
  );
  assert.equal(outcomes["vibecheck.commit-paths"], "failed");
  assert.equal(outcomes["vibecheck.exception-check"], "failed");
  assert.ok("vibecheck.commit-honesty" in outcomes);
  assert.equal(result.tasks.length, 0);
});

test("a handoff with no note and a claim that keeps reporting the same failure are flagged", async (t) => {
  const { board } = ledger(t, (battery, question) =>
    battery === "vibecheck.stalled" && question === "stuck" ? 0.9 : 0.1,
  );
  const session = await setup(board, [FORMS]);
  const other = await board.call("project_join", {
    project_id: "p",
    request_id: rid(),
    repository: "repo",
    vendor: "v",
    runtime: "r",
    external_session_id: "other",
    model: "m",
    parent_session_id: session,
  });
  const current = await claim(board, session, "forms");
  let work = { id: current.work.id, revision: current.work.revision };
  let taskRevision: number = current.task.revision;
  for (let index = 0; index < 4; index++) {
    const result = await update(board, session, work, taskRevision, {
      report: "The rounding test still fails with the same error.",
    });
    const next = result.work[0];
    if (next !== undefined) work = { id: next.id, revision: next.revision };
    if (index === 3)
      assert.equal(result.verification?.[0]?.check, "vibecheck.stalled");
  }
  assert.ok(
    (await status(board)).attention?.some((entry) => entry.kind === "stalled"),
  );
  const latest = z
    .object({
      tasks: z.record(z.string(), z.object({ revision: z.number() })),
      work: z.record(z.string(), z.object({ revision: z.number() })),
    })
    .parse(await board.call("project_status", { project_id: "p", full: true }));
  taskRevision = latest.tasks["forms"]?.revision ?? 0;
  const handoff = await board.call("work_update", {
    project_id: "p",
    request_id: rid(),
    session_id: session,
    updates: [
      {
        work_id: work.id,
        expected_revision: latest.work[work.id]?.revision ?? 0,
        expected_task_revision: taskRevision,
        action: "handoff",
        handoff_to: other.session_id,
      },
    ],
  });
  assert.equal(handoff.verification?.[0]?.check, "vibecheck.handoff-complete");
  assert.equal(handoff.verification?.[0]?.outcome, "flagged");
});

test("without a verifier the ledger records work as reported, with no verification fields", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-jev-plain-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const board = new Board(join(directory, "ledger.sqlite3"));
  const session = await setup(board, [FORMS]);
  const claimed = await claim(board, session, "forms");
  const result = await update(
    board,
    session,
    claimed.work,
    claimed.task.revision,
    { status: "complete", report: "Done." },
  );
  assert.equal(result.tasks[0]?.status, "complete");
  assert.equal("verification" in result, false);
  const view = z
    .record(z.string(), z.unknown())
    .parse(await board.call("project_status", { project_id: "p" }));
  assert.equal("attention" in view, false);
  assert.equal("verification" in view, false);
});
