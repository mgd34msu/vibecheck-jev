# vibecheck-jev

vibecheck-jev is a work ledger for Claude Code and Codex agents whose reports are checked. Agents record the plan, their claims, progress, blockers and handoffs through nine MCP tools, as in any shared ledger. A Jev-compatible judgment model then reads what they report against what was asked: a "done" report against the task's goal and acceptance criteria, a blocker against the reasons the project accepts, a plan change against the work it replaces. Project status shows every task as reported and as verified, and leads with what needs attention.

The plugin also installs hooks that check the agent's own turns: briefs it sends to subagents, shell deletes it runs, and the reply it stops on.

It builds on the [vibecheck](https://github.com/mgd34msu/vibecheck) ledger and opens an existing vibecheck database unchanged.

## Contents

- [Install](#install)
- [Choose a judgment source](#choose-a-judgment-source)
- [Use an open Jev model](#use-an-open-jev-model)
- [The config file](#the-config-file)
- [What each check does](#what-each-check-does)
- [Record the standard the checks read](#record-the-standard-the-checks-read)
- [Read verified status](#read-verified-status)
- [Calibrate](#calibrate)
- [Commands](#commands)
- [Data and the database](#data-and-the-database)
- [Share a ledger over HTTP](#share-a-ledger-over-http)
- [Tools](#tools)
- [Build from source](#build-from-source)

## Install

You need Bash and either Bun 1.3.14 or later or Node.js 24 or later. The launcher picks Bun when it is installed, then Node.js. Linux and macOS work directly; on Windows, use WSL.

For Claude Code:

```bash
claude plugin marketplace add mgd34msu/vibecheck-jev@v1.0.0
claude plugin install vibecheck-jev@vibecheck-jev
```

For Codex:

```bash
codex plugin marketplace add mgd34msu/vibecheck-jev --ref v1.0.0
codex plugin add vibecheck-jev@vibecheck-jev
```

Reload the session after installing. The plugin registers the `vibecheck-jev` MCP server, a skill that teaches agents to use the ledger and read verification, and three hooks. Codex asks you to review and trust plugin hooks before they run. Plugin startup installs nothing and writes nothing inside the plugin folder.

Both clients use the same config file and the same ledger database, so an agent in Claude Code and an agent in Codex on the same machine share one ledger.

To tell your agents how to use the ledger in a project, add the block in [docs/agent-usage.md](docs/agent-usage.md) to the instructions file they read (for example `AGENTS.md` or `CLAUDE.md`).

## Choose a judgment source

Every check needs a judgment source: a model that answers the System One wire API (`POST /v1/systemone`) that TypeSafe's Jev defined. vibecheck-jev works with four kinds:

- **An open Jev-compatible server** you run yourself, such as OpenJev or openjev.
- **Laya**, an open-source Jev-compatible model, served locally by `vibecheck-jev laya serve`.
- **Jev-Style**, an open decision model, served by the optional adapter in `adapters/jev-style`.
- **Hosted Jev** from TypeSafe, which needs an API key.

The three open kinds run on your own machine, cost nothing per reading and keep your transcripts local. [Use an open Jev model](#use-an-open-jev-model) summarizes them, and [docs/open-models.md](docs/open-models.md) walks through getting, running and connecting each one.

With no configuration, vibecheck-jev uses hosted Jev with the key in `TYPESAFE_API_KEY`. Without any usable source, nothing breaks: the ledger records work as reported, like a plain ledger, and the hooks let work go ahead and print why on stderr.

### Hosted Jev

Jev is TypeSafe's hosted model and the one the built-in thresholds were set on. TypeSafe runs it in early access and lists its price as $42 per billion input tokens at the time of writing. Sign in at [console.typesafe.ai](https://console.typesafe.ai/) and follow [docs.typesafe.ai](https://docs.typesafe.ai/) to get an API key, then set it in the environment the client starts from:

```bash
export TYPESAFE_API_KEY="your key"
```

or name another variable in the config with `"auth": { "apiKeyEnv": "MY_KEY_VARIABLE" }`. Check it with `vibecheck-jev sources --source typesafe`.

### Several sources

List sources in the order they should be tried. When a source is unreachable, rate limited or times out, the next one answers the same reading, and the verdict records which source answered and which were skipped. An authentication failure or a rejected request stops there instead of moving on, since the next source would hide a misconfiguration. A reading larger than a source's input limits skips that source, and the skip is recorded.

## Use an open Jev model

An open Jev model runs on your own machine instead of TypeSafe's hosted service. It costs nothing per reading and keeps your transcripts local. Each one answers the same questions as hosted Jev, so vibecheck-jev treats them all the same way once they are running.

| Model                                              | Runs on                                                                  | Reads at most        | Best for                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------ |
| [Laya](docs/open-models.md#laya)                   | CPU, about 2 GB of RAM                                                   | 512 tokens of state  | The short checks; vibecheck-jev installs and serves it with two commands |
| [Jev-Style](docs/open-models.md#jev-style)         | CPU or GPU, through Python (torch) or llama.cpp                          | 25,600 tokens        | The checks that read long evidence, on a modest machine                  |
| [OpenJev](docs/open-models.md#openjev-github30)    | A GPU running an instruct model you choose                               | Depends on the model | Using a model you already have                                           |
| [openjev](docs/open-models.md#openjev-razorback16) | An NVIDIA GPU with 24 GB of VRAM, or Apple silicon with about 16 GB free | Depends on the model | The fastest readings, when you have the hardware                         |

### Where to get the models

These are the models vibecheck-jev was built and tested with. [docs/open-models.md](docs/open-models.md) covers setting up these and other Jev-compatible models:

| Model                    | Where to get it                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jev (hosted by TypeSafe) | Sign in at [console.typesafe.ai](https://console.typesafe.ai/) and follow [docs.typesafe.ai](https://docs.typesafe.ai/) to create an API key. Nothing to download                                                         |
| Laya                     | [huggingface.co/receptron/laya-onnx](https://huggingface.co/receptron/laya-onnx). `vibecheck-jev laya install` installs its runtime, and `vibecheck-jev laya serve` downloads these weights (about 1.7 GB) on first start |

The checks' thresholds were set on hosted Jev, and open models often read the same examples a little higher or lower. So after starting one, add it to `sources`, confirm it answers with `vibecheck-jev sources --source <id>`, and run `vibecheck-jev measure fixtures --source <id>` to see which checks need their own threshold for it or should go to another source.

[docs/open-models.md](docs/open-models.md) covers every step for each model: what it needs, how to download, install and start it, the exact config entry, server keys, what to expect from it, and a config that combines several models with hosted Jev as the fallback.

## The config file

The config file is `$XDG_CONFIG_HOME/vibecheck-jev/config.jsonc`, or `~/.config/vibecheck-jev/config.jsonc` when `XDG_CONFIG_HOME` is unset. Set `VIBECHECK_JEV_CONFIG` to use another path. `vibecheck-jev config path` prints the path in use.

The file is created on the first run of the MCP server, a hook or any command, with every option present at its default and a comment above each one. It is never overwritten. `vibecheck-jev config init --force` rewrites it from the template after saving the old file next to it with a `.bak` suffix, and `vibecheck-jev config check` validates it. The format is JSON with `//` and `/* */` comments and trailing commas allowed.

If the file has an error, the message names the file, the key and what was expected, for example:

```
/home/you/.config/vibecheck-jev/config.jsonc: checks.vibecheck.deferral.thresholds.blockAt: expected a probability from 0 to 1
```

With a broken config, the hooks let work go ahead and print that message, and the MCP server runs with ledger checks off until it is fixed.

The file has five top-level keys.

| Key       | Type                         | Default                                   | What it controls                                 |
| --------- | ---------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `sources` | array of sources             | hosted Jev only                           | Judgment sources, tried in order                 |
| `checks`  | object, check id to settings | every check on at its built-in thresholds | Each check's switch, thresholds and routing      |
| `ledger`  | object                       | `{ "verify": true }`                      | Whether the ledger checks what is reported to it |
| `hooks`   | object                       | every hook on, 40-second deadlines        | The three hooks                                  |
| `data`    | object                       | `null` folder and database                | Where the ledger lives                           |

### sources

Each source has a `kind`, an `id` you choose (used in routing and per-source thresholds), and the fields for its kind.

| Field                    | Kinds             | Type                                  | Default                                                      | Meaning                                                                                                                        |
| ------------------------ | ----------------- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                   | all               | `"typesafe"`, `"openjev"` or `"laya"` | required                                                     | Which kind of source                                                                                                           |
| `id`                     | all               | letters, digits, `.`, `_`, `-`        | required                                                     | Unique name for the source                                                                                                     |
| `baseURL`                | typesafe, openjev | URL                                   | `https://api.typesafe.ai` for typesafe; required for openjev | Server root; the client posts to `/v1/systemone`                                                                               |
| `model`                  | all               | text                                  | `jev-latest` (typesafe), required (openjev), `laya` (laya)   | Model name sent with each reading                                                                                              |
| `auth.apiKey`            | typesafe, openjev | text                                  | none                                                         | Key sent as a bearer token. Prefer `apiKeyEnv` so keys stay out of the file                                                    |
| `auth.apiKeyEnv`         | typesafe, openjev | variable name                         | `TYPESAFE_API_KEY` for typesafe                              | Environment variable holding the key                                                                                           |
| `auth.headers`           | typesafe, openjev | object of text                        | none                                                         | Extra request headers, for servers that authenticate another way                                                               |
| `timeoutMs`              | all               | positive integer                      | 25000; 60000 for laya                                        | How long one attempt may take before the next source is tried                                                                  |
| `limits.maxStateTokens`  | all               | positive integer                      | none; 512 for laya                                           | Readings with a larger state skip this source                                                                                  |
| `limits.maxOptionTokens` | all               | positive integer                      | none; 192 for laya                                           | Readings with a longer choice option skip this source                                                                          |
| `limits.maxOptions`      | all               | positive integer                      | none; 20 for laya                                            | Readings with more choice options skip this source                                                                             |
| `host`, `port`           | laya              | text, 1 to 65535                      | `127.0.0.1`, `8723`                                          | Where `laya serve` listens                                                                                                     |
| `autostart`              | laya              | boolean                               | `false`                                                      | Start `laya serve` in the background when a hook or the ledger finds it not running                                            |
| `load`                   | laya              | object                                | none                                                         | Laya load options: `modelDir`, `repo`, `subfolder`, `revision`, `cacheDir`, `token`, `executionProviders`, `intraOpNumThreads` |

Token counts for limits are estimated at three characters per token, which errs toward skipping.

Example with a local server first and hosted Jev as the fallback:

```jsonc
"sources": [
  { "kind": "openjev", "id": "local-jev", "baseURL": "http://127.0.0.1:8000", "model": "jev-latest" },
  { "kind": "typesafe", "id": "typesafe" }
]
```

### checks

`checks` maps a check id to its settings. Every check is listed in the generated file.

| Field              | Type                               | Default                     | Meaning                                                                                            |
| ------------------ | ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `enabled`          | boolean                            | `true`                      | `false` turns the check off everywhere: the ledger and the hooks skip it and record nothing for it |
| `thresholds`       | object, name to number from 0 to 1 | the check's built-in values | Replaces the named thresholds for every source                                                     |
| `sources`          | array of source ids, or `null`     | `null`                      | The sources that answer this check, in order. `null` means every source in the `sources` order     |
| `sourceThresholds` | object, source id to thresholds    | none                        | Threshold values that apply only when that source answers, over `thresholds`                       |

Example: send the short checks to Laya and the evidence-heavy ones to hosted Jev, turn off the stall check, and make claims-done stricter only on Laya:

```jsonc
"checks": {
  "vibecheck.question-answered": { "sources": ["laya", "typesafe"] },
  "vibecheck.claim-grounded": { "sources": ["typesafe"] },
  "vibecheck.stalled": { "enabled": false },
  "vibecheck.claims-done": { "sourceThresholds": { "laya": { "blockAt": 0.5 } } }
}
```

Every threshold is a probability between 0 and 1. Each check compares a model reading against its thresholds. For a threshold that a reading must reach to block or flag (most are named `blockAt` or `flagAt`), raising it makes the check stricter about when to act, so it blocks less; lowering it makes it act on weaker readings, so it blocks more. The table in [what each check does](#what-each-check-does) says which direction each threshold moves.

For example, `"vibecheck.deferral": { "thresholds": { "blockAt": 0.75 } }` stops the Stop hook from blocking replies that only lean toward putting work off; only replies the model reads as clearly deferring (0.75 or more) are sent back.

### ledger

| Field    | Type    | Default | Meaning                                                                                                    |
| -------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `verify` | boolean | `true`  | `false` makes the ledger record work as reported, with no readings and no verification fields in responses |

### hooks

| Field               | Type              | Default | Meaning                                                                               |
| ------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------- |
| `briefCheck`        | boolean           | `true`  | The brief check on subagent launches and messages                                     |
| `bashGuard`         | boolean           | `true`  | The delete guard on shell commands                                                    |
| `stop`              | boolean           | `true`  | The Stop checks on the agent's final reply                                            |
| `briefCheckSeconds` | number, up to 600 | `40`    | How long the brief check waits for its readings before letting the tool call go ahead |
| `stopSeconds`       | number, up to 600 | `40`    | How long the Stop checks wait before letting the turn end                             |

The clients stop a hook at 45 seconds (10 for the delete guard), so keep the deadlines below that.

### data

| Field      | Type           | Default                                                                   | Meaning                                              |
| ---------- | -------------- | ------------------------------------------------------------------------- | ---------------------------------------------------- |
| `folder`   | path or `null` | `null`: `$XDG_DATA_HOME/vibecheck-jev`, or `~/.local/share/vibecheck-jev` | Where the ledger and the Laya install live           |
| `database` | path or `null` | `null`: `ledger.sqlite3` in the data folder                               | The ledger database. `VIBECHECK_JEV_DB` overrides it |

## What each check does

Checks run in two places. The **ledger** reads what agents report through the tools. The **hooks** read the agent's own turns. When a reading cannot be taken because no source answers, the ledger applies the change as reported and records the reading as unavailable, and a hook lets the work go ahead with a message on stderr.

A check with a gate keeps a task open or blocks the agent. A flag is recorded and shown in status without stopping anything.

| Check                           | Reads                                                                                                                                        | Runs                                                                                      | Effect                                                                       | Thresholds and what raising them does                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vibecheck.claims-done`         | A done report against the task's goal, acceptance criteria, accepted exceptions and the code checks' results                                 | `work_update` to complete; the Stop hook when the session has open claims; `check report` | Gate: the task stays open with the reason                                    | `blockAt` 0.6: raise to hold fewer reports (only clear overclaims)                                                                                           |
| `vibecheck.brief-scope`         | A brief or plan change against the plan, the claimed task and its exceptions                                                                 | Brief hook; `plan_publish` and `plan_edit`; `check brief`                                 | Gate in the hook (the brief is refused); flag on plan changes                | `blockAt` 0.6: raise to refuse fewer briefs                                                                                                                  |
| `vibecheck.brief-carries-rules` | A new subagent's brief against the project's and task's rules                                                                                | Brief hook on launches                                                                    | Gate                                                                         | `governedAt` 0.55: raise to act only when a rule clearly governs the work. `carriesAt` 0.5: raise to demand the rules be stated more plainly (more refusals) |
| `vibecheck.deferral`            | A reply or report for work put off to later                                                                                                  | Stop hook; blocked and released updates; `check message`                                  | Gate in the hook; flag in the ledger                                         | `blockAt` 0.6: raise to block fewer replies                                                                                                                  |
| `vibecheck.question-answered`   | Whether the user asked a question and the reply answers it up front                                                                          | Stop hook                                                                                 | Gate                                                                         | `asksAt` 0.6: raise to count fewer messages as questions. `answeredAt` 0.5: raise to demand more direct answers (more blocks)                                |
| `vibecheck.asks-permission`     | A reply asking to approve something the recorded authorizations or the user's own request already allow                                      | Stop hook                                                                                 | Gate                                                                         | `blockAt` 0.6: raise to block fewer replies                                                                                                                  |
| `vibecheck.claim-grounded`      | Each sentence of a reply against the turn's tool output, claimed files first. Plans, proposals and "still running" statements are exempt     | Stop hook                                                                                 | Gate, naming the sentence                                                    | `blockAt` 0.6: raise to block fewer sentences. `planAt` 0.5: raise to exempt fewer sentences as plans or proposals (more blocks)                             |
| `vibecheck.user-pauses`         | Whether the user asked the agent to pause                                                                                                    | Stop hook, before the others                                                              | A pause skips the other Stop checks                                          | `pausingAt` 0.6: raise to recognize fewer pauses (more replies checked)                                                                                      |
| `vibecheck.stop-reason`         | A reason for leaving work: accepted by the project, an external block, or an excuse                                                          | Blocked and released updates; `check report`                                              | Flag; a confident excuse is flagged, a claimed rule or block asks for review | `leavesAt` 0.35: raise to treat fewer passages as leaving work. `confidenceAt` 0.4: raise to flag excuses only when the reading is surer                     |
| `vibecheck.gives-up`            | A message abandoning an item with work left                                                                                                  | Released updates with a report; `watch-agents`                                            | Flag                                                                         | `blockAt` 0.6: raise to flag fewer messages                                                                                                                  |
| `vibecheck.handoff-complete`    | A handoff note for open work, state, blockers and next step                                                                                  | `work_update` handoff                                                                     | Flag; a handoff with no note is always flagged                               | `presentAt` 0.5: raise to demand fuller notes (more flags)                                                                                                   |
| `vibecheck.stalled`             | A claim's recent reports for being stuck or abandoned                                                                                        | Progress reports after three earlier ones                                                 | Flag in status                                                               | `flagAt` 0.6: raise to flag fewer claims                                                                                                                     |
| `vibecheck.blocker-triage`      | Who a blocker needs (the user, an agent, or something external) and how urgent it is                                                         | Blocked updates                                                                           | Orders the attention list                                                    | none                                                                                                                                                         |
| `vibecheck.claim-overlap`       | Two open claims for the same or conflicting work, even on different files                                                                    | `work_claim`                                                                              | Flag in status                                                               | `flagAt` 0.6: raise to flag fewer pairs                                                                                                                      |
| `vibecheck.commit-honesty`      | A commit message against the task and the files it changed                                                                                   | Completion with a readable commit                                                         | Flag                                                                         | `matchAt` 0.4: raise to flag more mismatches. `overstatesAt` 0.6: raise to flag fewer overstatements                                                         |
| `vibecheck.task-duplicate`      | A new task against existing tasks                                                                                                            | `plan_publish`, `plan_edit`                                                               | Flag; a large overlap asks for review                                        | `duplicateAt` 0.6 and `overlapAt` 0.7: raise to flag fewer pairs                                                                                             |
| `vibecheck.plan-coverage`       | Whether the plan's tasks would achieve the recorded plan goal                                                                                | Plan changes when the policy has a goal                                                   | Flag                                                                         | `coversAt` 0.5: raise to flag more plans as incomplete                                                                                                       |
| `vibecheck.fallback-added`      | A diff for a change that silently weakens a requirement: a required dependency made optional, its failure swallowed, or a fallback hiding it | `check diff`                                                                              | Exit code 2                                                                  | `blockAt` 0.6: raise to flag fewer hunks                                                                                                                     |
| `vibecheck.commit-paths`        | Whether a recorded commit changed any claimed path (code, no reading)                                                                        | Completion with a commit and a readable checkout                                          | Gate                                                                         | none                                                                                                                                                         |
| `vibecheck.exception-check`     | Whether a file recorded as data-only holds control flow (code, no reading)                                                                   | Completion when the task has a data-only exception                                        | Gate                                                                         | none                                                                                                                                                         |
| `vibecheck.parent-rollup`       | Whether every child of a task verified (code, no reading)                                                                                    | Completion of a task with children                                                        | Gate, then claims-done reads the parent's own criteria                       | none                                                                                                                                                         |

The delete guard is not a model check: it refuses a shell `rm`, `rmdir`, `unlink` or `shred` through an unguarded `$VAR` or `${VAR}`, and asks the agent to use a literal path or `"${VAR:?}"`. Turn it off with `"hooks": { "bashGuard": false }`.

Turning a check off means it never reads and records nothing. A gate that is off lets the work through as reported; turning off `vibecheck.claims-done` makes every done report complete its task, marked unverified.

Codex seals the messages its agents send each other, so the brief check cannot read Codex subagent briefs. It says so on stderr and lets them through; the Stop checks and the delete guard work the same in both clients.

## Record the standard the checks read

The checks are only as specific as what the ledger records. When the coordinator publishes or edits the plan, each task can carry:

```json
{
  "id": "csv-export",
  "label": "CSV export for the reports page",
  "goal": "Users can download the report table as CSV",
  "criteria": [
    "every visible column is exported",
    "the file opens in a spreadsheet"
  ],
  "rules": ["keep the export under 2 seconds for 10,000 rows"],
  "exceptions": [
    {
      "description": "generated bindings need no tests",
      "paths": ["src/reports/generated.ts"],
      "data_only": true
    }
  ],
  "parent": "reports-page"
}
```

and the request can carry a project policy:

```json
"policy": {
  "goal": "Ship the reports page with CSV and PDF export",
  "rules": ["every schema change is a new migration in db/migrations/"],
  "authorizations": ["edit any file in the repository", "run the test suite and local migrations"],
  "stop_reasons": ["files under vendor/ are third-party and never edited"]
}
```

Agents report with a `report` on each update that completes, blocks, releases or hands off work. See [docs/protocol.md](docs/protocol.md) for every field.

## Read verified status

`project_status` begins with `attention` when anything needs it. It lists done reports held open, blockers that need the user or are urgent, stalled claims, overlapping claims, completed tasks that could not be verified, and other flags. Each item gives the check, the reason and the history entry. `verification` shows each task's latest done check as `verified`, `held` or `unverified` beside the status the agent reported.

A mutation's response carries `verification` items for the checks it ran, including `reported_status` and `applied_status` when a done report was held. `work_history` returns the `verifications` for the matched work: each verdict with its check, version, the source and model that answered, the readings, the decision and the reason, and every report the agents sent.

## Calibrate

Checks ship with thresholds tuned on hosted Jev. Another source may read the same fixtures a little higher or lower.

- `vibecheck-jev measure fixtures [--source ID] [--battery CHECK-ID] [--runs N]` repeats every fixture uncached and prints the worst margin to each fixture's bounds, marked FAIL (outside a bound) or THIN (within 0.10), then lists the fixtures that fail on that source.
- `vibecheck-jev fixtures [--source ID]` runs each fixture once and exits nonzero on any failure.
- `vibecheck-jev label list|mark|mark-where|mark-last` records whether live verdicts were right. Labels are history entries in the ledger.
- `vibecheck-jev measure live [--project ID]` shows, per check and source, how many readings flagged and how many labeled flags were right.
- `vibecheck-jev measure replay [CHECK-ID] [--source ID]` re-reads every labeled verdict with the current checks and thresholds and reports precision and recall.

When a check reads a fixture wrong on your source, change that check's threshold for that source under `checks.<id>.sourceThresholds.<source id>`, run the fixtures again, and confirm with replay once you have labels.

## Commands

The plugin's launcher, `scripts/vibecheck-jev.sh`, runs every command. From a source checkout, `bun src/cli.ts` does the same.

| Command                                                               | What it does                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (no command)                                                          | Runs the MCP server; see `--help` for its options                                                                                                                   |
| `hook pretool\|bash-guard\|stop --client claude\|codex`               | Runs a hook on the payload on stdin (the plugin's hook files call this)                                                                                             |
| `sources [--source ID]`                                               | Probes each configured source                                                                                                                                       |
| `measure fixtures\|live\|replay`                                      | Calibration, as above                                                                                                                                               |
| `fixtures [--source ID]`                                              | One pass of every fixture                                                                                                                                           |
| `label list\|mark\|mark-where\|mark-last`                             | Labels verdicts right or wrong                                                                                                                                      |
| `check brief\|message\|report\|diff FILES [--project ID --task TASK]` | Runs a check on files; with a project and task, the standard comes from the ledger. Exit 0 clean, 2 flagged, 1 unreadable                                           |
| `watch-agents --project ID [--session ID]`                            | Reads new messages from a session's descendant agents (found through the ledger's session ancestry) for items given up; `--transcript FILE` reads given transcripts |
| `exception-check FILE...`                                             | Whether files hold data only                                                                                                                                        |
| `report-of AGENT-OR-SESSION-ID [DIRECTORY]`                           | Prints an agent's final reply from its transcript                                                                                                                   |
| `laya install\|serve`                                                 | Installs and serves Laya                                                                                                                                            |
| `config path\|init [--force]\|check`                                  | Config file helpers                                                                                                                                                 |

## Data and the database

The ledger database defaults to `$XDG_DATA_HOME/vibecheck-jev/ledger.sqlite3`, or `~/.local/share/vibecheck-jev/ledger.sqlite3`. Set `data.database` in the config or `VIBECHECK_JEV_DB` in the environment to use another file; the environment variable wins. Keep the database on local disk, outside plugin caches; plugin upgrades and removal do not touch it. The ledger does not create backups.

To keep using a database created by vibecheck, point vibecheck-jev at it, for example `"data": { "database": "~/.local/share/project-board/board.sqlite3" }`. It opens unchanged: the schema version stays 1 and the new tables are added beside the old ones, so vibecheck can still open it too. History is immutable in the database itself: updates and deletes of history rows are refused. Idempotency receipts older than 30 days are pruned as the ledger writes.

## Share a ledger over HTTP

Run the server on the machine that holds the database:

```bash
read -rsp 'Ledger bearer token: ' VIBECHECK_JEV_TOKEN; printf '\n'
export VIBECHECK_JEV_TOKEN
export VIBECHECK_JEV_PROJECTS='my-project'
bash scripts/vibecheck-jev.sh --transport streamable-http --host 127.0.0.1 --port 8765
```

Clients connect to `http://127.0.0.1:8765/mcp` with `Authorization: Bearer <token>`. The token is required even on loopback. Put remote clients behind HTTPS and pass `--allowed-host` for the public host. `VIBECHECK_JEV_PROJECTS` limits both transports to the listed projects. For other local MCP clients, [examples/mcp.json](examples/mcp.json) shows a stdio entry.

## Tools

| Tool             | Purpose                                                                                |
| ---------------- | -------------------------------------------------------------------------------------- |
| `project_join`   | Register or rejoin a project session with real identity and ancestry                   |
| `plan_publish`   | Publish the complete task inventory with goals, criteria, rules, exceptions and policy |
| `plan_edit`      | Add or update tasks and their details atomically                                       |
| `plan_read`      | Read a plan revision, or compare two                                                   |
| `plan_ack`       | Record a session's review of a plan revision                                           |
| `work_claim`     | Claim a task or contribute under a parent's work                                       |
| `work_update`    | Report progress, blockers, completion, release or handoff, with a report               |
| `project_status` | Current state, led by what needs attention, with verified status                       |
| `work_history`   | Past work and its verification entries by task, session, path, branch or commit        |

The full request and response reference is [docs/protocol.md](docs/protocol.md).

## Build from source

```bash
git clone https://github.com/mgd34msu/vibecheck-jev.git
cd vibecheck-jev
bun install --frozen-lockfile
bun run build:release
bun run verify
```

`build:release` refreshes the bundled runtime `runtime/vibecheck-jev.mjs`, which includes the TypeSafe SDK, and writes the Claude and Codex plugin archives, the standalone runtime archive and `SHA256SUMS` to `artifacts/`. `verify` checks formatting, strict types, forbidden type escapes and bundle freshness, then runs the tests under Bun and as compiled JavaScript under Node.js 24 or later. The tests use a scripted judgment source and make no network calls. `bun run verify:release` checks the archives and runs their MCP servers and hooks on both runtimes.

Dependency licenses are in `runtime/THIRD-PARTY-NOTICES.txt`. vibecheck-jev is released under the MIT license.
