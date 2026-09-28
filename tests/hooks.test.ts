import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { z } from "zod";
import { Board } from "../src/board.js";
import { Database } from "../src/db.js";
import { detectClient } from "../src/cli.js";
import { bashGuard, unguardedDelete } from "../src/jev/hooks/bash-guard.js";
import type { HookDeps } from "../src/jev/hooks/io.js";
import { preToolHook } from "../src/jev/hooks/pretool.js";
import { MAX_BLOCKS, sessionEndHook, stopHook } from "../src/jev/hooks/stop.js";
import type { Judgment } from "../src/jev/judgment.js";
import { ScriptedProvider, type Script } from "../src/jev/lib/index.js";
import { queryEntries } from "../src/verification/store.js";
import {
  CLAUDE_LINES,
  CODEX_LINES,
  MUSE_LINES,
  MUSE_SESSION_ID,
  writeMuseSession,
  writeTranscript,
} from "./jev-helpers.js";

function judgmentOf(script: Script): {
  judgment: Judgment;
  provider: ScriptedProvider;
} {
  const provider = new ScriptedProvider(script);
  return {
    provider,
    judgment: {
      provider,
      config: {},
      thresholdsFor: () => undefined,
      sources: [],
      unusable: [],
    },
  };
}

function museSessions(t: TestContext): string {
  const sessions = mkdtempSync(join(tmpdir(), "vibecheck-jev-muse-sessions-"));
  t.after(() => rmSync(sessions, { recursive: true, force: true }));
  return sessions;
}

function deps(
  t: TestContext,
  client: "claude" | "codex" | "muse",
  script: Script | undefined,
  sessionsDir?: string,
) {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-jev-hooks-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "ledger.sqlite3");
  const opened = script === undefined ? undefined : judgmentOf(script);
  const value: HookDeps = {
    client,
    databasePath,
    ...(client === "muse"
      ? { sessionsDir: sessionsDir ?? museSessions(t) }
      : {}),
    judgment: () =>
      opened?.judgment ?? {
        unusable: [{ sourceId: "typesafe", reason: "no API key" }],
      },
  };
  return { deps: value, databasePath, provider: opened?.provider };
}

const has = (state: unknown, text: string) =>
  JSON.stringify(state).includes(text);

async function seedLedger(databasePath: string, externalSessionId: string) {
  const board = new Board(databasePath);
  const joined = await board.call("project_join", {
    project_id: "shop",
    request_id: "join",
    repository: "https://example.com/team/shop.git",
    vendor: "test",
    runtime: "test",
    external_session_id: externalSessionId,
    model: "m",
  });
  await board.call("plan_publish", {
    project_id: "shop",
    request_id: "plan",
    session_id: joined.session_id,
    expected_revision: 0,
    tasks: [
      {
        id: "csv-export",
        label: "CSV export for the reports page",
        criteria: ["every visible column is exported"],
      },
      { id: "pdf-export", label: "PDF export for the reports page" },
    ],
    policy: {
      rules: ["Every schema change is a new migration in db/migrations/"],
    },
  });
  const claim = await board.call("work_claim", {
    project_id: "shop",
    request_id: "claim",
    session_id: joined.session_id,
    task_id: "csv-export",
    expected_revision: 1,
    location: { paths: ["src/reports/csv.ts"] },
  });
  return { board, session: joined.session_id, work: claim.work };
}

const claudePreTool = (
  transcript: string | null,
  toolInput: object,
  tool = "Agent",
) => ({
  session_id: "claude-session",
  transcript_path: transcript,
  cwd: "/nonexistent/work",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: toolInput,
  tool_use_id: "toolu_9",
});

const codexCommon = {
  session_id: "019c-session",
  turn_id: "turn-1",
  cwd: "/nonexistent/work",
  model: "model",
  permission_mode: "default",
};

const museCommon = {
  session_id: MUSE_SESSION_ID,
  turn_id: "turn-1",
  cwd: "/nonexistent/work",
  model: "model",
  model_provider: "meta",
  permission_mode: "default",
  transcript_path: null,
};

test("the delete guard refuses deletes through unguarded variables and nothing else", () => {
  const refused = [
    "rm -rf $TARGET",
    'rm -rf "$TARGET/build"',
    'rm -rf "${TARGET}/build"',
    "cd /tmp && rm -f $FILE",
    "sudo rm -rf $HOME/cache",
    "for f in *.log; do rm $f; done",
    "find . -name '*.tmp' | xargs rm -f $EXTRA",
    "unlink $LINK",
  ];
  const allowed = [
    'rm -rf "${TARGET:?}/build"',
    "rm -rf /tmp/literal/path",
    "echo 'rm -rf $NOT_A_COMMAND'",
    "rmdir build",
    "ls $HOME",
  ];
  for (const command of refused)
    assert.notEqual(unguardedDelete(command), undefined, command);
  for (const command of allowed)
    assert.equal(unguardedDelete(command), undefined, command);
  const denied = bashGuard(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "c",
      tool_input: { command: "rm -rf $X" },
      transcript_path: null,
    }),
  );
  assert.match(denied.stdout ?? "", /"permissionDecision":"deny"/u);
  assert.equal(bashGuard("not json").exitCode, 0);
});

