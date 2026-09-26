import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { Board } from "../src/board.js";
import { Database } from "../src/db.js";
import { projectIdSchema } from "../src/schemas.js";
import { openSqlite } from "../src/sqlite.js";
import {
  createLedger,
  join as joinSession,
  PROJECT,
  publish,
  request,
} from "./helpers.js";

const configHome = mkdtempSync(join(tmpdir(), "vibecheck-jev-review-config-"));
process.on("exit", () => rmSync(configHome, { recursive: true, force: true }));
const cliPath = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "../src/cli.ts" : "../src/cli.js",
    import.meta.url,
  ),
);

test("a record written twice in one transaction keeps every revision in history", async (t) => {
  const { board } = await createLedger(t);
  const session = await joinSession(board);
  const published = await publish(board, session);
  await board.call("plan_ack", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    plan_revision: 1,
  });
  const delta = z
    .object({
      changes: z.array(
        z.object({
          records: z.array(
            z.object({
              kind: z.string(),
              id: z.string(),
              record: z.object({ revision: z.number() }),
            }),
          ),
        }),
      ),
    })
    .parse(
      await board.call("project_status", { project_id: PROJECT, since: 0 }),
    );
  const revisions = delta.changes.flatMap((change) =>
    change.records
      .filter((entry) => entry.kind === "session" && entry.id === session)
      .map((entry) => entry.record.revision),
  );
  const current = await board.database.read(
    projectIdSchema.parse(PROJECT),
    (tx) => tx.getSession(session).revision,
  );
  assert.ok(published.cursor > 0);
  assert.equal(revisions.at(-1), current);
  for (const [index, revision] of revisions.entries())
    if (index > 0)
      assert.ok(
        revision - (revisions[index - 1] ?? 0) <= 1,
        `revisions ${revisions.join(",")} skip`,
      );
});

test("a failure outside the ledger's own errors reaches stderr and stays sanitized for the client", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-jev-hidden-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "future.sqlite3");
  const connection = await openSqlite(path);
  connection.exec("PRAGMA user_version = 2");
  connection.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--database", path],
    env: { XDG_CONFIG_HOME: configHome, PATH: process.env["PATH"] ?? "" },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "hidden-errors", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({
    name: "project_status",
    arguments: { request: { project_id: "p" } },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: "internal", message: "Internal server error." },
  });
  await client.close();
  assert.match(
    stderr,
    /tool call failed: .*unsupported database schema version 2/u,
  );
});

test("commit SHAs match whatever case they were written in", async (t) => {
  const { board } = await createLedger(t);
  const session = await joinSession(board);
  await publish(board, session, [{ id: "a", label: "A" }]);
  const claim = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    task_id: "a",
    expected_revision: 1,
    location: { target_branch: "main" },
  });
  const upper = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  const updated = await board.call("work_update", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: claim.work.id,
        expected_revision: claim.work.revision,
        expected_task_revision: claim.task.revision,
        status: "awaiting_integration",
        commit: upper,
        integration_commit: upper,
      },
    ],
  });
  const work = updated.work[0];
  assert.ok(work !== undefined);
  assert.equal(work.commit, upper.toLowerCase());
  const found = await board.call("work_history", {
    project_id: PROJECT,
    commit: upper.toLowerCase(),
  });
  assert.equal(found.matched_work_count, 1);
  const restated = await board.call("work_update", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: work.id,
        expected_revision: work.revision,
        commit: upper.toLowerCase(),
      },
    ],
  });
  assert.equal(
    restated.work.length,
    0,
    "restating the same commit keeps the integration proof",
  );
});

test("a failed rollback does not mask the error that caused it", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vibecheck-jev-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new Database(join(directory, "ledger.sqlite3"));
  const project = projectIdSchema.parse("p");
  await database.read(project, (tx) => tx.cursor());
  await assert.rejects(
    database.write(project, (tx) => {
      tx.execute("COMMIT", []);
      throw new Error("original failure");
    }),
    /original failure/u,
  );
});

test("history cannot be rewritten or deleted", async (t) => {
  const { board, path } = await createLedger(t);
  await joinSession(board);
  const connection = await openSqlite(path);
  try {
    assert.throws(
      () => connection.exec("UPDATE changes SET actor_id = 'x'"),
      /history is immutable/u,
    );
    assert.throws(
      () => connection.exec("DELETE FROM changes"),
      /history is immutable/u,
    );
  } finally {
    connection.close();
  }
});

test("idempotency receipts older than the retention window are pruned on write", async (t) => {
  const { path } = await createLedger(t);
  const board = new Board(path, { requestRetentionMs: 60_000 });
  const session = await joinSession(board);
  const connection = await openSqlite(path);
  try {
    connection.exec(
      "INSERT INTO requests(project_id, actor_id, request_id, digest, response, created_at) VALUES('test', 'old', 'r-old', 'd', '{}', '2000-01-01T00:00:00.000000+00:00')",
    );
  } finally {
    connection.close();
  }
  await board.call("plan_ack", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    plan_revision: 0,
  });
  const after = await openSqlite(path);
  try {
    assert.deepEqual(
      after.all("SELECT request_id FROM requests WHERE actor_id = 'old'", []),
      [],
    );
    assert.ok(after.all("SELECT request_id FROM requests", []).length >= 2);
  } finally {
    after.close();
  }
});
