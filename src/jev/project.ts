// Finds the ledger project and session a hook runs in, the way the ledger
// identifies them: a session joined with the client's session id, or else a
// project whose repository identity matches the working directory, its git
// top level or its origin URL. Returns the standard the checks read.

import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { Database } from "../db.js";
import { planDetails, type PlanDetails } from "../details.js";
import {
  projectIdSchema,
  projectRecordSchema,
  sessionRecordSchema,
  type ProjectId,
  type ProjectRecord,
  type SessionRecord,
  type TaskRecord,
  type WorkRecord,
} from "../schemas.js";

export interface LedgerContext {
  readonly projectId: ProjectId;
  readonly project: ProjectRecord;
  readonly session: SessionRecord | undefined;
  readonly tasks: ReadonlyMap<string, TaskRecord>;
  readonly details: PlanDetails;
  /** This session's open claims. */
  readonly openWork: readonly WorkRecord[];
}

const OPEN = new Set([
  "pending",
  "in_progress",
  "blocked",
  "awaiting_integration",
]);

const projectRowSchema = z.object({ project_id: z.string(), body: z.string() });

function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 3_000,
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The identities a working directory may have been registered under. */
export function repositoryIdentities(cwd: string): string[] {
  const identities = new Set<string>([cwd]);
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top !== undefined) identities.add(top);
  const origin = git(cwd, ["config", "--get", "remote.origin.url"]);
  if (origin !== undefined) {
    identities.add(origin);
    identities.add(origin.replace(/\.git$/u, ""));
  }
  return [...identities];
}

export async function resolveContext(
  database: Database,
  hook: { readonly sessionId?: string; readonly cwd?: string },
): Promise<LedgerContext | undefined> {
  const candidate = await database.unscoped(false, (access) => {
    if (hook.sessionId !== undefined) {
      const rows = access.queryRows(
        projectRowSchema,
        `SELECT project_id, body FROM records WHERE kind = 'session'
         AND json_extract(body, '$.external_session_id') = ?
         ORDER BY json_extract(body, '$.last_seen_at') DESC LIMIT 1`,
        [hook.sessionId],
      );
      const row = rows[0];
      if (row !== undefined) return row.project_id;
    }
    if (hook.cwd === undefined) return undefined;
    const identities = repositoryIdentities(hook.cwd);
    const projects = access.queryRows(
      projectRowSchema,
      `SELECT project_id, body FROM records WHERE kind = 'project'
       AND json_extract(body, '$.repository') IN (SELECT value FROM json_each(?))
       ORDER BY json_extract(body, '$.updated_at') DESC LIMIT 1`,
      [JSON.stringify(identities)],
    );
    if (projects[0] !== undefined) return projects[0].project_id;
    const checkouts = access.queryRows(
      projectRowSchema,
      `SELECT project_id, body FROM records WHERE kind = 'work'
       AND json_extract(body, '$.location.checkout') IN (SELECT value FROM json_each(?))
       ORDER BY json_extract(body, '$.updated_at') DESC LIMIT 1`,
      [JSON.stringify(identities)],
    );
    return checkouts[0]?.project_id;
  });
  if (candidate === undefined) return undefined;
  const projectId = projectIdSchema.safeParse(candidate);
  if (!projectId.success) return undefined;
  return database.read(projectId.data, (tx) => {
    const project = tx.findProject(tx.projectId);
    if (project === undefined) return undefined;
    const session =
      hook.sessionId === undefined
        ? undefined
        : tx
            .allSessions()
            .filter((entry) => entry.external_session_id === hook.sessionId)
            .sort((left, right) =>
              left.last_seen_at < right.last_seen_at ? 1 : -1,
            )[0];
    const openWork =
      session === undefined
        ? []
        : tx
            .allWork()
            .filter(
              (work) => work.session_id === session.id && OPEN.has(work.status),
            );
    return {
      projectId: tx.projectId,
      project: projectRecordSchema.parse(project),
      session:
        session === undefined ? undefined : sessionRecordSchema.parse(session),
      tasks: new Map(tx.allTasks().map((task) => [task.id, task])),
      details: planDetails(tx),
      openWork,
    };
  });
}