test("the client is read from the payload: Codex payloads carry turn_id", () => {
  assert.equal(
    detectClient(JSON.stringify({ turn_id: "t" }), "claude"),
    "codex",
  );
  assert.equal(
    detectClient(JSON.stringify({ session_id: "s" }), "claude"),
    "claude",
  );
  assert.equal(detectClient("not json", "codex"), "codex");
  assert.equal(detectClient(JSON.stringify({ turn_id: "t" }), "muse"), "muse");
  assert.equal(detectClient("not json", "muse"), "muse");
});

test("a Claude brief that narrows the plan is denied and the verdict lands in the ledger", async (t) => {
  const setup = deps(t, "claude", (battery, question, state) =>
    battery === "vibecheck.brief-scope" &&
    question === "lowersBar" &&
    has(state, "half")
      ? 0.9
      : 0.1,
  );
  await seedLedger(setup.databasePath, "claude-session");
  const transcript = writeTranscript(t, CLAUDE_LINES);
  const result = await preToolHook(
    JSON.stringify(
      claudePreTool(transcript, {
        prompt: "Build the CSV export, but only half of the columns.",
      }),
    ),
    setup.deps,
  );
  assert.equal(result.exitCode, 0);
  const output = z
    .object({
      hookSpecificOutput: z.object({
        permissionDecision: z.literal("deny"),
        permissionDecisionReason: z.string(),
      }),
    })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /brief-scope/u,
  );
  const request = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.brief-scope",
  );
  assert.ok(
    request !== undefined &&
      has(request.state, "csv-export") &&
      has(request.state, "every visible column is exported"),
  );
  const entries = await new Database(setup.databasePath).unscoped(
    false,
    (access) => queryEntries(access, { projectId: "shop" }),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.kind === "verdict" &&
        entry.body.battery_id === "vibecheck.brief-scope" &&
        entry.body.outcome === "failed",
    ),
  );
});

test("a new worker's brief that leaves out a governing project rule is denied", async (t) => {
  const setup = deps(t, "claude", (battery, question) =>
    battery === "vibecheck.brief-carries-rules"
      ? question === "governed"
        ? 0.9
        : 0.1
      : 0.1,
  );
  await seedLedger(setup.databasePath, "claude-session");
  const result = await preToolHook(
    JSON.stringify(
      claudePreTool(null, { prompt: "Add a phone column to the users table." }),
    ),
    setup.deps,
  );
  assert.match(result.stdout ?? "", /brief-carries-rules[^"]*migration/u);
});

test("a Codex brief is read from spawn_agent; a sealed one is skipped with a note", async (t) => {
  const setup = deps(t, "codex", () => 0.1);
  const transcript = writeTranscript(t, CODEX_LINES);
  const readable = await preToolHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      tool_use_id: "c",
      transcript_path: transcript,
      tool_input: {
        task_name: "tests",
        message: "Fix the failing checkout test and run the suite.",
      },
    }),
    setup.deps,
  );
  assert.deepEqual(readable, { exitCode: 0 });
  const brief = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.brief-scope",
  );
  assert.ok(
    brief !== undefined && has(brief.state, "Fix the failing checkout test."),
    "the user's request stands in without a ledger project",
  );
  const sealed = await preToolHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "PreToolUse",
      tool_name: "send_message",
      tool_use_id: "c",
      transcript_path: transcript,
      tool_input: {
        target: "tests",
        message:
          "gAAAAABqt0_ODGHbVZbAj5zGQeN09pc4lICnmLguoGN2cJ21EuzKMDzzuonT6hiiokHFV2eN60tGPV75uod3is9zxNmUxVN1Kflo7SsBQvuDbzE_HyEqyQuNOVFWg7bJEHDUTLVAvMl2",
      },
    }),
    setup.deps,
  );
  assert.equal(sealed.exitCode, 0);
  assert.match(sealed.stderr ?? "", /sealed/u);
});

