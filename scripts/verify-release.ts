import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  chmod,
  cp,
  lstat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  artifactNames,
  BUNDLE,
  commonFiles,
  generateBundle,
  generateNotices,
  hookFile,
  LAUNCHER,
  MUSE_HOOKS,
  packageVersion,
  platforms,
  pluginFiles,
  PRODUCT,
  root,
  run,
  sha256,
} from "./build-release.js";
import type { Platform } from "./build-release.js";

export type Runtime = "bun" | "node";
export const runtimes: Runtime[] = ["bun", "node"];
const toolNames = [
  "project_join",
  "plan_publish",
  "plan_edit",
  "plan_ack",
  "plan_read",
  "work_claim",
  "work_update",
  "project_status",
  "work_history",
].sort();
const manifestSchema = z.object({
  name: z.literal(PRODUCT),
  version: z.string(),
  hooks: z.string().optional(),
  mcpServers: z.object({
    "vibecheck-jev": z.object({
      command: z.literal("bash"),
      args: z.array(z.string()),
      cwd: z.string().optional(),
    }),
  }),
});
const hooksSchema = z.object({
  hooks: z.record(
    z.string(),
    z.array(
      z.object({
        matcher: z.string().optional(),
        hooks: z.array(
          z.object({
            type: z.literal("command"),
            command: z.string(),
            commandWindows: z.string().optional(),
            timeout: z.number().int().positive(),
          }),
        ),
      }),
    ),
  ),
});
const museHookSchema = z.object({
  id: z.string(),
  event: z.string(),
  command: z.array(z.string()),
  timeoutMs: z.number().int().positive(),
});
const museManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.literal(PRODUCT),
  version: z.string(),
  capabilities: z.object({
    skills: z.tuple([
      z.object({
        id: z.literal(PRODUCT),
        path: z.literal("skills/vibecheck-jev/SKILL.md"),
      }),
    ]),
    hooks: z.tuple([
      museHookSchema,
      museHookSchema,
      museHookSchema,
      museHookSchema,
    ]),
    mcpServers: z.tuple([
      z.object({
        id: z.literal(PRODUCT),
        transport: z.literal("stdio"),
        command: z.tuple([
          z.literal("bash"),
          z.literal(LAUNCHER),
          z.literal("--transport"),
          z.literal("stdio"),
        ]),
      }),
    ]),
  }),
});

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function verifyMuseManifest(
  directory: string,
  version: string,
): Promise<void> {
  const manifest = museManifestSchema.parse(
    await json(join(directory, ".muse-plugin/plugin.json")),
  );
  assert.equal(manifest.version, version);
  assert.deepEqual(
    manifest.capabilities.hooks.map((hook) => [
      hook.id,
      hook.event,
      hook.command,
    ]),
    [
      ["pretool", "PreToolUse", ["bash", "hooks/muse-pretool.sh"]],
      ["bash-guard", "PreToolUse", ["bash", "hooks/muse-bash-guard.sh"]],
      [
        "subagent-stop",
        "SubagentStop",
        ["bash", "hooks/muse-subagent-stop.sh"],
      ],
      ["session-end", "SessionEnd", ["bash", "hooks/muse-session-end.sh"]],
    ],
  );
  assert.deepEqual([...MUSE_HOOKS].sort(), [
    "hooks/muse-bash-guard.sh",
    "hooks/muse-pretool.sh",
    "hooks/muse-session-end.sh",
    "hooks/muse-subagent-stop.sh",
  ]);
  const wrappers: [string, string][] = [
    ["hooks/muse-pretool.sh", "pretool"],
    ["hooks/muse-bash-guard.sh", "bash-guard"],
    ["hooks/muse-subagent-stop.sh", "stop"],
    ["hooks/muse-session-end.sh", "session-end"],
  ];
  for (const [wrapper, hook] of wrappers) {
    const script = await readFile(join(directory, wrapper), "utf8");
    assert.ok(
      script.includes(`/${LAUNCHER}" hook ${hook} --client muse`),
      `${wrapper} runs ${hook} through the launcher`,
    );
  }
}

