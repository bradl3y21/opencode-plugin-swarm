---
name: Quorum
description: Run several models on one task and merge their answers. Use when a question deserves more than one model's opinion — hard problems, design decisions, reviews, or when you want two or three independent attempts before committing.
---

# Quorum

A quorum sends one task to several models at once and merges what comes back. It
runs in this OpenCode instance, using the models the user already has, via the
`quorum` tool.

## When it is worth it

- A decision with consequences where you want genuinely independent takes
  (an architecture choice, a risky migration, a schema).
- A hard problem where one model may be confidently wrong.
- A second opinion on your own work — ask a different model to review it.
- Several independent attempts at one question, judged and merged
  (`vote`), when you want the answer to be reliable rather than merely plausible.

## When it is not

- Quick lookups, mechanical edits, or anything you can already answer.
- When the user asked for speed. A quorum costs one model call per member, plus
  one to merge — so four members is five calls.
- When the task needs tools and file access: prefer doing it yourself, or read the
  agent-mode note in `references/configuration.md` first, because agent workers
  edit the repository for real.

## Running one

Call the `quorum` tool with `action: "run"` (the default):

```
action: "run"
task:   "<the whole task, stated so it can stand alone>"
strategy: "vote" | "mixture" | "debate" | "divide" | "relay"
members: ["providerID/modelID", ...]     // omit to use the saved or automatic roster
copies: 1..8                             // >1 runs each member that many times
```

Write the `task` as a self-contained request — the members see only that text,
not this conversation. Then relay the merged answer, and say which models
produced it.

## Choosing a strategy

| Want | Use | Why |
| --- | --- | --- |
| The best single answer | `mixture` | Everyone answers in parallel, one merges. The safe default. |
| A decision you can defend | `vote` | Independent answers, a judge picks and explains. |
| A contested judgement tested | `debate` | Models critique each other over rounds, then merge. |
| A big task split up | `divide` | A planner decomposes it, workers solve parts, results merge. |
| A draft made better | `relay` | Each model refines the previous one. |

Use `action: "models"` to see exact model references; guessing one wastes a run.

## A quorum of one model

`copies: 4` with `members` naming a single model runs four independent attempts
and is the self-consistency pattern — use it with `vote`. Each copy is given a
different framing on purpose, because a transient generation has no temperature
control; identical prompts to one model would come back nearly identical.

## Setting defaults up for the user

If the user wants a quorum *configured* rather than just run once, use
`action: "configure"`. It validates and saves, and tells you what it rejected:

```
action: "configure"
strategy: "vote"
members: ["opencode-go/gpt-6-luna"]
copies: 4
aggregator: "auto"      // or a model reference
```

Settings persist in `.opencode/quorum.json` and are used by every later run. The
full field list, and what each one costs, is in
`references/configuration.md`.

## Reading the result

`action: "status"` lists recent runs; `action: "cancel"` with a `runID` stops one.
A run's **warnings** are worth reading before you trust the answer: they name
models that failed, names that did not resolve, and whether the aggregator fell
back to a member's answer.
