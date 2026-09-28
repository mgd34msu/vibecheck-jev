import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CLAUDE_LINES,
  CODEX_LINES,
  MUSE_LINES,
  MUSE_SESSION_DAY,
  MUSE_SESSION_ID,
  writeMuseSession,
  writeTranscript,
} from "./jev-helpers.js";
import {
  claudeLaunchBrief,
  findMuseSessionLog,
  isSealed,
  joinEvidence,
  readClaudeTranscript,
  readCodexTranscript,
  readMuseTranscript,
  replySentences,
} from "../src/jev/transcript.js";

test("a Claude Code transcript yields the user's messages, the reply and the evidence", (t) => {
  const path = writeTranscript(t, CLAUDE_LINES);
  const view = readClaudeTranscript(path);
  assert.deepEqual(view.userMessages, [
    "Add a CSV export to the reports page.",
  ]);
  assert.equal(view.trigger, "user");
  assert.equal(
    view.lastReply,
    "Running the report tests first.\nAll 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.equal(
    view.finalText,
    "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.ok(
    view.evidence.some((segment) => segment.includes("Tests: 12 passed")),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Command run (Run the report tests):\n$ npm test"),
    ),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Instruction sent by Agent: Write tests"),
    ),
  );
  assert.equal(
    claudeLaunchBrief(path, "a1b2c3"),
    "Write tests for src/reports/csv.ts until every function has one.",
  );
});

test("a background notice starts a notification turn and a Stop-hook block resets the reply", (t) => {
  const path = writeTranscript(t, [
    ...CLAUDE_LINES,
    {
      type: "user",
      message: {
        role: "user",
        content:
          "<task-notification><status>completed</status><summary>Agent finished</summary></task-notification>",
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The agent finished." }],
      },
    },
  ]);
  const notice = readClaudeTranscript(path);
  assert.equal(notice.trigger, "notification");
  assert.equal(notice.lastReply, "The agent finished.");
  const blocked = writeTranscript(t, [
    ...CLAUDE_LINES,
    {
      type: "user",
      message: {
        role: "user",
        content: "Stop hook feedback:\nvibecheck-jev: answer the question",
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Corrected reply." }],
      },
    },
  ]);
  assert.equal(readClaudeTranscript(blocked).lastReply, "Corrected reply.");
});

test("a Codex rollout yields the user's input from events, the reply and the evidence", (t) => {
  const path = writeTranscript(t, CODEX_LINES);
  const view = readCodexTranscript(path);
  assert.deepEqual(view.userMessages, ["Fix the failing checkout test."]);
  assert.equal(
    view.lastReply,
    "Running the checkout test.\nThe checkout test passes now.",
  );
  assert.equal(view.finalText, "The checkout test passes now.");
  assert.ok(
    view.evidence.some((segment) =>
      segment.includes("PASS tests/checkout.test.ts"),
    ),
  );
  assert.ok(view.evidence.some((segment) => segment.includes("exec_command")));
  assert.ok(
    view.evidence.every((segment) => !segment.includes("gAAAAAB")),
    "sealed briefs are not evidence",
  );
});

test("an older Codex rollout with user_message events and compacted history still reads", (t) => {
  const path = writeTranscript(t, [
    {
      type: "compacted",
      payload: {
        message: "",
        replacement_history: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Earlier request." }],
          },
        ],
      },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "Now add the refund flow." },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":["bash","-lc","ls src"]}',
        call_id: "c",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "c",
        output: "refunds.ts",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root/review",
        content: [
          {
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nPayload:\nok",
          },
        ],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Review agent answered." }],
      },
    },
  ]);
  const view = readCodexTranscript(path);
  assert.deepEqual(view.userMessages, [
    "Earlier request.",
    "Now add the refund flow.",
  ]);
  assert.equal(view.trigger, "notification");
  assert.ok(
    view.evidence.some((segment) => segment.includes("$ bash -lc ls src")),
  );
});