export async function verifyVersions(directory: string): Promise<string> {
  const version = await packageVersion(directory);
  for (const platform of platforms) {
    if (platform === "muse") {
      await verifyMuseManifest(directory, version);
      continue;
    }
    const manifest = manifestSchema.parse(
      await json(join(directory, `.${platform}-plugin/plugin.json`)),
    );
    assert.equal(manifest.version, version);
    const catalog = z
      .object({
        name: z.literal(PRODUCT),
        plugins: z
          .array(z.object({ name: z.literal(PRODUCT), source: z.unknown() }))
          .length(1),
      })
      .parse(
        await json(
          join(
            directory,
            platform === "codex"
              ? ".agents/plugins/marketplace.json"
              : ".claude-plugin/marketplace.json",
          ),
        ),
      );
    assert.deepEqual(
      catalog.plugins[0]?.source,
      platform === "codex" ? { source: "local", path: "./" } : "./",
    );
    assert.deepEqual(manifest.mcpServers["vibecheck-jev"].args, [
      platform === "codex" ? LAUNCHER : `\${CLAUDE_PLUGIN_ROOT}/${LAUNCHER}`,
      "--transport",
      "stdio",
    ]);
    assert.equal(
      manifest.mcpServers["vibecheck-jev"].cwd,
      platform === "codex" ? "." : undefined,
    );
    const hooksPath = hookFile(platform);
    assert.ok(typeof hooksPath === "string");
    assert.equal(
      manifest.hooks,
      platform === "codex" ? `./${hooksPath}` : undefined,
    );
    const hooks = hooksSchema.parse(await json(join(directory, hooksPath)));
    const root =
      platform === "codex" ? "$PLUGIN_ROOT" : "${CLAUDE_PLUGIN_ROOT}";
    for (const [event, groups] of Object.entries(hooks.hooks))
      for (const group of groups)
        for (const hook of group.hooks) {
          assert.ok(
            hook.command.startsWith(`bash "${root}/${LAUNCHER}" hook `),
            `${platform} ${event} hook runs through the launcher`,
          );
          assert.equal(hook.commandWindows !== undefined, platform === "codex");
        }
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ["PreToolUse", "Stop"]);
  }
  const skill = await readFile(
    join(directory, "skills/vibecheck-jev/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\nname: vibecheck-jev\ndescription: .+\n---\n/u);
  return version;
}

export async function exercisePlugin(
  directory: string,
  platform: Platform,
  runtime: Runtime,
  database: string,
  workingDirectory: string,
  expectedVersion: string,
): Promise<void> {
  let command: string;
  let arguments_: string[];
  let cwd: string;
  if (platform === "muse") {
    const manifest = museManifestSchema.parse(
      await json(join(directory, ".muse-plugin/plugin.json")),
    );
    const [entry, script, ...flags] =
      manifest.capabilities.mcpServers[0].command;
    command = entry;
    arguments_ = [resolve(directory, script), ...flags];
    cwd = workingDirectory;
  } else {
    const manifest = manifestSchema.parse(
      await json(join(directory, `.${platform}-plugin/plugin.json`)),
    );
    const server = manifest.mcpServers["vibecheck-jev"];
    arguments_ = server.args.map((value) =>
      value.replaceAll("${CLAUDE_PLUGIN_ROOT}", directory),
    );
    assert.ok(
      arguments_.every((value) => !value.includes("${")),
      "Unresolved plugin variable",
    );
    command = server.command;
    cwd =
      platform === "codex"
        ? resolve(directory, server.cwd ?? ".")
        : workingDirectory;
  }
  const client = new Client({
    name: "vibecheck-jev-release-verifier",
    version: "1.0.0",
  });
  const configHome = await mkdtemp(join(tmpdir(), "vibecheck-jev-config-"));
  const transport = new StdioClientTransport({
    command,
    args: [...arguments_, "--database", database],
    cwd,
    env: {
      ...getDefaultEnvironment(),
      VIBECHECK_JEV_RUNTIME: runtime,
      VIBECHECK_JEV_PROJECTS: "release-test",
      XDG_CONFIG_HOME: configHome,
    },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    diagnostics += String(chunk);
  });
  const deadline = setTimeout(() => {
    void client.close();
  }, 30_000);
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, expectedVersion);
    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), toolNames);
    for (const tool of listing.tools)
      assert.deepEqual(tool.inputSchema.required, ["request"]);
    async function call(
      name: string,
      request: Record<string, unknown>,
    ): Promise<unknown> {
      const result = await client.callTool({
        name,
        arguments: { request: { project_id: "release-test", ...request } },
      });
      assert.notEqual(
        result.isError,
        true,
        `${name}: ${JSON.stringify(result)}`,
      );
      return result.structuredContent;
    }
    const joined = z.object({ session_id: z.string() }).parse(
      await call("project_join", {
        request_id: "join",
        repository: "release-fixture",
        vendor: "verification",
        runtime,
        external_session_id: "release-session",
        model: "no-model-executed",
      }),
    );
    const session = { session_id: joined.session_id };
    await call("plan_publish", {
      ...session,
      request_id: "publish",
      expected_revision: 0,
      tasks: [{ id: "implement", label: "Initial scope" }],
    });
    const plan = z
      .object({ plan_revision: z.number() })
      .parse(await call("plan_read", {}));
    await call("plan_ack", {
      ...session,
      request_id: "ack",
      plan_revision: plan.plan_revision,
    });
    await call("plan_edit", {
      ...session,
      request_id: "edit",
      expected_revision: plan.plan_revision,
      operations: [
        { op: "update", task_id: "implement", label: "Released scope" },
      ],
    });
    const claimed = z
      .object({
        task: z.object({ revision: z.number() }),
        work: z.object({ id: z.string(), revision: z.number() }),
      })
      .parse(
        await call("work_claim", {
          ...session,
          request_id: "claim",
          task_id: "implement",
          expected_revision: 2,
          location: { branch: "release/topic", paths: ["src/example.ts"] },
        }),
      );
    await call("work_update", {
      ...session,
      request_id: "complete",
      updates: [
        {
          work_id: claimed.work.id,
          expected_revision: claimed.work.revision,
          expected_task_revision: claimed.task.revision,
          status: "complete",
        },
      ],
    });
    const status = z
      .object({ tasks: z.record(z.string(), z.object({ status: z.string() })) })
      .parse(await call("project_status", { full: true }));
    assert.equal(status.tasks.implement?.status, "complete");
    const history = z
      .object({ work: z.array(z.object({ id: z.string() })) })
      .parse(await call("work_history", { task_id: "implement" }));
    assert.ok(history.work.some((work) => work.id === claimed.work.id));
    const forbidden = await client.callTool({
      name: "project_status",
      arguments: { request: { project_id: "unlisted" } },
    });
    assert.equal(forbidden.isError, true);
  } catch (error) {
    throw new Error(`${platform}/${runtime} at ${directory}: ${diagnostics}`, {
      cause: error,
    });
  } finally {
    clearTimeout(deadline);
    await client.close();
    await rm(configHome, { recursive: true, force: true });
  }
  exerciseHooks(directory, platform, runtime, database);
}

