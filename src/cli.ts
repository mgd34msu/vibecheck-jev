#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { Board } from "./board.js";
import { configCommand, ensureConfig } from "./jev/config-file.js";
import {
  ConfigError,
  DEFAULT_HOOK_SECONDS,
  loadConfig,
  type Config,
} from "./jev/config.js";
import { bashGuard } from "./jev/hooks/bash-guard.js";
import {
  allow,
  failOpen,
  type HookDeps,
  type HookResult,
} from "./jev/hooks/io.js";
import { preToolHook } from "./jev/hooks/pretool.js";
import { stopHook } from "./jev/hooks/stop.js";
import { isJudgment, openJudgment } from "./jev/judgment.js";
import { layaCommand } from "./jev/laya.js";
import {
  exceptionCheckCommand,
  reportOfCommand,
  watchAgentsCommand,
} from "./jev/tools/agents.js";
import { checkCommand } from "./jev/tools/check.js";
import { UsageError, type ToolIO } from "./jev/tools/common.js";
import { labelCommand } from "./jev/tools/label.js";
import { fixturesCommand, measureCommand } from "./jev/tools/measure.js";
import { sourcesCommand } from "./jev/tools/sources.js";
import type { Client } from "./jev/transcript.js";
import { defaultDatabase, expandHome, type Environment } from "./paths.js";
import { identifierSchema } from "./schemas.js";
import { createHttpApp, createServer } from "./server.js";
import { LedgerVerifier } from "./verification/ledger.js";
import { version } from "./version.js";

export class CliUsageError extends Error {}

export { defaultDatabase };

const configurationSchema = z
  .object({
    transport: z.enum(["stdio", "streamable-http"]),
    database: z.string(),
    host: z
      .string()
      .min(1)
      .regex(/^[^\s/]+$/u, "--host must be a hostname or IP address"),
    port: z
      .string()
      .regex(/^[+-]?\d+$/, "--port must be an integer")
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535)),
    allowedHosts: z.array(
      z
        .string()
        .min(1)
        .regex(
          /^[^\s/]+$/u,
          "--allowed-host must be a Host value, optionally with a port",
        ),
    ),
    token: z.string(),
  })
  .superRefine((config, context) => {
    if (
      config.transport === "streamable-http" &&
      (!config.token || /\s/u.test(config.token))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "HTTP requires VIBECHECK_JEV_TOKEN with a nonempty token containing no whitespace",
      });
    }
  });
export type CliOptions = z.infer<typeof configurationSchema> & {
  projects: ReadonlySet<string> | undefined;
};

export function parseArgs(
  arguments_: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  config: Config = {},
): CliOptions {
  let values;
  try {
    ({ values } = parseNodeArgs({
      args: arguments_,
      allowPositionals: false,
      strict: true,
      options: {
        transport: { type: "string", default: "stdio" },
        database: {
          type: "string",
          default: defaultDatabase(environment, config.data ?? {}),
        },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "string", default: "8765" },
        "allowed-host": { type: "string", multiple: true, default: [] },
      },
    }));
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : "Invalid arguments.",
    );
  }
  const parsed = configurationSchema.safeParse({
    ...values,
    allowedHosts: values["allowed-host"],
    token: environment.VIBECHECK_JEV_TOKEN ?? "",
  });
  if (!parsed.success)
    throw new CliUsageError(
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  let projects: ReadonlySet<string> | undefined;
  if (environment.VIBECHECK_JEV_PROJECTS !== undefined) {
    const identifiers = z
      .array(identifierSchema)
      .safeParse(
        environment.VIBECHECK_JEV_PROJECTS.split(",").map((value) =>
          value.trim(),
        ),
      );
    if (!identifiers.success)
      throw new CliUsageError(
        "VIBECHECK_JEV_PROJECTS must be a comma-separated list of nonempty project IDs",
      );
    projects = new Set(identifiers.data);
  }
  return {
    ...parsed.data,
    database: expandHome(parsed.data.database),
    projects,
  };
}

