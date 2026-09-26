// Reads a session transcript into what the checks need: the user's messages,
// the agent's latest reply, what started the turn, and the tool results the
// reply's claims can be checked against.
//
// Claude Code writes one JSON entry per line with `type` user or assistant
// and a `message` whose content is text or blocks (text, tool_use,
// tool_result). Codex writes rollout lines `{ timestamp, type, payload }`:
// user input arrives as `event_msg` user_message or item_completed
// UserMessage events, replies as `response_item` messages with role
// assistant, tool calls as function_call or custom_tool_call items and their
// results as the matching *_output items. Lines that do not parse are skipped.
//
// Recognizing harness-inserted text (reminders, notices, injected context)
// matches the fixed markers each client writes; it does not read prose.

import { readFileSync } from "node:fs";
import { z } from "zod";

export type Client = "claude" | "codex";
export type TurnTrigger = "user" | "notification";

export interface TranscriptView {
  readonly userMessages: readonly string[];
  /** Every reply text since the user's last message. */
  readonly lastReply: string | undefined;
  /** The reply text after the turn's last tool result. */
  readonly finalText: string | undefined;
  readonly trigger: TurnTrigger;
  /** Tool results and commands, newest first, one segment each. */
  readonly evidence: readonly string[];
}

/** A long command is clipped; its first lines say what it does. */
const COMMAND_LIMIT = 1_200;
/** Evidence kept per reading, newest characters first. */
export const EVIDENCE_LIMIT = 60_000;
/** Earlier user-message segments of evidence kept besides the current one. */
const EVIDENCE_SEGMENTS = 3;

class ViewBuilder {
  readonly userMessages: string[] = [];
  lastReply: string | undefined;
  finalText: string | undefined;
  trigger: TurnTrigger = "user";
  #evidence: string[] = [];
  readonly #segments: string[][] = [];

  user(text: string): void {
    if (this.userMessages.at(-1) === text && this.lastReply === undefined)
      return;
    this.userMessages.push(text);
    this.lastReply = undefined;
    this.finalText = undefined;
    this.trigger = "user";
    this.#segments.push(this.#evidence);
    this.#evidence = [];
  }

  notice(text: string): void {
    this.lastReply = undefined;
    this.finalText = undefined;
    this.trigger = "notification";
    this.#evidence.push(text);
  }

  /** After a Stop-hook block the corrected reply is what follows the feedback. */
  resetReply(): void {
    this.lastReply = undefined;
    this.finalText = undefined;
  }

  reply(text: string): void {
    this.lastReply =
      this.lastReply === undefined ? text : `${this.lastReply}\n${text}`;
    this.finalText =
      this.finalText === undefined ? text : `${this.finalText}\n${text}`;
  }

  toolResult(text: string): void {
    this.#evidence.push(text);
    this.finalText = undefined;
  }

  toolCall(text: string): void {
    this.#evidence.push(text);
  }

  build(): TranscriptView {
    const evidence = [
      ...this.#segments.slice(-EVIDENCE_SEGMENTS).flat(),
      ...this.#evidence,
    ].reverse();
    return {
      userMessages: this.userMessages,
      lastReply: this.lastReply,
      finalText: this.finalText,
      trigger: this.trigger,
      evidence,
    };
  }
}

function lines(path: string): unknown[] {
  const values: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // a partial last line while the client is still writing
    }
  }
  return values;
}

function commandText(command: string, description?: string): string {
  return `${description === undefined ? "Command run:" : `Command run (${description}):`}\n$ ${command.slice(0, COMMAND_LIMIT)}`;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const claudeBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  content: z.unknown().optional(),
});
type ClaudeBlock = z.infer<typeof claudeBlockSchema>;

const claudeEntrySchema = z.looseObject({
  type: z.string(),
  message: z
    .looseObject({
      role: z.string().optional(),
      content: z.union([z.string(), z.array(z.unknown())]).optional(),
    })
    .optional(),
});

function claudeBlocks(content: unknown): ClaudeBlock[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const parsed = claudeBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}

