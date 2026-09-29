import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LAUNCHER, packageVersion } from "../scripts/build-release.js";

const checkout = resolve(process.cwd());

function hasTimeout(): boolean {
  const probe = spawnSync("timeout", ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return probe.status === 0;
}

test(
  "launcher finishes when the interactive shell hangs",
  { timeout: 90_000 },
  async () => {
    // The bound needs GNU timeout; without it the launcher keeps its
    // previous unbounded read and this test cannot run.
    if (!hasTimeout()) return;
    const home = await mkdtemp(join(tmpdir(), "vibecheck-jev-hanging-home-"));
    try {
      await writeFile(join(home, ".bashrc"), "sleep 60\n");
      const start = Date.now();
      const launched = spawnSync(
        "bash",
        [join(checkout, LAUNCHER), "--version"],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: home, TYPESAFE_API_KEY: "" },
          timeout: 50_000,
        },
      );
      const elapsed = Date.now() - start;
      assert.equal(launched.status, 0, launched.stderr);
      assert.equal(
        launched.stdout,
        `vibecheck-jev ${await packageVersion(checkout)}\n`,
      );
      assert.match(launched.stderr, /continuing without it/u);
      assert.ok(elapsed < 30_000, `launcher waited ${elapsed}ms on the shell`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
