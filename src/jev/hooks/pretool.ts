// PreToolUse hook for agent briefs: Claude Code's Agent, Task and
// SendMessage, Codex's spawn_agent, send_message, followup_task and
// send_input, Muse's subagent_spawn and subagent_send_message, and
// Antigravity's invoke_subagent, send_message and manage_task. It blocks
// a brief that asks for less than the recorded standard or plans to leave
// work for later (brief-scope), and a new worker's brief that leaves out the
// project rules governing its work (brief-carries-rules).
//
// The standard comes from the ledger: the plan, this session's claimed tasks
// and their accepted exceptions. A message to a running worker is judged
// against the brief that worker was launched with. Only when the session has
// no ledger project do the user's recent messages stand in.

import { Database } from "../../db.js";
import { briefCarriesRulesBattery, briefScopeBattery } from "../batteries.js";
import { entryFor } from "../entries.js";
import { isJudgment, runCheck } from "../judgment.js";
import { resolveContext } from "../project.js";
import { exceptionsText, planText, rulesText, taskText } from "../standard.js";
import { claudeLaunchBrief, isSealed, recentRequests } from "../transcript.js";
import type { NewEntry, Subject } from "../../verification/store.js";
import {
  allow,
  deny,
  failOpen,
  inputString,
  parsePayload,
  preToolPayloadSchema,
  readHookTranscript,
  recordEntries,
  translateAntigravityPreTool,
  type HookDeps,
  type HookResult,
} from "./io.js";

const LAUNCH_TOOLS = new Set([
  "Agent",
  "Task",
  "spawn_agent",
  "subagent_spawn",
  "invoke_subagent",
]);
const MESSAGE_TOOLS = new Set([
  "SendMessage",
  "send_message",
  "followup_task",
  "send_input",
  "subagent_send_message",
  "manage_task",
]);

