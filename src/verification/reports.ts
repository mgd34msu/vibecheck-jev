// Report text sent with work updates, kept as history so later checks (a
// stalled claim, a contradiction, a receipt) can read what each agent said.

import type { Transaction } from "../db.js";
import type { WorkUpdate } from "../schemas.js";
import { appendEntry } from "./store.js";

export function recordReports(tx: Transaction, request: WorkUpdate): void {
  for (const change of request.updates ?? []) {
    const report = change.report;
    if (report === undefined) continue;
    const work = tx.findWork(change.work_id);
    if (work === undefined) continue;
    appendEntry(
      tx,
      {
        projectId: tx.projectId,
        taskId: work.task_id,
        workId: work.id,
        sessionId: request.session_id,
      },
      {
        kind: "report",
        body: {
          action: change.action ?? "progress",
          status: work.status,
          report,
          ...(work.blocker === null ? {} : { blocker: work.blocker }),
        },
      },
    );
  }
}