function claudeText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  const texts = claudeBlocks(content)
    .filter((block) => block.type === "text" && block.text !== undefined)
    .map((block) => block.text ?? "");
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function claudeToolResult(content: unknown): string | undefined {
  const parts: string[] = [];
  for (const block of claudeBlocks(content)) {
    if (block.type !== "tool_result") continue;
    if (typeof block.content === "string") parts.push(block.content);
    else
      for (const inner of claudeBlocks(block.content))
        if (inner.text !== undefined) parts.push(inner.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function stringInput(block: ClaudeBlock, key: string): string | undefined {
  const value = block.input?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Commands and instructions an assistant entry sent: what its claims about running work rest on. */
function claudeToolCalls(content: unknown): string[] {
  const parts: string[] = [];
  for (const block of claudeBlocks(content)) {
    if (block.type !== "tool_use") continue;
    const command = stringInput(block, "command");
    if (block.name === "Bash" && command !== undefined) {
      parts.push(commandText(command, stringInput(block, "description")));
      continue;
    }
    if (
      block.name !== "Agent" &&
      block.name !== "Task" &&
      block.name !== "SendMessage"
    )
      continue;
    const text = stringInput(block, "prompt") ?? stringInput(block, "message");
    if (text !== undefined)
      parts.push(`Instruction sent by ${block.name}: ${text}`);
  }
  return parts;
}

const CLAUDE_HARNESS_MARKERS = [
  "<system-reminder>",
  "<task-notification>",
  "[SYSTEM NOTIFICATION",
  "Stop hook feedback",
  "<command-",
  "<local-command-",
];

function claudeIsNotice(text: string): boolean {
  const start = text.trimStart();
  return (
    start.startsWith("<task-notification>") ||
    start.startsWith("[SYSTEM NOTIFICATION") ||
    (start.startsWith("<system-reminder>") &&
      start.includes("<task-notification>"))
  );
}

export function readClaudeTranscript(path: string): TranscriptView {
  const view = new ViewBuilder();
  for (const value of lines(path)) {
    const parsed = claudeEntrySchema.safeParse(value);
    if (!parsed.success) continue;
    const entry = parsed.data;
    const content = entry.message?.content;
    if (entry.type === "user") {
      const result = claudeToolResult(content);
      if (result !== undefined) view.toolResult(result);
    }
    if (entry.type === "assistant")
      for (const call of claudeToolCalls(content)) view.toolCall(call);
    const text = claudeText(content);
    if (text === undefined) continue;
    if (entry.type === "user") {
      const start = text.trimStart();
      if (claudeIsNotice(text)) view.notice(text);
      else if (start.startsWith("Stop hook feedback")) view.resetReply();
      else if (
        start.length > 0 &&
        !CLAUDE_HARNESS_MARKERS.some((marker) => start.startsWith(marker))
      )
        view.user(text);
    }
    if (entry.type === "assistant") view.reply(text);
  }
  return view.build();
}

/** The prompt an agent was launched with, found by the agent id its launch result names. */
export function claudeLaunchBrief(
  path: string,
  agentId: string,
): string | undefined {
  const briefs = new Map<string, string>();
  let found: string | undefined;
  for (const value of lines(path)) {
    const parsed = claudeEntrySchema.safeParse(value);
    if (!parsed.success) continue;
    for (const block of claudeBlocks(parsed.data.message?.content)) {
      const prompt = stringInput(block, "prompt");
      if (
        block.type === "tool_use" &&
        (block.name === "Agent" || block.name === "Task") &&
        prompt !== undefined &&
        block.id !== undefined
      )
        briefs.set(block.id, prompt);
      if (
        block.type === "tool_result" &&
        block.tool_use_id !== undefined &&
        JSON.stringify(block.content ?? "").includes(agentId)
      )
        found = briefs.get(block.tool_use_id) ?? found;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const codexLineSchema = z.looseObject({
  type: z.string(),
  payload: z.unknown(),
});
const codexPayloadSchema = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  message: z.unknown().optional(),
  content: z.unknown().optional(),
  output: z.unknown().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
  input: z.string().optional(),
  item: z.unknown().optional(),
  replacement_history: z.array(z.unknown()).optional(),
  author: z.string().optional(),
});
const codexItemSchema = z.looseObject({
  type: z.string(),
  content: z.array(z.looseObject({ text: z.string().optional() })).optional(),
});
const codexContentSchema = z.array(
  z.looseObject({ type: z.string().optional(), text: z.string().optional() }),
);

function codexText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  const parsed = codexContentSchema.safeParse(content);
  if (!parsed.success) return undefined;
  const texts = parsed.data.flatMap((part) =>
    part.text === undefined ? [] : [part.text],
  );
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Context Codex injects as user-role messages; the user's own input arrives as events. */
const CODEX_INJECTED_MARKERS = [
  "<environment_context>",
  "<recommended_plugins>",
  "<user_instructions>",
  "<permissions",
  "<skills",
  "# AGENTS.md",
];

const codexArgumentsSchema = z.looseObject({
  cmd: z.union([z.string(), z.array(z.string())]).optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  message: z.string().optional(),
});

function codexCommand(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.join(" ");
}

export function readCodexTranscript(path: string): TranscriptView {
  const view = new ViewBuilder();
  let sawUserEvents = false;
  const entries = lines(path).flatMap((value) => {
    const line = codexLineSchema.safeParse(value);
    if (!line.success) return [];
    const payload = codexPayloadSchema.safeParse(line.data.payload);
    return payload.success
      ? [{ type: line.data.type, payload: payload.data }]
      : [];
  });
  for (const { type, payload } of entries)
    if (
      type === "event_msg" &&
      (payload.type === "user_message" ||
        (payload.type === "item_completed" &&
          codexItemSchema.safeParse(payload.item).data?.type === "UserMessage"))
    )
      sawUserEvents = true;
  for (const { type, payload } of entries) {
    if (type === "compacted") {
      for (const message of payload.replacement_history ?? []) {
        const parsed = codexPayloadSchema.safeParse(message);
        if (!parsed.success || parsed.data.role !== "user") continue;
        const text = codexText(parsed.data.content);
        if (
          text !== undefined &&
          !CODEX_INJECTED_MARKERS.some((marker) =>
            text.trimStart().startsWith(marker),
          )
        )
          view.user(text);
      }
      continue;
    }
    if (type === "event_msg") {
      if (
        payload.type === "user_message" &&
        typeof payload.message === "string"
      ) {
        view.user(payload.message);
        continue;
      }
      if (payload.type === "item_completed") {
        const item = codexItemSchema.safeParse(payload.item);
        if (item.success && item.data.type === "UserMessage") {
          const text = (item.data.content ?? [])
            .flatMap((part) => (part.text === undefined ? [] : [part.text]))
            .join("\n");
          if (text.length > 0) view.user(text);
        }
      }
      continue;
    }
    if (type !== "response_item") continue;
    switch (payload.type) {
      case "message": {
        const text = codexText(payload.content);
        if (text === undefined) break;
        if (payload.role === "assistant") view.reply(text);
        else if (
          payload.role === "user" &&
          !sawUserEvents &&
          !CODEX_INJECTED_MARKERS.some((marker) =>
            text.trimStart().startsWith(marker),
          )
        )
          view.user(text);
        break;
      }
      case "agent_message": {
        const text = codexText(payload.content);
        if (text !== undefined) view.notice(text);
        break;
      }
      case "function_call": {
        const args = codexArgumentsSchema.safeParse(
          safeJson(payload.arguments ?? ""),
        );
        const command = codexCommand(args.data?.cmd ?? args.data?.command);
        if (command !== undefined) view.toolCall(commandText(command));
        else if (
          args.data?.message !== undefined &&
          !isSealed(args.data.message)
        )
          view.toolCall(
            `Instruction sent by ${payload.name ?? "a tool"}: ${args.data.message}`,
          );
        break;
      }
      case "custom_tool_call":
        if (payload.input !== undefined)
          view.toolCall(commandText(payload.input));
        break;
      case "function_call_output":
      case "custom_tool_call_output": {
        const text = codexText(payload.output);
        if (text !== undefined && text.length > 0) view.toolResult(text);
        break;
      }
      default:
        break;
    }
  }
  return view.build();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Codex stores agent-to-agent messages as sealed Fernet tokens (version byte
 * 0x80, which base64url-encodes to a leading "gAAAAA"). A sealed brief cannot
 * be read, so no check runs on it.
 */
export function isSealed(text: string): boolean {
  return /^gAAAAA[A-Za-z0-9_-]+=*$/u.test(text.trim());
}

export function readTranscript(path: string, client: Client): TranscriptView {
  return client === "codex"
    ? readCodexTranscript(path)
    : readClaudeTranscript(path);
}

/** The user's standing request: the last few messages together, since an instruction is often followed by short corrections. */
export function recentRequests(messages: readonly string[], count = 6): string {
  return messages.slice(-count).join("\n---\n");
}

/**
 * A reply cut into sentences and list items so each claim is read against
 * the evidence on its own and a block can name the sentence. The split is on
 * line breaks and sentence-ending punctuation; empty fragments are dropped.
 */
export function replySentences(reply: string): string[] {
  return reply
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z`*(])/u)
    .map((sentence) => sentence.replace(/^[-*\d.\s#>|]+/u, "").trim())
    .filter((sentence) => /[A-Za-z0-9]/u.test(sentence));
}

/** Evidence joined for a reading: segments that mention a claimed path first, then the rest, clipped. */
export function joinEvidence(
  segments: readonly string[],
  claimedPaths: readonly string[] = [],
  limit = EVIDENCE_LIMIT,
): string {
  const scoped =
    claimedPaths.length === 0
      ? segments
      : [
          ...segments.filter((segment) =>
            claimedPaths.some((path) => segment.includes(path)),
          ),
          ...segments.filter(
            (segment) => !claimedPaths.some((path) => segment.includes(path)),
          ),
        ];
  const joined = scoped.join("\n---\n");
  return joined.length > limit ? joined.slice(0, limit) : joined;
}