test("Codex collaboration tool namespaces reach the brief judgment", async (t) => {
  const transcript = writeTranscript(t, CODEX_LINES);
  for (const prefix of ["collaboration.", "functions.collaboration."]) {
    for (const name of [
      "spawn_agent",
      "send_message",
      "followup_task",
      "send_input",
    ]) {
      const setup = deps(t, "codex", () => 0.1);
      const result = await preToolHook(
        JSON.stringify({
          ...codexCommon,
          hook_event_name: "PreToolUse",
          tool_name: `${prefix}${name}`,
          tool_use_id: "namespaced-brief",
          transcript_path: transcript,
          tool_input: {
            target: "tests",
            task_name: "tests",
            message: "Fix the failing checkout test and run the suite.",
          },
        }),
        setup.deps,
      );
      assert.deepEqual(result, { exitCode: 0 });
      assert.ok(
        setup.provider?.requests.some(
          (entry) => entry.batteryId === "vibecheck.brief-scope",
        ),
        `${prefix}${name} must be judged`,
      );
    }
  }
});

test("hooks fail open with a message when no judgment source is usable", async (t) => {
  const claude = deps(t, "claude", undefined);
  const transcript = writeTranscript(t, CLAUDE_LINES);
  const brief = await preToolHook(
    JSON.stringify(claudePreTool(transcript, { prompt: "Do half." })),
    claude.deps,
  );
  assert.equal(brief.exitCode, 1);
  assert.match(brief.stderr ?? "", /no judgment source is usable/u);
  assert.equal(brief.stdout, undefined);
  const codex = deps(t, "codex", undefined);
  const codexTranscript = writeTranscript(t, CODEX_LINES);
  const stop = await stopHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: codexTranscript,
      last_assistant_message: "The checkout test passes now.",
    }),
    codex.deps,
  );
  assert.deepEqual(
    { stdout: stop.stdout, exitCode: stop.exitCode },
    { stdout: "{}", exitCode: 0 },
  );
  assert.match(stop.stderr ?? "", /not checked/u);
});

test("the Stop check blocks an ungrounded sentence by name, then stops blocking after the cap", async (t) => {
  const setup = deps(t, "claude", (battery, question, state) =>
    battery === "vibecheck.claim-grounded" &&
    question === "ungrounded" &&
    has(state, "CSV export is in")
      ? 0.9
      : 0.1,
  );
  const transcript = writeTranscript(t, CLAUDE_LINES);
  const payload = JSON.stringify({
    session_id: "claude-stop",
    transcript_path: transcript,
    cwd: "/nonexistent",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });
  for (let block = 0; block < MAX_BLOCKS; block++) {
    const result = await stopHook(payload, setup.deps);
    const output = z
      .object({ decision: z.literal("block"), reason: z.string() })
      .parse(JSON.parse(result.stdout ?? ""));
    assert.match(
      output.reason,
      /"The CSV export is in src\/reports\/csv\.ts\." \(0\.90\)/u,
    );
  }
  assert.deepEqual(await stopHook(payload, setup.deps), { exitCode: 0 });
});

test("a reply confirming a pause the user asked for is not checked", async (t) => {
  const setup = deps(t, "codex", (battery) =>
    battery === "vibecheck.user-pauses" ? 0.95 : 0.95,
  );
  const transcript = writeTranscript(t, [
    ...CODEX_LINES,
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "pause until tomorrow morning",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Pausing until tomorrow morning." },
        ],
      },
    },
  ]);
  const result = await stopHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: transcript,
      last_assistant_message: "Pausing until tomorrow morning.",
    }),
    setup.deps,
  );
  assert.deepEqual(result, { stdout: "{}", exitCode: 0 });
  assert.deepEqual(
    setup.provider?.requests.map((entry) => entry.batteryId),
    ["vibecheck.user-pauses"],
  );
});

test("a stopping reply is judged against the session's open claims in the ledger", async (t) => {
  const setup = deps(t, "codex", (battery, question) =>
    battery === "vibecheck.claims-done" &&
    (question === "isFinal" || question === "overclaims")
      ? 0.9
      : 0.1,
  );
  await seedLedger(setup.databasePath, "019c-session");
  const transcript = writeTranscript(t, CODEX_LINES);
  const result = await stopHook(
    JSON.stringify({
      ...codexCommon,
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: transcript,
      last_assistant_message: "The checkout test passes now.",
    }),
    setup.deps,
  );
  const output = z
    .object({ decision: z.literal("block"), reason: z.string() })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(output.reason, /claimed task as done/u);
  const claims = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.claims-done",
  );
  assert.ok(
    claims !== undefined &&
      has(claims.state, "every visible column is exported"),
  );
  const grounded = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.claim-grounded",
  );
  assert.ok(
    grounded !== undefined &&
      has(grounded.state, "PASS tests/checkout.test.ts"),
  );
});

