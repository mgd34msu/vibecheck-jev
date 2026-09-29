---
name: vibecheck-jev
description: Use the vibecheck-jev ledger to plan and record coding work with acceptance criteria, report progress and completion, and read which reports were verified by the judgment checks. Applies when the user asks for vibecheck-jev, shared work tracking, or verified status; it does not inspect repository contents or schedule agents.
---

# vibecheck-jev

vibecheck-jev is a work ledger whose reports are checked. You record the plan and your work through nine MCP tools. A Jev-compatible judgment model reads what you report against what was asked: a done report against the task's goal and acceptance criteria, a blocker against the reasons the project accepts, a plan change against the work it replaces. Status shows each task as reported and as verified, and leads with what needs attention.

All tools take a nested `request` object. Store metadata, reports and references, not code, credentials, transcripts or large logs.

## Establish the session

Use the project ID and repository identity supplied for the task. On the first turn, call `project_join` with the actual vendor, runtime, external session ID, model and effort. Never invent a session ID; if the runtime does not expose it, say so. The hooks find your ledger project by this external session ID, so use the client's own session ID when you have it. Preserve ancestry with the immediate parent's board `session_id`, and keep your returned `session_id` and the `snapshot.task_map`.

Only the coordinator publishes or edits the plan. Workers use existing task IDs and report missing scope to the coordinator.

## Record the standard

The checks judge against what the ledger records, so record it precisely. When the coordinator publishes or edits the plan, each task can carry:

- `goal`: what finishing the task achieves;
- `criteria`: acceptance criteria a reader can check, one per entry;
- `rules`: rules that govern work on this task;
- `exceptions`: accepted exceptions, each with a `description`, optional `paths` and `data_only: true` when a file must hold data or text only;
- `parent`: the task this one rolls up into. A parent verifies only after every child verifies.

The plan can carry a `policy` with the project `goal`, standing `rules` every brief must pass on, `authorizations` for actions agents may take without asking, and `stop_reasons` the project accepts for leaving work undone.

## Record work

Claim a task before working on it, with the checkout, branch and paths you will touch. Use `parent_work_id` for a contribution to your parent's task. Update at scope changes, blockers, handoffs, completion and integration, using the returned task and work revisions.

Send a `report` with every update that ends or pauses work:

- marking `complete`: say what was done against each criterion. The report is read against the task's goal, criteria and accepted exceptions. Recorded commits are checked against the claimed paths. A report that claims done while showing work left keeps the task open; the response's `verification` entry and status give the reason.
- marking `blocked`: give a concrete `blocker`. It is read for whether the reason is accepted, an external block or an excuse, and triaged for who it needs and how urgent it is.
- `release` or `handoff`: say what is open, where the work stands, what blocks it and the next step. A handoff with no note is flagged.

A done update without a report completes as reported but stays unverified.

## Read verified status

Start with one `project_status` call. When anything needs attention, the response begins with `attention`: done reports held open, blockers that need the user or are urgent, stalled claims, overlapping claims, and other flags, each with the check, the reason and the history entry. `verification` shows each task's latest done check as `verified`, `held` or `unverified` beside its reported status.

`work_history` returns the `verifications` entries for the matched work: each verdict with its check, version, source, model, readings and reason, and the reports you sent. Treat a held task as open: fix what the reason names and report again.

Use `full:true` for complete current state, `include_map:true` for the task map with goals and criteria, and `plan_read` for a past revision. Call `plan_ack` only after reviewing the complete map.

## What the hooks check

When the plugin's hooks are on, they also check your own turns: a brief to a subagent is read against the plan and your claimed task and for the project's rules; a shell delete through an unguarded variable is refused; and a stopping reply is read for deferred work, an unanswered question, asking permission for something already authorized, claiming done while your claims show work left, and facts the turn's tool output does not show. When a hook blocks, do what its reason says. When no judgment source answers, the hooks let the work go ahead and say so.
