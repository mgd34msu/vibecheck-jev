// Stop hook: sends the agent back to work when its final reply puts required
// work off, skips the user's question, asks permission for something already
// authorized, claims done while its open claims show work left, or states as
// fact what the turn's tool output does not show (read one sentence at a
// time, with evidence about the claimed files first).
//
// The standard comes from the ledger (this session's open claims and the
// project's authorizations); without a ledger project the user's recent
// messages stand in. A reply that confirms a pause the user asked for is not
// checked. Blocks per user message are capped, counted from ledger history,
// so a reading that keeps disagreeing cannot hold the turn open forever.

import { z } from "zod";
import { Database } from "../../db.js";
import {
  asksPermissionBattery,
  claimGroundedBattery,
  claimsDoneBattery,
  deferralBattery,
  questionAnsweredBattery,
  userPausesBattery,
} from "../batteries.js";
import { entryFor } from "../entries.js";
import { isJudgment, runCheck, type Judgment } from "../judgment.js";
import { settleMany } from "../lib/index.js";
import { resolveContext, type LedgerContext } from "../project.js";
import { authorizationsText, exceptionsText, taskText } from "../standard.js";
import {
  joinEvidence,
  recentRequests,
  replySentences,
  type TranscriptView,
} from "../transcript.js";
import {
  queryEntries,
  type NewEntry,
  type Subject,
} from "../../verification/store.js";
import {
  allow,
  blockStop,
  failOpen,
  parsePayload,
  readHookTranscript,
  recordEntries,
  stopPayloadSchema,
  type HookDeps,
  type HookResult,
} from "./io.js";

/** Blocks allowed per user message. */
export const MAX_BLOCKS = 2;

async function blocksSoFar(
  database: Database,
  sessionId: string,
  userMessage: number,
): Promise<number> {
  const entries = await database.unscoped(false, (access) =>
    queryEntries(access, {
      source: "hook:stop",
      kinds: ["verdict"],
      newest: true,
      limit: 500,
    }),
  );
  const times = new Set<string>();
  for (const entry of entries)
    if (
      entry.kind === "verdict" &&
      entry.body.external_session_id === sessionId &&
      entry.body.evidence?.line === userMessage &&
      entry.body.outcome === "flagged"
    )
      times.add(entry.created_at);
  return times.size;
}

function claimedText(context: LedgerContext | undefined): {
  text: string | undefined;
  paths: string[];
} {
  if (context === undefined || context.openWork.length === 0)
    return { text: undefined, paths: [] };
  const parts: string[] = [];
  const paths: string[] = [];
  for (const work of context.openWork) {
    const task = context.tasks.get(work.task_id);
    if (task === undefined) continue;
    parts.push(taskText(task, context.details.tasks.get(task.id)));
    paths.push(...work.location.paths);
  }
  return { text: parts.length === 0 ? undefined : parts.join("\n\n"), paths };
}

export async function stopHook(
  stdin: string,
  deps: HookDeps,
): Promise<HookResult> {
  const payload = parsePayload(stopPayloadSchema, stdin);
  if (typeof payload === "string")
    return failOpen(deps.client, "Stop", payload);
  const view: TranscriptView | undefined = readHookTranscript(deps, payload);
  const latest = view?.userMessages.at(-1);
  const reply = view?.lastReply ?? payload.last_assistant_message ?? undefined;
  if (latest === undefined || reply === undefined || reply.trim().length === 0)
    return allow(deps.client, "Stop");
  const userMessages = view?.userMessages ?? [];
  const sessionKey =
    payload.session_id ?? payload.child_session_id ?? "unknown";
  const database = new Database(deps.databasePath);
  if (
    (await blocksSoFar(database, sessionKey, userMessages.length)) >= MAX_BLOCKS
  )
    return allow(deps.client, "Stop");

  const judgment = deps.judgment();
  if (!isJudgment(judgment))
    return failOpen(
      deps.client,
      "Stop",
      `no judgment source is usable (${judgment.unusable.map((skip) => `${skip.sourceId}: ${skip.reason}`).join("; ")}); the reply was not checked`,
    );
  const context = await resolveContext(database, {
    ...(sessionKey === "unknown" ? {} : { sessionId: sessionKey }),
    ...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
  });
  return checkReply(deps, judgment, context, {
    sessionKey,
    latest,
    reply,
    finalText: view?.finalText,
    trigger: view?.trigger ?? "user",
    userMessages,
    evidence: view?.evidence ?? [],
    transcriptRef:
      typeof payload.transcript_path === "string"
        ? payload.transcript_path
        : deps.client === "muse"
          ? sessionKey
          : "last_assistant_message",
  });
}