export async function preToolHook(
  stdin: string,
  deps: HookDeps,
): Promise<HookResult> {
  const payload =
    deps.client === "antigravity"
      ? translateAntigravityPreTool(stdin)
      : parsePayload(preToolPayloadSchema, stdin);
  if (typeof payload === "string")
    return failOpen(deps.client, "PreToolUse", payload);
  const toolName =
    deps.client === "codex"
      ? payload.tool_name.replace(/^(?:functions\.)?collaboration\./u, "")
      : payload.tool_name;
  const launch = LAUNCH_TOOLS.has(toolName);
  if (!launch && !MESSAGE_TOOLS.has(toolName))
    return allow(deps.client, "PreToolUse");
  const brief = inputString(
    payload.tool_input,
    "prompt",
    "message",
    "task",
    "objective",
  );
  if (brief === undefined) return allow(deps.client, "PreToolUse");
  if (isSealed(brief))
    return {
      stderr:
        "vibecheck-jev: this brief is sealed by the client and cannot be read, so it was not checked.\n",
      exitCode: 0,
    };

  const database = new Database(deps.databasePath);
  const context = await resolveContext(database, {
    ...(payload.session_id === undefined
      ? {}
      : { sessionId: payload.session_id }),
    ...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
  });
  const transcript = readHookTranscript(deps, payload);
  const target = inputString(
    payload.tool_input,
    "to",
    "target",
    "recipient",
    "subagent_id",
  );
  const launched =
    !launch &&
    target !== undefined &&
    deps.client === "claude" &&
    typeof payload.transcript_path === "string"
      ? claudeLaunchBrief(payload.transcript_path, target)
      : undefined;

  const claimed = (context?.openWork ?? []).flatMap((work) => {
    const task = context?.tasks.get(work.task_id);
    return task === undefined ? [] : [task];
  });
  const claimedDetails = claimed.map((task) =>
    context?.details.tasks.get(task.id),
  );
  let standard: string | undefined;
  if (launched !== undefined)
    standard = `The task this agent was launched with, which must be finished in full:\n${launched}`;
  else if (context !== undefined && context.tasks.size > 0)
    standard = [
      planText(context.tasks.values(), context.details),
      claimed.length === 0
        ? ""
        : `This session's claimed tasks:\n${claimed.map((task, index) => taskText(task, claimedDetails[index])).join("\n\n")}`,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  else if (transcript !== undefined && transcript.userMessages.length > 0)
    standard = `The user's requests in this conversation:\n${recentRequests(transcript.userMessages, 40)}`;
  const rules =
    context === undefined
      ? undefined
      : rulesText(context.details.policy, claimedDetails);
  if (standard === undefined && (rules === undefined || !launch))
    return allow(deps.client, "PreToolUse");

  const judgment = deps.judgment();
  if (!isJudgment(judgment))
    return failOpen(
      deps.client,
      "PreToolUse",
      `no judgment source is usable (${judgment.unusable.map((skip) => `${skip.sourceId}: ${skip.reason}`).join("; ")}); the brief was not checked`,
    );

  const exceptions = exceptionsText(claimedDetails);
  const scopeInput =
    standard === undefined
      ? undefined
      : {
          standard,
          ...(exceptions === undefined ? {} : { exceptions }),
          brief,
        };
  const rulesInput =
    launch && rules !== undefined ? { rules, brief } : undefined;
  const [scope, carries] = await Promise.all([
    scopeInput === undefined
      ? undefined
      : runCheck(judgment, briefScopeBattery, scopeInput),
    rulesInput === undefined
      ? undefined
      : runCheck(judgment, briefCarriesRulesBattery, rulesInput),
  ]);

  const subject: Subject = {
    projectId: context?.projectId ?? null,
    sessionId: context?.session?.id ?? null,
    ...(context?.openWork.length === 1 && context.openWork[0] !== undefined
      ? { workId: context.openWork[0].id, taskId: context.openWork[0].task_id }
      : {}),
  };
  const base = {
    source: "hook:pretool",
    gate: true,
    evidence: {
      kind: "brief",
      ref: `${payload.tool_name}${target === undefined ? "" : `:${target}`}`,
      excerpt: brief.slice(0, 500),
    },
    ...(payload.session_id === undefined
      ? {}
      : { externalSessionId: payload.session_id }),
  };
  const entries: { subject: Subject; entry: NewEntry }[] = [];
  const reasons: string[] = [];
  const unavailable: string[] = [];
  if (scope !== undefined && scopeInput !== undefined) {
    const entry = entryFor(briefScopeBattery, scopeInput, scope, {
      ...base,
      reason: (decision) =>
        `narrows ${decision.narrows.toFixed(2)}, defers ${decision.defers.toFixed(2)}`,
    });
    if (entry !== undefined) entries.push({ subject, entry });
    if (scope.kind === "unavailable")
      unavailable.push(`brief-scope: ${scope.error}`);
    if (scope.kind === "verdict" && scope.run.decision.block)
      reasons.push(
        `brief-scope (narrows ${scope.run.decision.narrows.toFixed(2)}, defers ${scope.run.decision.defers.toFixed(2)}): the brief asks for less than ${launched === undefined ? "the plan and claimed tasks record" : "this agent's launch brief"}, or plans to leave part of the work for later; require the whole task now, or record the split in the ledger plan first`,
      );
  }
  if (carries !== undefined && rulesInput !== undefined) {
    const entry = entryFor(briefCarriesRulesBattery, rulesInput, carries, {
      ...base,
      reason: (decision) =>
        `governed ${decision.governed.toFixed(2)}, carries rules ${decision.carries.toFixed(2)}`,
    });
    if (entry !== undefined) entries.push({ subject, entry });
    if (carries.kind === "unavailable")
      unavailable.push(`brief-carries-rules: ${carries.error}`);
    if (carries.kind === "verdict" && carries.run.decision.block)
      reasons.push(
        `brief-carries-rules (governed ${carries.run.decision.governed.toFixed(2)}, carries ${carries.run.decision.carries.toFixed(2)}): the work falls under the project's recorded rules and the brief does not pass them on; add:\n${rulesInput.rules}`,
      );
  }
  const recordError = await recordEntries(deps.databasePath, entries);
  const notes = [
    ...unavailable.map((note) => `reading unavailable, not checked: ${note}`),
    ...(recordError === undefined ? [] : [recordError]),
  ];
  if (reasons.length > 0) {
    const result = deny(
      deps.client,
      `vibecheck-jev flagged this ${payload.tool_name}: ${reasons.join(" | ")}`,
    );
    return notes.length === 0
      ? result
      : { ...result, stderr: `vibecheck-jev: ${notes.join("; ")}\n` };
  }
  if (unavailable.length > 0)
    return failOpen(deps.client, "PreToolUse", notes.join("; "));
  return notes.length === 0
    ? allow(deps.client, "PreToolUse")
    : { stderr: `vibecheck-jev: ${notes.join("; ")}\n`, exitCode: 0 };
}