/**
 * Runs each hook through the plugin's launcher with a client payload. The
 * delete guard must refuse an unguarded delete; with no judgment source
 * configured the brief check and the Stop checks must fail open.
 */
export function exerciseHooks(
  directory: string,
  platform: Platform,
  runtime: Runtime,
  database: string,
): void {
  const environment = {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
    VIBECHECK_JEV_RUNTIME: runtime,
    VIBECHECK_JEV_DB: database,
    XDG_CONFIG_HOME: join(
      tmpdir(),
      `vibecheck-jev-hook-config-${process.pid}-${platform}-${runtime}`,
    ),
    XDG_DATA_HOME: join(
      tmpdir(),
      `vibecheck-jev-hook-data-${process.pid}-${platform}-${runtime}`,
    ),
  };
  const common = {
    session_id: "release-hook-session",
    cwd: tmpdir(),
    transcript_path: null,
    ...(platform === "claude"
      ? {}
      : {
          turn_id: "release-turn",
          model: "release-model",
          permission_mode: "default",
          ...(platform === "muse" ? { model_provider: "meta" } : {}),
        }),
  };
  const hook = (name: string, payload: object) =>
    spawnSync(
      "bash",
      [join(directory, LAUNCHER), "hook", name, "--client", platform],
      {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: environment,
        timeout: 30_000,
      },
    );
  const guarded = hook("bash-guard", {
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: 'rm -rf "$TARGET/build"' },
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /"permissionDecision":"deny"/u);
  const allowed = hook("bash-guard", {
    ...common,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: 'rm -rf "${TARGET:?}/build"' },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "");
  const stop = hook(
    "stop",
    platform === "muse"
      ? {
          ...common,
          hook_event_name: "SubagentStop",
          stop_hook_active: false,
          last_assistant_message: "Done.",
          child_session_id: "release-hook-session",
          subagent_id: "release-subagent",
        }
      : {
          ...common,
          hook_event_name: "Stop",
          stop_hook_active: false,
          last_assistant_message: "Done.",
        },
  );
  assert.notEqual(stop.status, 2, stop.stderr);
  assert.doesNotMatch(stop.stdout, /"decision":"block"/u);
  if (platform === "muse") {
    const ended = hook("session-end", {
      session_id: "release-hook-session",
      cwd: tmpdir(),
      transcript_path: null,
      hook_event_name: "SessionEnd",
      model: "release-model",
      model_provider: "meta",
      permission_mode: "default",
      reason: "other",
    });
    assert.notEqual(ended.status, 2, ended.stderr);
    assert.doesNotMatch(ended.stdout, /"decision":"block"/u);
  }
  rmSync(environment.XDG_CONFIG_HOME, { recursive: true, force: true });
  rmSync(environment.XDG_DATA_HOME, { recursive: true, force: true });
}

