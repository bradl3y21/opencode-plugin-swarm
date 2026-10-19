# Swarm configuration

Settings live in `.opencode/swarm.json` (project) or `~/.config/opencode/swarm.json`
(global). The project file wins. The plugin re-reads it immediately, so a change
applies to the next run without restarting anything.

Prefer `action: "configure"` on the `swarm` tool: it validates values and tells
you what it rejected. Hand-editing this file works too, and `copies: …` is the
kind of setting a user may prefer to keep.

## What each setting costs

A `mixture` or `vote` run makes one model call per member, plus one to merge or
judge. `copies` multiplies the member count; `debate` multiplies it again by
`rounds`. So:

| Members | Copies | Rounds | Model calls (plus one) |
| --- | --- | --- | --- |
| 4 | 1 | — | 5 |
| 1 | 4 | — | 5 |
| 3 | 1 | 2 | 7 (debate) |

Turn `autoMembers` down, or pin cheaper `members`, when a run needs to be cheap.

## Fields

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `strategy` | `"mixture"` | `mixture`, `debate`, `divide`, `relay`, `vote`. |
| `members` | `[]` | Models as `"providerID/modelID"`. A bare `modelID` resolves too. Repeats are kept — naming one model four times runs it four times. Empty means automatic. |
| `copies` | `1` | Run each member this many times (1–8). Above 1, a swarm of the same model, each copy differently framed. |
| `aggregator` | first member | Model that merges the members' work. `auto` restores the default. |
| `planner` | first member | Model that splits the task, for `divide`. |
| `judge` | first member | Model that picks the winner, for `vote`. |
| `workerMode` | `"text"` | `text` or `agent`. See below. |
| `rounds` | `2` | Debate rounds, including the opening one. |
| `concurrency` | `4` | How many workers run at once. |
| `autoMembers` | `4` | How many models automatic selection picks. |
| `timeoutMs` | `180000` | Per-worker timeout for **text** workers. Text workers are single model calls, so two minutes is already generous. |
| `agentTimeoutMs` | `900000` | Per-worker timeout for **agent** workers. Agent workers are full sessions that read files, run commands and edit code, so they legitimately take many minutes — a shorter limit marks finished work as timed out. |
| `maxOutputChars` | `6000` | Truncate each answer before it reaches the aggregator — this is a real cost control, since every answer is pasted into the merge prompt. |
| `keepWorkerSessions` | `true` | Keep agent-mode worker sessions so they can be inspected. |
| `streamToSession` | `true` | Mirror progress into the session that started the run. |
| `tool` | `true` | Register the `swarm` tool. **Needs a reload.** |
| `command` | `true` | Register the `/swarm` command. **Needs a reload.** |
| `debugLog` | `true` | Append activity to `~/.local/share/opencode/log/swarm.log`. |

Environment variables mirror these: `OPENCODE_SWARM_STRATEGY`, `_MEMBERS`
(comma separated), `_COPIES`, `_AGGREGATOR`, `_WORKER_MODE`, `_ROUNDS`,
`_CONCURRENCY`, `_AUTO_MEMBERS`, `_TIMEOUT_MS`, `_AGENT_TIMEOUT_MS`,
`_MAX_OUTPUT_CHARS`, `_TOOL`, `_COMMAND`, `_DEBUG_LOG`.

## Worker modes

`text` (the default) is a plain model call: fast, cheap, no tools.

`agent` gives each model its own OpenCode session, so it can read files, run
commands and **edit the repository**. Before choosing it:

- every member works on the same checkout, so two models editing one file will
  conflict. For anything destructive, use a separate worktree or keep `text`.
- worker sessions are named `swarm · <role> · <model>` and nested under the
  session that started the run; `keepWorkerSessions: false` removes them once
  their answer is harvested.
- agent runs are far slower and more expensive than text runs.
- `agentTimeoutMs` (default 15 minutes) is separate from the text `timeoutMs`, and
  a timeout does not discard the work: whatever the session had produced is
  harvested and the step is kept, with a warning. Planning, judging and merging
  always run as text calls, in either mode — they never need tools.

## Choosing models

With `members` empty the swarm picks for you: it starts from the model the user is
already running, adds one model per provider, skips models that failed recently
(15 minutes) and favours models that answered recently (an hour). It deprioritises
giveaway tiers (`-free`, `-contributor`, `-preview`), which in practice are the
ones that refuse requests from a plugin.

That learning matters: model metadata cannot tell you whether a model will
actually answer. Ran against one workspace, an automatic roster went from two
usable members out of four on its first run to all members succeeding by the
third.
