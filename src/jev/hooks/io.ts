// Hook plumbing shared by the hooks: payload schemas for the clients, the
// dependencies a hook needs, and the response shapes each client reads.
//
// Claude Code, Codex and Muse send one JSON object on stdin. All carry
// `session_id`, `cwd` and `transcript_path` (nullable on Codex and Muse);
// PreToolUse adds `tool_name` and `tool_input`; stopping events add
// `last_assistant_message` and `stop_hook_active`. All clients read a
// PreToolUse denial from `hookSpecificOutput.permissionDecision` and a stop
// block from `{"decision":"block","reason":...}` on stdout.

import { existsSync } from "node:fs";
import { z } from "zod";
import { Database } from "../../db.js";
import type { SqlAccess } from "../../db.js";
import { museSessionsDir } from "../../paths.js";
import {
  appendEntry,
  type NewEntry,
  type Subject,
} from "../../verification/store.js";
import {
  findMuseSessionLog,
  readMuseTranscript,
  readTranscript,
  type Client,
  type TranscriptView,
} from "../transcript.js";
import type { Judgment } from "../judgment.js";
import type { SourceSkip } from "../lib/index.js";

export const preToolPayloadSchema = z.looseObject({
  session_id: z.string().optional(),
  transcript_path: z.string().nullable().optional(),
  cwd: z.string().optional(),
  tool_name: z.string(),
  tool_input: z.unknown(),
});
export type PreToolPayload = z.infer<typeof preToolPayloadSchema>;

export const stopPayloadSchema = z.looseObject({
  session_id: z.string().optional(),
  child_session_id: z.string().optional(),
  subagent_id: z.string().optional(),
  transcript_path: z.string().nullable().optional(),
  cwd: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().nullable().optional(),
});
export type StopPayload = z.infer<typeof stopPayloadSchema>;

export interface HookResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

export type HookEvent = "PreToolUse" | "Stop" | "SubagentStop" | "SessionEnd";

export interface HookDeps {
  readonly client: Client;
  readonly databasePath: string;
  /** Where Muse session logs live; the default store when unset. */
  readonly sessionsDir?: string;
  /** The configured chain, or why none is usable. Called only when a check will run. */
  readonly judgment: () =>
    Judgment | { readonly unusable: readonly SourceSkip[] };
}

export function parsePayload<T>(
  schema: z.ZodType<T>,
  text: string,
): T | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "hook input is not JSON";
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? parsed.data
    : `hook input is missing fields: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`;
}

/** Nothing to say: the tool call or the stop goes ahead. */
export function allow(client: Client, event: HookEvent): HookResult {
  if (client === "muse") return { exitCode: 0 };
  return event === "Stop" && client === "codex"
    ? { stdout: "{}", exitCode: 0 }
    : { exitCode: 0 };
}

/**
 * A check could not run. The hook fails open: the work goes ahead and the
 * reason goes to stderr. Claude Code shows a non-zero, non-2 exit as a
 * non-blocking error; Codex expects valid JSON from Stop and a zero exit,
 * and Muse a zero exit.
 */
export function failOpen(
  client: Client,
  event: HookEvent,
  message: string,
): HookResult {
  const stderr = `vibecheck-jev: ${message}\n`;
  if (client === "muse") return { stderr, exitCode: 0 };
  if (client === "codex")
    return {
      ...(event === "Stop" ? { stdout: "{}" } : {}),
      stderr,
      exitCode: 0,
    };
  return { stderr, exitCode: 1 };
}

/** The session's transcript: Muse names no file, so its log is found by session id. A missing or unreadable log reads as nothing to check against. */
export function readHookTranscript(
  deps: HookDeps,
  payload: {
    readonly transcript_path?: string | null | undefined;
    readonly session_id?: string | undefined;
    readonly child_session_id?: string | undefined;
  },
): TranscriptView | undefined {
  if (deps.client !== "muse")
    return typeof payload.transcript_path === "string"
      ? readTranscript(payload.transcript_path, deps.client)
      : undefined;
  const explicit = payload.transcript_path;
  if (typeof explicit === "string" && existsSync(explicit)) {
    try {
      return readMuseTranscript(explicit);
    } catch {
      return undefined;
    }
  }
  const sessionId = payload.session_id ?? payload.child_session_id;
  if (sessionId === undefined) return undefined;
  const found = findMuseSessionLog(
    deps.sessionsDir ?? museSessionsDir(),
    sessionId,
  );
  if (found === undefined) return undefined;
  try {
    return readMuseTranscript(found);
  } catch {
    return undefined;
  }
}

export function deny(reason: string): HookResult {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    exitCode: 0,
  };
}

export function blockStop(reason: string): HookResult {
  return {
    stdout: JSON.stringify({ decision: "block", reason }),
    exitCode: 0,
  };
}

/** Writes a hook's entries; a write failure never changes the hook's answer. */
export async function recordEntries(
  databasePath: string,
  entries: readonly { readonly subject: Subject; readonly entry: NewEntry }[],
): Promise<string | undefined> {
  if (entries.length === 0) return undefined;
  try {
    const database = new Database(databasePath);
    await database.unscoped(true, (access: SqlAccess) => {
      for (const { subject, entry } of entries)
        appendEntry(access, subject, entry);
    });
    return undefined;
  } catch (error) {
    return `could not record verdicts: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The text of a string field in an unknown tool input. */
export function inputString(
  input: unknown,
  ...keys: string[]
): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  for (const key of keys) {
    const value = Object.entries(input).find(([name]) => name === key)?.[1];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