function inventory(output: string, expected: string[]): void {
  const entries = output.trim().split("\n");
  assert.equal(
    new Set(entries).size,
    entries.length,
    "Duplicate archive entries",
  );
  const files = expected.map((file) => `${PRODUCT}/${file}`);
  for (const entry of entries) {
    const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    assert.ok(
      (name === PRODUCT || name.startsWith(`${PRODUCT}/`)) &&
        !name.includes("\\") &&
        name
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
      `Unsafe archive entry ${entry}`,
    );
    if (entry.endsWith("/"))
      assert.ok(
        files.some((file) => file.startsWith(entry)),
        `Unexpected archive directory ${entry}`,
      );
  }
  assert.deepEqual(
    entries.filter((entry) => !entry.endsWith("/")).sort(),
    files.sort(),
  );
}

async function makeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await makeReadOnly(path);
    else await chmod(path, entry.name === "vibecheck-jev.sh" ? 0o555 : 0o444);
  }
  await chmod(directory, 0o555);
}

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
  }
}

async function compareFiles(directory: string, files: string[]): Promise<void> {
  for (const file of files) {
    const target = join(directory, file);
    assert.ok((await lstat(target)).isFile(), `${file} is not a regular file`);
    assert.deepEqual(
      await readFile(target),
      await readFile(join(root, file)),
      `Archive bytes differ: ${file}`,
    );
  }
}