const blockedSchema = z.looseObject({
  decision: z.string(),
  reason: z.string(),
});

/**
 * The SessionEnd hook: the stop checks run and the verdicts land in the
 * ledger, but the session is ending so a block becomes an advisory note.
 */
export async function sessionEndHook(
  stdin: string,
  deps: HookDeps,
): Promise<HookResult> {
  const result = await stopHook(stdin, deps);
  if (result.stdout === undefined) return result;
  let decision: unknown;
  try {
    decision = JSON.parse(result.stdout);
  } catch {
    return result;
  }
  const blocked = blockedSchema.safeParse(decision);
  if (!blocked.success || blocked.data.decision !== "block") return result;
  const notes = result.stderr ?? "";
  return {
    exitCode: 0,
    stderr: `${blocked.data.reason} Recorded in the ledger; the session is ending, so the reply was not held.\n${notes}`,
  };
}

interface ReplyInput {
  readonly sessionKey: string;
  readonly latest: string;
  readonly reply: string;
  readonly finalText: string | undefined;
  readonly trigger: "user" | "notification";
  readonly userMessages: readonly string[];
  readonly evidence: readonly string[];
  readonly transcriptRef: string;
}

async function checkReply(
  deps: HookDeps,
  judgment: Judgment,
  context: LedgerContext | undefined,
  input: ReplyInput,
): Promise<HookResult> {
  const entries: { subject: Subject; entry: NewEntry }[] = [];
  const unavailable: string[] = [];
  const subject: Subject = {
    projectId: context?.projectId ?? null,
    sessionId: context?.session?.id ?? null,
    ...(context?.openWork.length === 1 && context.openWork[0] !== undefined
      ? { workId: context.openWork[0].id, taskId: context.openWork[0].task_id }
      : {}),
  };
  const base = {
    source: "hook:stop",
    gate: false,
    evidence: {
      kind: "reply",
      ref: input.transcriptRef,
      excerpt: input.reply.slice(0, 500),
      line: input.userMessages.length,
    },
    externalSessionId: input.sessionKey,
  };

  const pause = await runCheck(judgment, userPausesBattery, {
    userMessage: input.latest,
  });
  if (pause.kind === "verdict" && pause.run.decision.pausing) {
    const entry = entryFor(
      userPausesBattery,
      { userMessage: input.latest },
      pause,
      {
        ...base,
        reason: () => "the user asked for a pause; the reply was not checked",
      },
    );
    await recordEntries(
      deps.databasePath,
      entry === undefined ? [] : [{ subject, entry }],
    );
    return allow(deps.client, "Stop");
  }

  const requests = recentRequests(input.userMessages);
  const claimed = claimedText(context);
  const standard =
    claimed.text === undefined
      ? requests
      : `${claimed.text}\n\nThe user's recent messages:\n${requests}`;
  const recorded = authorizationsText(context?.details.policy);
  const authorized = `${recorded ?? "No authorizations are recorded in the ledger."}\nThe user asked for the following in this conversation, which authorizes doing it:\n${requests}`;
  const evidence = joinEvidence(input.evidence, claimed.paths);
  const sentences = replySentences(input.reply);
  const exceptions =
    context === undefined
      ? undefined
      : exceptionsText(
          context.openWork.map((work) =>
            context.details.tasks.get(work.task_id),
          ),
        );

  const deferralInput = { standard, message: input.reply };
  const asksInput = { authorized, reply: input.reply };
  const claimsInput =
    claimed.text === undefined
      ? undefined
      : {
          task: claimed.text,
          ...(exceptions === undefined ? {} : { exceptions }),
          report: input.reply,
        };
  const [deferral, asks, claims, question, grounded] = await Promise.all([
    runCheck(judgment, deferralBattery, deferralInput),
    runCheck(judgment, asksPermissionBattery, asksInput),
    claimsInput === undefined
      ? undefined
      : runCheck(judgment, claimsDoneBattery, claimsInput),
    input.trigger === "user" ? answered(judgment, input) : undefined,
    settleMany(
      sentences,
      (sentence) =>
        runCheck(judgment, claimGroundedBattery, { reply: sentence, evidence }),
      16,
    ),
  ]);

  const reasons: string[] = [];
  const add = (entry: NewEntry | undefined) => {
    if (entry !== undefined) entries.push({ subject, entry });
  };
  add(
    entryFor(deferralBattery, deferralInput, deferral, {
      ...base,
      reason: (d) => `defers ${d.defers.toFixed(2)}`,
    }),
  );
  if (deferral.kind === "unavailable")
    unavailable.push(`deferral: ${deferral.error}`);
  if (deferral.kind === "verdict" && deferral.run.decision.block)
    reasons.push(
      `the reply puts required work off to a later time (defers ${deferral.run.decision.defers.toFixed(2)}); do the work now instead of promising it`,
    );

  add(
    entryFor(asksPermissionBattery, asksInput, asks, {
      ...base,
      reason: (d) => `asks ${d.asks.toFixed(2)}`,
    }),
  );
  if (asks.kind === "unavailable")
    unavailable.push(`asks-permission: ${asks.error}`);
  if (asks.kind === "verdict" && asks.run.decision.block)
    reasons.push(
      `the reply asks the user to approve something already authorized (asks ${asks.run.decision.asks.toFixed(2)}); do it instead of offering it`,
    );

  if (claims !== undefined && claimsInput !== undefined) {
    add(
      entryFor(claimsDoneBattery, claimsInput, claims, {
        ...base,
        reason: (d) => `overclaims ${d.overclaims.toFixed(2)}`,
      }),
    );
    if (claims.kind === "unavailable")
      unavailable.push(`claims-done: ${claims.error}`);
    if (claims.kind === "verdict" && claims.run.decision.block)
      reasons.push(
        `the reply presents the claimed task as done while it shows work left (overclaims ${claims.run.decision.overclaims.toFixed(2)}); finish it or say plainly what remains`,
      );
  }

  if (question !== undefined) {
    add(
      entryFor(questionAnsweredBattery, question.input, question.result, {
        ...base,
        reason: (d) =>
          `asks ${d.asks.toFixed(2)}, answered ${d.answered.toFixed(2)}`,
      }),
    );
    if (question.result.kind === "unavailable")
      unavailable.push(`question-answered: ${question.result.error}`);
    if (
      question.result.kind === "verdict" &&
      question.result.run.decision.block
    )
      reasons.push(
        `the user asked a question the reply does not answer up front (asks ${question.result.run.decision.asks.toFixed(2)}, answered ${question.result.run.decision.answered.toFixed(2)}); answer it first`,
      );
  }

  const ungrounded: string[] = [];
  grounded.forEach((settled, index) => {
    const sentence = sentences[index] ?? "";
    if (!settled.ok) {
      unavailable.push(`claim-grounded: ${String(settled.error)}`);
      return;
    }
    add(
      entryFor(
        claimGroundedBattery,
        { reply: sentence, evidence },
        settled.value,
        { ...base, reason: (d) => `ungrounded ${d.ungrounded.toFixed(2)}` },
      ),
    );
    if (settled.value.kind === "unavailable")
      unavailable.push(`claim-grounded: ${settled.value.error}`);
    if (settled.value.kind === "verdict" && settled.value.run.decision.block)
      ungrounded.push(
        `"${sentence}" (${settled.value.run.decision.ungrounded.toFixed(2)})`,
      );
  });
  if (ungrounded.length > 0)
    reasons.push(
      `the reply states as fact what the tool output does not show: ${ungrounded.join(", ")}; verify each with a command or say it is unverified`,
    );

  const recordError = await recordEntries(deps.databasePath, entries);
  const notes = [
    ...[...new Set(unavailable)].map(
      (note) => `reading unavailable, not checked: ${note}`,
    ),
    ...(recordError === undefined ? [] : [recordError]),
  ];
  if (reasons.length > 0) {
    const result = blockStop(`vibecheck-jev: ${reasons.join("; ")}.`);
    return notes.length === 0
      ? result
      : { ...result, stderr: `vibecheck-jev: ${notes.join("; ")}\n` };
  }
  if (unavailable.length > 0)
    return failOpen(deps.client, "Stop", notes.join("; "));
  const result = allow(deps.client, "Stop");
  return notes.length === 0
    ? result
    : { ...result, stderr: `vibecheck-jev: ${notes.join("; ")}\n` };
}

/** A turn that states a lookup, runs it, then answers is answering: the whole reply and the text after the last tool result are both read, and either answering is enough. */
async function answered(judgment: Judgment, input: ReplyInput) {
  const whole = { userMessage: input.latest, reply: input.reply };
  const first = await runCheck(judgment, questionAnsweredBattery, whole);
  if (
    first.kind !== "verdict" ||
    !first.run.decision.block ||
    input.finalText === undefined ||
    input.finalText === input.reply
  )
    return { input: whole, result: first };
  const final = { userMessage: input.latest, reply: input.finalText };
  return {
    input: final,
    result: await runCheck(judgment, questionAnsweredBattery, final),
  };
}