test("a Muse session log yields the user's prompts, the reply and the evidence", (t) => {
  const path = writeTranscript(t, MUSE_LINES);
  const view = readMuseTranscript(path);
  assert.deepEqual(view.userMessages, [
    "Add a CSV export to the reports page.",
  ]);
  assert.equal(view.trigger, "user");
  assert.equal(
    view.lastReply,
    "Running the report tests first.\nAll 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.equal(
    view.finalText,
    "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
  );
  assert.ok(
    view.evidence.some((segment) => segment.includes("Tests: 12 passed")),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Command run (Run the report tests):\n$ npm test"),
    ),
  );
  assert.ok(
    view.evidence.some((segment) =>
      segment.startsWith("Instruction sent by subagent_spawn: Write tests"),
    ),
  );
});

test("a Muse delivery starts a notification turn and a stop block resets the reply", (t) => {
  const notice = readMuseTranscript(
    writeTranscript(t, [
      ...MUSE_LINES,
      {
        payload: {
          kind: "run",
          event: {
            kind: "inbox_item_queued",
            source: { source: "scheduled" },
            payload: { prompt: "Nightly check-in." },
          },
        },
      },
      {
        payload: {
          kind: "run",
          event: {
            kind: "assistant_message_committed",
            text: "Checked in.",
          },
        },
      },
    ]),
  );
  assert.equal(notice.trigger, "notification");
  assert.equal(notice.lastReply, "Checked in.");
  const blocked = readMuseTranscript(
    writeTranscript(t, [
      ...MUSE_LINES,
      {
        payload: {
          kind: "run",
          event: {
            kind: "context_block_updated",
            lifecycle: "subagent_stop",
            reason: "hook:subagent_stop",
            text: "answer the question",
          },
        },
      },
      {
        payload: {
          kind: "run",
          event: {
            kind: "assistant_message_committed",
            text: "Corrected reply.",
          },
        },
      },
    ]),
  );
  assert.equal(blocked.lastReply, "Corrected reply.");
});

test("Muse session logs are found by session id in their day folder or beside their parent", (t) => {
  const seeded = writeMuseSession(t, MUSE_LINES);
  assert.equal(
    findMuseSessionLog(seeded.sessionsDir, MUSE_SESSION_ID),
    seeded.path,
  );
  const legacy = writeMuseSession(
    t,
    MUSE_LINES,
    "d00636fe-322f-49b0-bf3f-c767104e50fa",
    ["2026", "09", "27"],
  );
  assert.equal(
    findMuseSessionLog(
      legacy.sessionsDir,
      "d00636fe-322f-49b0-bf3f-c767104e50fa",
    ),
    legacy.path,
  );
  const childId = "01a0ea30-9d79-76c0-b181-63b12c20cb71";
  const parent = join(
    seeded.sessionsDir,
    ...MUSE_SESSION_DAY,
    "01a0ea30-628e-7e71-8c05-032028c09217",
    "subagent",
    childId,
  );
  mkdirSync(parent, { recursive: true });
  const child = join(parent, "session.jsonl");
  copyFileSync(seeded.path, child);
  assert.equal(findMuseSessionLog(seeded.sessionsDir, childId), child);
  assert.equal(
    findMuseSessionLog(seeded.sessionsDir, "019c-session"),
    undefined,
  );
  assert.equal(
    findMuseSessionLog(
      join(tmpdir(), "vibecheck-jev-no-such-store"),
      MUSE_SESSION_ID,
    ),
    undefined,
  );
});

test("sealed Codex messages are recognized; readable briefs are not", () => {
  assert.equal(
    isSealed(
      "gAAAAABqt0_ODGHbVZbAj5zGQeN09pc4lICnmLguoGN2cJ21EuzKMDzzuonT6hiiokHFV2eN60tGPV75uod3is9zxNmUxVN1Kflo7SsBQvuDbzE_HyEqyQuNOVFWg7bJEHDUTLVAvMl2",
    ),
    true,
  );
  assert.equal(isSealed("Write tests for the export."), false);
});

test("replies split into sentences and evidence about claimed files comes first", () => {
  assert.deepEqual(
    replySentences(
      "## Summary\nAll tests pass. The export works.\n- Added csv.ts\n---",
    ),
    ["Summary", "All tests pass.", "The export works.", "Added csv.ts"],
  );
  const joined = joinEvidence(
    ["other output", "edited src/reports/csv.ts", "more"],
    ["src/reports/csv.ts"],
  );
  assert.ok(joined.startsWith("edited src/reports/csv.ts"));
  assert.equal(joinEvidence(["abcdef"], [], 3), "abc");
});