export async function verifyNativeInstall(
  directory: string,
  platform: Platform,
  temporary: string,
): Promise<void> {
  const sandbox = join(temporary, `${platform}-native`);
  await mkdir(sandbox, { recursive: true });
  const arguments_ = [
    "--die-with-parent",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    temporary,
    temporary,
  ];
  for (const name of [".codex", ".agents", ".claude", ".cache"]) {
    const isolated = join(sandbox, name);
    await mkdir(isolated, { recursive: true });
    arguments_.push("--bind", isolated, join(homedir(), name));
  }
  for (const relative of [".local/share/muse", ".config/muse"]) {
    const isolated = join(sandbox, relative);
    await mkdir(isolated, { recursive: true });
    if (relative === ".local/share/muse") {
      // Muse disables plugins without its feature and model caches, which
      // it cannot fetch inside the sandbox, so seed them. No plugin state
      // comes along: the install starts from an empty store.
      for (const seed of ["feature-config", "model-catalog"]) {
        try {
          await cp(join(homedir(), relative, seed), join(isolated, seed), {
            recursive: true,
          });
        } catch {
          // a fresh machine has no cache to seed
        }
      }
    }
    arguments_.push("--bind", isolated, join(homedir(), relative));
  }
  const userFile = join(sandbox, ".claude.json");
  await writeFile(userFile, "{}\n");
  arguments_.push(
    "--bind",
    userFile,
    join(homedir(), ".claude.json"),
    "--chdir",
    temporary,
  );
  let cached: string;
  let installedVersion: string;
  if (platform === "muse") {
    // Muse refuses directories with symlinks, so the native install runs
    // from a clean staging of the shipped files, like an extracted archive.
    const staged = join(temporary, "muse-native-source");
    await mkdir(staged, { recursive: true });
    for (const file of pluginFiles("muse")) {
      const target = join(staged, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(directory, file), target);
    }
    run("bwrap", [...arguments_, "muse", "plugins", "validate", staged]);
    run("bwrap", [...arguments_, "muse", "plugins", "install", staged]);
    const listing = z
      .object({
        plugins: z.array(
          z.object({
            plugin: z.object({
              capabilities: z.object({
                hooks: z.array(z.object({ source_path: z.string() })),
              }),
            }),
          }),
        ),
      })
      .parse(
        JSON.parse(
          run("bwrap", [...arguments_, "muse", "plugins", "list", "--json"]),
        ),
      );
    const hookPath = listing.plugins
      .at(0)
      ?.plugin.capabilities.hooks.at(0)?.source_path;
    assert.ok(hookPath !== undefined);
    const packaged = dirname(dirname(hookPath));
    const home = homedir();
    assert.ok(packaged.startsWith(`${home}/`));
    cached = join(sandbox, packaged.slice(home.length + 1));
    installedVersion = museManifestSchema.parse(
      await json(join(staged, ".muse-plugin/plugin.json")),
    ).version;
  } else {
    if (platform === "codex") {
      run("bwrap", [
        ...arguments_,
        "codex",
        "plugin",
        "marketplace",
        "add",
        directory,
      ]);
      run("bwrap", [
        ...arguments_,
        "codex",
        "plugin",
        "add",
        `${PRODUCT}@${PRODUCT}`,
      ]);
      assert.match(
        run("bwrap", [...arguments_, "codex", "plugin", "list"]),
        /vibecheck-jev/u,
      );
    } else {
      run("bwrap", [...arguments_, "claude", "plugin", "validate", directory]);
      run("bwrap", [
        ...arguments_,
        "claude",
        "plugin",
        "marketplace",
        "add",
        directory,
      ]);
      run("bwrap", [
        ...arguments_,
        "claude",
        "plugin",
        "install",
        `${PRODUCT}@${PRODUCT}`,
      ]);
      assert.match(
        run("bwrap", [...arguments_, "claude", "plugin", "list"]),
        /vibecheck-jev/u,
      );
    }
    const manifest = manifestSchema.parse(
      await json(join(directory, `.${platform}-plugin/plugin.json`)),
    );
    installedVersion = manifest.version;
    cached = join(
      sandbox,
      platform === "codex" ? ".codex" : ".claude",
      `plugins/cache/${PRODUCT}/${PRODUCT}`,
      manifest.version,
    );
  }
  await rm(join(cached, "node_modules"), { recursive: true, force: true });
  await makeReadOnly(cached);
  try {
    for (const runtime of runtimes)
      await exercisePlugin(
        cached,
        platform,
        runtime,
        join(temporary, `${runtime}-cached.sqlite3`),
        temporary,
        installedVersion,
      );
  } finally {
    await makeWritable(cached);
  }
}