test("a Muse spawn brief that narrows the plan is denied and the verdict lands in the ledger", async (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  const setup = deps(
    t,
    "muse",
    (battery, question, state) =>
      battery === "vibecheck.brief-scope" &&
      question === "lowersBar" &&
      has(state, "half")
        ? 0.9
        : 0.1,
    seeded.sessionsDir,
  );
  await seedLedger(setup.databasePath, MUSE_SESSION_ID);
  const result = await preToolHook(
    JSON.stringify({
      ...museCommon,
      transcript_path: seeded.path,
      hook_event_name: "PreToolUse",
      tool_name: "subagent_spawn",
      tool_use_id: "call_1",
      tool_input: {
        command_id: "csv",
        objective: "Build the CSV export, but only half of the columns.",
        role: "csv",
      },
    }),
    setup.deps,
  );
  assert.equal(result.exitCode, 0);
  const output = z
    .object({
      hookSpecificOutput: z.object({
        permissionDecision: z.literal("deny"),
        permissionDecisionReason: z.string(),
      }),
    })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(
    output.hookSpecificOutput.permissionDecisionReason,
    /brief-scope/u,
  );
  const entries = await new Database(setup.databasePath).unscoped(
    false,
    (access) => queryEntries(access, { projectId: "shop" }),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.kind === "verdict" &&
        entry.body.battery_id === "vibecheck.brief-scope" &&
        entry.body.outcome === "failed",
    ),
  );
});

test("a Muse message to a worker is judged against the session log's requests", async (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  const setup = deps(t, "muse", () => 0.1, seeded.sessionsDir);
  const result = await preToolHook(
    JSON.stringify({
      ...museCommon,
      hook_event_name: "PreToolUse",
      tool_name: "subagent_send_message",
      tool_use_id: "call_2",
      tool_input: {
        subagent_id: "sub-1",
        message: "Fix the failing checkout test and run the suite.",
      },
    }),
    setup.deps,
  );
  assert.deepEqual(result, { exitCode: 0 });
  const brief = setup.provider?.requests.find(
    (entry) => entry.batteryId === "vibecheck.brief-scope",
  );
  assert.ok(
    brief !== undefined &&
      has(brief.state, "Add a CSV export to the reports page."),
    "the session log's requests stand in without a ledger project",
  );
});

test("a Muse shell delete through an unguarded variable is refused", () => {
  const denied = bashGuard(
    JSON.stringify({
      ...museCommon,
      hook_event_name: "PreToolUse",
      tool_name: "bash",
      tool_use_id: "call_3",
      tool_input: {
        command: "rm -rf $X",
        description: "clean",
        workdir: "/tmp",
      },
    }),
  );
  assert.match(denied.stdout ?? "", /"permissionDecision":"deny"/u);
  const allowed = bashGuard(
    JSON.stringify({
      ...museCommon,
      hook_event_name: "PreToolUse",
      tool_name: "read_file",
      tool_use_id: "call_4",
      tool_input: { path: "/tmp/x" },
    }),
  );
  assert.deepEqual(allowed, { exitCode: 0 });
});

test("a Muse subagent reply stating what the tools did not show is blocked by name", async (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  const setup = deps(
    t,
    "muse",
    (battery, question, state) =>
      battery === "vibecheck.claim-grounded" &&
      question === "ungrounded" &&
      has(state, "CSV export is in")
        ? 0.9
        : 0.1,
    seeded.sessionsDir,
  );
  const result = await stopHook(
    JSON.stringify({
      ...museCommon,
      hook_event_name: "SubagentStop",
      stop_hook_active: false,
      child_session_id: MUSE_SESSION_ID,
      subagent_id: "sub-1",
    }),
    setup.deps,
  );
  const output = z
    .object({ decision: z.literal("block"), reason: z.string() })
    .parse(JSON.parse(result.stdout ?? ""));
  assert.match(
    output.reason,
    /"The CSV export is in src\/reports\/csv\.ts\." \(0\.90\)/u,
  );
});

test("a Muse session end records the verdict without holding the reply", async (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  const setup = deps(
    t,
    "muse",
    (battery, question, state) =>
      battery === "vibecheck.claim-grounded" &&
      question === "ungrounded" &&
      has(state, "CSV export is in")
        ? 0.9
        : 0.1,
    seeded.sessionsDir,
  );
  const result = await sessionEndHook(
    JSON.stringify({
      session_id: MUSE_SESSION_ID,
      cwd: "/nonexistent/work",
      transcript_path: null,
      hook_event_name: "SessionEnd",
      model: "model",
      model_provider: "meta",
      permission_mode: "default",
      reason: "other",
    }),
    setup.deps,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, undefined);
  assert.match(result.stderr ?? "", /not held/u);
  const entries = await new Database(setup.databasePath).unscoped(
    false,
    (access) => queryEntries(access, {}),
  );
  assert.ok(
    entries.some(
      (entry) =>
        entry.kind === "verdict" &&
        entry.body.battery_id === "vibecheck.claim-grounded",
    ),
  );
});