const help = `vibecheck-jev: a work ledger for coding agents whose reports are checked.

Usage: vibecheck-jev [options]            run the MCP ledger server
  --transport stdio|streamable-http   Default: stdio
  --database PATH                    SQLite database path
  --host HOST                        Default: 127.0.0.1
  --port PORT                        Default: 8765
  --allowed-host HOST[:PORT]          Additional allowed Host; repeat as needed
  --version                          Print version
  --help                             Print this help

Commands:
  hook pretool|bash-guard|stop --client claude|codex   run a hook (reads stdin)
  measure fixtures [--runs N] [--source ID] [--battery ID]
  measure live [--project ID]
  measure replay [CHECK-ID] [--project ID] [--source ID]
  fixtures [--source ID] [--battery ID]
  label list|mark|mark-where|mark-last ...
  check brief|message|report|diff ...
  watch-agents --project ID [--session ID] | --transcript FILE...
  exception-check FILE...
  report-of AGENT-OR-SESSION-ID [DIRECTORY]
  sources [--source ID]                 probe each judgment source
  laya install | laya serve [--source ID] [--port N]
  config path | config init [--force] | config check

HTTP requires VIBECHECK_JEV_TOKEN. VIBECHECK_JEV_DB sets the database.
VIBECHECK_JEV_PROJECTS restricts access to comma-separated project IDs.
VIBECHECK_JEV_CONFIG sets the config file path.
`;

function toolIO(environment: Environment, config?: Config): ToolIO {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    env: environment,
    ...(config === undefined ? {} : { config }),
  };
}

const HOOKS = new Set(["pretool", "bash-guard", "stop"]);

/** Runs one hook over its stdin. A bad config or an overrun deadline fails open. */
export async function runHook(
  name: string,
  client: Client,
  stdin: string,
  environment: Environment,
): Promise<HookResult> {
  const event = name === "stop" ? "Stop" : "PreToolUse";
  let config: Config;
  try {
    config = loadConfig(environment);
  } catch (error) {
    return failOpen(
      client,
      event,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (name === "bash-guard")
    return config.hooks?.bashGuard === false
      ? { exitCode: 0 }
      : bashGuard(stdin);
  if (
    (name === "pretool" && config.hooks?.briefCheck === false) ||
    (name === "stop" && config.hooks?.stop === false)
  )
    return allow(client, event);
  const deps: HookDeps = {
    client,
    databasePath: defaultDatabase(environment, config.data ?? {}),
    judgment: () => openJudgment(config, { environment, autostart: true }),
  };
  const seconds =
    name === "stop"
      ? (config.hooks?.stopSeconds ?? DEFAULT_HOOK_SECONDS.stop)
      : (config.hooks?.briefCheckSeconds ?? DEFAULT_HOOK_SECONDS.briefCheck);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<HookResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          failOpen(
            client,
            event,
            `the readings took longer than ${seconds} seconds; the work goes ahead unchecked`,
          ),
        ),
      seconds * 1000,
    );
  });
  try {
    const work =
      name === "stop" ? stopHook(stdin, deps) : preToolHook(stdin, deps);
    return await Promise.race([work, deadline]);
  } catch (error) {
    return failOpen(
      client,
      event,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Codex payloads carry `turn_id`; Claude Code's do not. The flag names the client when the payload is ambiguous. */
export function detectClient(stdin: string, flag: Client): Client {
  try {
    const value: unknown = JSON.parse(stdin);
    if (typeof value === "object" && value !== null && "turn_id" in value)
      return "codex";
  } catch {
    return flag;
  }
  return flag;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    );
  return Buffer.concat(chunks).toString("utf8");
}

const COMMANDS: Record<
  string,
  (args: string[], io: ToolIO) => Promise<number>
> = {
  measure: measureCommand,
  fixtures: fixturesCommand,
  label: labelCommand,
  check: checkCommand,
  "watch-agents": watchAgentsCommand,
  "exception-check": exceptionCheckCommand,
  "report-of": reportOfCommand,
  sources: sourcesCommand,
  config: configCommand,
};

/** Runs a subcommand; returns its exit code, or undefined when the arguments are server options. */
export async function runCommand(
  arguments_: string[],
  environment: Environment,
): Promise<number | undefined> {
  const [command, ...rest] = arguments_;
  if (command === "hook") {
    const { values, positionals } = parseNodeArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { client: { type: "string", default: "claude" } },
    });
    const name = positionals[0];
    const stdin = await readStdin();
    const client = detectClient(
      stdin,
      values.client === "codex" ? "codex" : "claude",
    );
    if (name === undefined || !HOOKS.has(name))
      throw new CliUsageError(
        "usage: hook pretool|bash-guard|stop --client claude|codex",
      );
    ensureConfig(environment);
    const result = await runHook(name, client, stdin, environment);
    if (result.stdout !== undefined) process.stdout.write(result.stdout);
    if (result.stderr !== undefined) process.stderr.write(result.stderr);
    return result.exitCode;
  }
  const tool = command === undefined ? undefined : COMMANDS[command];
  if (command === "laya") {
    ensureConfig(environment);
    return layaCommand(rest, {
      ...toolIO(environment),
      config: loadConfig(environment),
    });
  }
  if (tool === undefined) return undefined;
  ensureConfig(environment);
  return tool(rest, toolIO(environment));
}

