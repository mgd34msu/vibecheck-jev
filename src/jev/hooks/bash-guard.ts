// PreToolUse hook for the shell: refuses a delete through a variable path
// before the client's own confirmation prompt can stop the session. The agent
// gets the reason and rewrites the command. This matches a fixed shell syntax
// (rm, rmdir, unlink or shred in command position with an unguarded $VAR or
// ${VAR} expansion); it reads no prose and makes no judgment call.

import type { Client } from "../transcript.js";
import {
  allow,
  deny,
  inputString,
  parsePayload,
  preToolPayloadSchema,
  translateAntigravityPreTool,
  type HookResult,
} from "./io.js";

/** A delete in command position: at the start, or after a shell keyword, brace, subshell or xargs, optionally through sudo. */
const DELETE =
  /(?:^|[\s({`]|\$\()\s*(?:(?:do|then|else|xargs|exec|time|nohup)\s+(?:-\S+\s+)*)*(?:sudo\s+(?:-\S+\s+)*)?(?:rm|rmdir|unlink|shred)\s/u;

/** Whether a segment expands a $VAR, or a ${VAR...} without the :? guard that makes an empty value fail. */
export function hasUnguardedExpansion(segment: string): boolean {
  if (/\$[A-Za-z_]/u.test(segment)) return true;
  return [...segment.matchAll(/\$\{([^}]*)\}/gu)].some(
    (match) => !/^[A-Za-z_]\w*:\?/u.test(match[1] ?? ""),
  );
}

/** Single-quoted text is data: separators and expansions inside it do nothing. */
function stripQuoted(line: string): string {
  return line.replace(/'[^']*'/gu, "''");
}

/** The first simple command that deletes through an unguarded variable, if any. */
export function unguardedDelete(command: string): string | undefined {
  return stripQuoted(command)
    .split(/&&|\|\||;|\||\n/u)
    .find((segment) => DELETE.test(segment) && hasUnguardedExpansion(segment));
}

export function bashGuard(stdin: string, client: Client): HookResult {
  const payload =
    client === "antigravity"
      ? translateAntigravityPreTool(stdin)
      : parsePayload(preToolPayloadSchema, stdin);
  if (typeof payload === "string") return allow(client, "PreToolUse");
  const command = inputString(payload.tool_input, "command", "cmd") ?? "";
  const offending = unguardedDelete(command);
  if (offending === undefined) return allow(client, "PreToolUse");
  return deny(
    client,
    `Refused a delete through a variable path (${offending.trim().slice(0, 160)}). Rewrite it with literal absolute paths, or guard each variable as "\${VAR:?}" so an empty value fails. Never delete through an unguarded variable.`,
  );
}
