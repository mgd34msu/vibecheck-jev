# Agent instructions

The block below tells agents how to use vibecheck-jev in a project. Add it to the instructions file your agents read for that project (for example `AGENTS.md` for Codex and Muse, or `CLAUDE.md` for Claude Code). Install the plugin first, then give the agents the shared project ID and repository identity in the task context.

```markdown
## Shared work ledger (vibecheck-jev)

Use vibecheck-jev for work metadata. Keep code, credentials, transcripts and
large logs out of the ledger. Reports you send are read by a judgment model
against what the plan records, so write them to be checked.

- On your first turn, call project_join with the shared project ID, repository,
  actual vendor/runtime session ID, model and effort. Use the client's own
  session ID; the hooks find the ledger project by it. Never invent one. If the
  runtime does not expose it, report that limitation. Preserve ancestry with
  the parent's board session_id.
- Retain your board session_id and the complete task_map from join,
  plan_publish, plan_edit or plan_read. Plan revision, task revision and work
  revision are different values; use the revision each mutation asks for.
- The coordinator owns the plan. When publishing or editing it, give each task
  a goal, acceptance criteria a reader can check, any rules for the task,
  accepted exceptions (with paths and data_only for files that must hold data
  only) and a parent when the task rolls up into another. Give the plan a
  policy: the goal, the rules every brief must pass on, the actions agents may
  take without asking, and the reasons the project accepts for leaving work.
- Workers use existing task IDs and do not publish child plans. Report missing
  scope to the coordinator.
- Claim a task before working on it, with the checkout, branch and paths you
  will touch. For work on the parent's task, use parent_work_id.
- Send a report with every update that completes, blocks, releases or hands
  off work. A completion report says what was done against each acceptance
  criterion; it is checked, and a report that claims done while showing work
  left keeps the task open with the reason. A blocker names the concrete cause.
  A handoff note says what is open, where the work stands, what blocks it and
  the next step.
- Read project_status at natural boundaries with known_plan_revision. When the
  response starts with attention, deal with it first: held done reports,
  blockers that need the user, stalled or overlapping claims, and flags. The
  verification field shows each task as verified, held or unverified.
- Use work_history to recover prior work and read its verifications: each
  verdict's check, version, source, model, readings and reason.
- Call plan_ack only after reviewing the complete map for that revision.
- Reuse request_id only to retry an identical mutation. Retain returned IDs and
  revisions. After a conflict, read current state and reassess.
- Treat the ledger as the latest report plus the checks' readings. Verify
  outcomes in the repository; claims do not lock files or branches.
```
