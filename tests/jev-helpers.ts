import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export function writeTranscript(
  t: TestContext,
  lines: readonly unknown[],
): string {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-jev-transcript-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  writeFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"partial`,
  );
  return path;
}

export const CLAUDE_LINES = [
  {
    type: "user",
    message: {
      role: "user",
      content: "<system-reminder>context</system-reminder>",
    },
  },
  {
    type: "user",
    message: { role: "user", content: "Add a CSV export to the reports page." },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Running the report tests first." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: {
            command: "npm test tests/reports",
            description: "Run the report tests",
          },
        },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "PASS tests/reports/csv.test.ts\nTests: 12 passed",
        },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Agent",
          input: {
            prompt:
              "Write tests for src/reports/csv.ts until every function has one.",
            description: "tests",
          },
        },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_2",
          content: [
            {
              type: "text",
              text: "Async agent launched successfully. agentId: a1b2c3",
            },
          ],
        },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "All 12 report tests pass. The CSV export is in src/reports/csv.ts.",
        },
      ],
    },
  },
];

export const CODEX_LINES = [
  {
    timestamp: "2026-09-26T04:53:20.635Z",
    type: "session_meta",
    payload: {
      session_id: "019c-session",
      id: "019c-session",
      cwd: "/work/shop",
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "<environment_context>\n  <cwd>/work/shop</cwd>\n</environment_context>",
        },
      ],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the failing checkout test." }],
    },
  },
  {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "UserMessage",
        content: [{ type: "text", text: "Fix the failing checkout test." }],
      },
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "Running the checkout test." }],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_1",
      input:
        'text(await tools.exec_command({cmd:"npm test tests/checkout.test.ts"}));',
    },
  },
  {
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: "call_1",
      output: [
        { type: "input_text", text: "Script completed\nOutput:\n" },
        {
          type: "input_text",
          text: '{"exit_code":0,"output":"PASS tests/checkout.test.ts"}',
        },
      ],
    },
  },
  {
    type: "response_item",
    payload: {
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      arguments:
        '{"task_name":"review","message":"gAAAAABqt0_K-wCQt7-45BY62WRoQnWXXG1Yb4RExlZZO63jgNIabR7WA38_DxblOhT4nWCZS8iOTFjVx7sMbD4WH2DebySNEy6jPlavwP_mVVPW8U_T066mGtlOWgfIAUTh0d_Pa_dQ1MFMZf2ce8BPf_Qhux3FsQ=="}',
      call_id: "call_2",
    },
  },
  {
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_2",
      output: '{"task_name":"/root/review"}',
    },
  },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "The checkout test passes now." }],
    },
  },
];