export async function verifyRelease(
  outputDirectory = join(root, "artifacts"),
  native = false,
): Promise<void> {
  const version = await verifyVersions(root);
  assert.equal(
    sha256(await readFile(join(root, BUNDLE))),
    sha256(await generateBundle()),
    "Committed runtime is stale; run bun run build:release",
  );
  assert.equal(
    await readFile(join(root, "runtime/THIRD-PARTY-NOTICES.txt"), "utf8"),
    await generateNotices(),
    "Bundled dependency notices are stale; run bun run build:release",
  );
  const lines = (await readFile(join(outputDirectory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  const checksums = lines.map((line) => {
    const parts = /^(?<digest>[0-9a-f]{64})  (?<name>[A-Za-z0-9_.-]+)$/u.exec(
      line,
    )?.groups;
    return z.object({ digest: z.string(), name: z.string() }).parse(parts);
  });
  assert.deepEqual(
    checksums.map((entry) => entry.name).sort(),
    artifactNames(version),
  );
  for (const entry of checksums)
    assert.equal(
      sha256(await readFile(join(outputDirectory, entry.name))),
      entry.digest,
      entry.name,
    );
  const temporary = await mkdtemp(
    join(tmpdir(), "vibecheck-jev release spaces "),
  );
  const readOnly: string[] = [];
  try {
    for (const platform of platforms) {
      const archive = join(
        outputDirectory,
        `${PRODUCT}-${platform}-plugin-${version}.zip`,
      );
      const files = pluginFiles(platform);
      inventory(run("unzip", ["-Z1", archive]), files);
      const rows = run("unzip", ["-Z", "-l", archive])
        .split("\n")
        .filter((line) => /^[bcdlps-][rwxstST-]{9} /u.test(line));
      assert.equal(
        rows.length,
        files.length,
        "ZIP entry metadata is incomplete",
      );
      for (const row of rows) {
        assert.equal(
          row.slice(0, 10),
          row.endsWith(`/${LAUNCHER}`) ? "-rwxr-xr-x" : "-rw-r--r--",
          "Unexpected ZIP entry type or permissions",
        );
        assert.ok(
          row.includes("00-Jan-01 00:00"),
          "ZIP timestamp differs from the release epoch",
        );
      }
      const extracted = join(temporary, platform);
      await mkdir(extracted);
      run("unzip", ["-q", archive, "-d", extracted]);
      const plugin = join(extracted, PRODUCT);
      await compareFiles(plugin, files);
      await makeReadOnly(plugin);
      readOnly.push(plugin);
      for (const runtime of runtimes) {
        await exercisePlugin(
          root,
          platform,
          runtime,
          join(temporary, `${platform}-${runtime}-source.db`),
          temporary,
          version,
        );
        await exercisePlugin(
          plugin,
          platform,
          runtime,
          join(temporary, `${platform}-${runtime}-archive.db`),
          temporary,
          version,
        );
      }
      if (native) {
        await verifyNativeInstall(
          root,
          platform,
          join(temporary, `${platform}-source-install`),
        );
        await verifyNativeInstall(
          plugin,
          platform,
          join(temporary, `${platform}-archive-install`),
        );
      }
    }
    const archive = join(
      outputDirectory,
      `${PRODUCT}-runtime-${version}.tar.gz`,
    );
    inventory(run("tar", ["-tzf", archive]), commonFiles);
    for (const row of run("tar", ["-tvzf", archive]).trim().split("\n"))
      assert.match(
        row,
        /^[-d][rwx-]{9} /u,
        "Tar contains a link or special file",
      );
    const extracted = join(temporary, "standalone");
    await mkdir(extracted);
    run("tar", ["-xzf", archive, "-C", extracted]);
    const runtimeRoot = join(extracted, PRODUCT);
    await compareFiles(runtimeRoot, commonFiles);
    await makeReadOnly(runtimeRoot);
    readOnly.push(runtimeRoot);
    for (const runtime of runtimes)
      assert.equal(
        run(
          runtime,
          [join(runtimeRoot, BUNDLE), "--version"],
          temporary,
        ).trim(),
        `${PRODUCT} ${version}`,
      );
  } finally {
    for (const directory of readOnly) await makeWritable(directory);
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const arguments_ = process.argv.slice(2);
  assert.ok(
    arguments_.every((argument) => argument === "--native"),
    "Usage: bun scripts/verify-release.ts [--native]",
  );
  await verifyRelease(undefined, arguments_.includes("--native"));
  process.stdout.write(
    "Verified release checksums, bundled bytes, hook files, and source and extracted plugin MCP lifecycles and hooks on Bun and Node.\n",
  );
}
