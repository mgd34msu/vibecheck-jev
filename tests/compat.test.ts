import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { z } from "zod";
import { Board } from "../src/board.js";
import { openSqlite } from "../src/sqlite.js";

const userVersion = (rows: unknown[]) =>
  z.array(z.object({ user_version: z.number() })).parse(rows)[0]?.user_version;

const ROOT = "s_a673fcd0fc514f8c931c7b577c708b35";
const CART_WORK = "w_0b96ea0df7a44f58bfc05fa73b57bed4";
const CHECKOUT_WORK = "w_5e4318a253dc488ea26d0198f5d80f77";

async function legacyLedger(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "vibecheck-jev-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite3");
  const connection = await openSqlite(path);
  try {
    connection.exec(
      await readFile(
        join(process.cwd(), "tests", "fixtures", "vibecheck-1.0.2.sql"),
        "utf8",
      ),
    );
  } finally {
    connection.close();
  }
  return { board: new Board(path), path };
}

const statusSchema = z.object({
  plan_revision: z.number(),
  tasks: z.record(
    z.string(),
    z.object({ status: z.string(), revision: z.number() }),
  ),
  work: z.record(
    z.string(),
    z.object({ status: z.string(), revision: z.number() }),
  ),
  task_map: z.record(z.string(), z.object({ label: z.string() })),
});

test("a database created by vibecheck 1.0.2 opens and reads unchanged", async (t) => {
  const { board, path } = await legacyLedger(t);
  const status = statusSchema.parse(
    await board.call("project_status", { project_id: "shop", full: true }),
  );
  assert.equal(status.plan_revision, 2);
  assert.equal(status.tasks["cart"]?.status, "complete");
  assert.equal(status.tasks["checkout"]?.status, "in_progress");
  assert.equal(status.task_map["receipts"]?.label, "Email and PDF receipts");
  assert.equal(status.work[CART_WORK]?.status, "complete");
  const history = z
    .object({
      changes: z.array(z.object({ seq: z.number() })),
      work: z.array(z.object({ id: z.string() })),
    })
    .parse(
      await board.call("work_history", { project_id: "shop", task_id: "cart" }),
    );
  assert.ok(history.work.some((work) => work.id === CART_WORK));
  assert.ok(history.changes.length >= 4);
  const first = z
    .object({ task_map: z.record(z.string(), z.object({ label: z.string() })) })
    .parse(await board.call("plan_read", { project_id: "shop", revision: 1 }));
  assert.equal(first.task_map["receipts"]?.label, "Email receipts");
  const connection = await openSqlite(path);
  try {
    assert.equal(userVersion(connection.all("PRAGMA user_version", [])), 1);
  } finally {
    connection.close();
  }
});

test("a vibecheck 1.0.2 database is extended with details, reports and immutable history", async (t) => {
  const { board, path } = await legacyLedger(t);
  const before = await (async () => {
    const connection = await openSqlite(path);
    try {
      return connection.all("SELECT seq, body FROM changes ORDER BY seq", []);
    } finally {
      connection.close();
    }
  })();
  const edited = z
    .object({
      plan_revision: z.number(),
      task_map: z.record(
        z.string(),
        z.object({ criteria: z.array(z.string()).optional() }),
      ),
    })
    .parse(
      await board.call("plan_edit", {
        project_id: "shop",
        request_id: "compat-edit",
        session_id: ROOT,
        expected_revision: 2,
        operations: [
          {
            op: "update",
            task_id: "checkout",
            criteria: ["a paid order shows a receipt"],
            goal: "Customers can pay for a cart",
          },
        ],
        policy: { rules: ["Every schema change is a migration"] },
      }),
    );
  assert.equal(edited.plan_revision, 3);
  assert.deepEqual(edited.task_map["checkout"]?.criteria, [
    "a paid order shows a receipt",
  ]);
  const status = statusSchema.parse(
    await board.call("project_status", { project_id: "shop", full: true }),
  );
  const work = status.work[CHECKOUT_WORK];
  const task = status.tasks["checkout"];
  assert.ok(work !== undefined && task !== undefined);
  await board.call("work_update", {
    project_id: "shop",
    request_id: "compat-done",
    session_id: ROOT,
    updates: [
      {
        work_id: CHECKOUT_WORK,
        expected_revision: work.revision,
        expected_task_revision: task.revision,
        status: "complete",
        report: "Checkout takes payment and shows a receipt.",
      },
    ],
  });
  const history = z
    .object({
      verifications: z.array(z.object({ kind: z.string() })).optional(),
    })
    .parse(
      await board.call("work_history", {
        project_id: "shop",
        task_id: "checkout",
      }),
    );
  assert.deepEqual(
    history.verifications?.map((entry) => entry.kind),
    ["report"],
  );
  const connection = await openSqlite(path);
  try {
    const after = connection.all(
      "SELECT seq, body FROM changes ORDER BY seq",
      [],
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(after.slice(0, before.length))),
      JSON.parse(JSON.stringify(before)),
    );
    assert.throws(
      () => connection.exec("UPDATE changes SET body = '[]'"),
      /history is immutable/u,
    );
    assert.throws(
      () => connection.exec("DELETE FROM changes"),
      /history is immutable/u,
    );
    assert.throws(
      () => connection.exec("DELETE FROM verifications"),
      /history is immutable/u,
    );
    assert.equal(userVersion(connection.all("PRAGMA user_version", [])), 1);
  } finally {
    connection.close();
  }
});