function openVerifier(
  config: Config,
  environment: Environment,
): LedgerVerifier | undefined {
  if (config.ledger?.verify === false) return undefined;
  const judgment = openJudgment(config, { environment, autostart: true });
  if (!isJudgment(judgment)) {
    process.stderr.write(
      `vibecheck-jev: ledger checks are off: ${judgment.unusable.map((skip) => `${skip.sourceId}: ${skip.reason}`).join("; ")}\n`,
    );
    return undefined;
  }
  return new LedgerVerifier(judgment);
}

export async function main(
  arguments_: string[] = process.argv.slice(2),
): Promise<void> {
  if (arguments_.includes("--version")) {
    process.stdout.write(`vibecheck-jev ${version}\n`);
    return;
  }
  if (arguments_.includes("--help") || arguments_.includes("-h")) {
    process.stdout.write(help);
    return;
  }
  const code = await runCommand(arguments_, process.env);
  if (code !== undefined) {
    process.exitCode = code;
    return;
  }
  ensureConfig(process.env);
  let config: Config = {};
  try {
    config = loadConfig(process.env);
  } catch (error) {
    process.stderr.write(
      `vibecheck-jev: ${error instanceof Error ? error.message : String(error)}; running with defaults and ledger checks off\n`,
    );
    config = { ledger: { verify: false } };
  }
  const options = parseArgs(arguments_, process.env, config);
  const verifier = openVerifier(config, process.env);
  const board = new Board(
    options.database,
    verifier === undefined ? {} : { verifier },
  );
  const http =
    options.transport === "stdio"
      ? undefined
      : createHttpApp(board, {
          token: options.token,
          host: options.host,
          allowedHosts: options.allowedHosts,
          ...(options.projects === undefined
            ? {}
            : { projects: options.projects }),
        });
  const lifecycle =
    http ??
    serveStdio(() => createServer(board, options.projects), {
      onerror: () => process.stderr.write("MCP transport error.\n"),
    });
  try {
    if (http !== undefined)
      await new Promise<void>((resolveListening, reject) => {
        const failed = (error: Error) => reject(error);
        http.server.once("error", failed);
        http.server.listen(options.port, options.host, () => {
          http.server.off("error", failed);
          resolveListening();
        });
      });
    await new Promise<void>((resolveStopped) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.stdin.off("end", stop);
        resolveStopped();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (options.transport === "stdio") {
        process.stdin.once("end", stop);
        if (process.stdin.readableEnded) stop();
      }
    });
  } finally {
    await lifecycle.close();
  }
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(entry)).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      error instanceof CliUsageError ||
        error instanceof UsageError ||
        error instanceof ConfigError
        ? `${error.message}\n`
        : `vibecheck-jev failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode =
      error instanceof CliUsageError || error instanceof UsageError ? 2 : 1;
  }
}
