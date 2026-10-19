import { Plugin } from "@opencode/plugin"
import { createConfigStore, redact, STRATEGIES, writeProjectConfig, type SwarmConfig } from "./config"
import { SwarmEngine, type SwarmRun } from "./engine"
import { createLogger, logFilePath, readLogTail } from "./log"
import { SwarmRpc } from "./rpc"
import { buildConfigPatch, describeConfig } from "./settings"

/**
 * The swarm server plugin.
 *
 * It owns the run state and exposes four front-ends over the same engine:
 *   - RPC, so the desktop dashboard and the terminal UI can drive it,
 *   - a `swarm` tool, so the agent can delegate to it,
 *   - a `/swarm` command, so you can start a run from any client,
 *   - synthetic messages, so a run is visible in the chat timeline.
 */

const VERSION = "1.0.0"
const NAMESPACE = "swarm"

type Unknown = Record<string, unknown>

interface ToolEditorLike {
  namespace(namespace: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Unknown
    execute: (input: unknown, context: ToolRunContext) => Promise<{ content: string }>
  }): void
}

interface ToolRunContext {
  signal?: AbortSignal
  progress?: (update: { status?: string }) => Promise<void>
}

interface RpcHandlers {
  state: (input: unknown) => Promise<{ json: string }>
  run: (input: unknown, context: { signal: AbortSignal }) => Promise<{ json: string }>
  cancel: (input: unknown) => Promise<{ json: string }>
  config: (input: unknown) => Promise<{ json: string }>
  log: (input: unknown) => Promise<{ json: string }>
}

interface RpcRegistrationLike {
  events: { emit(name: string, data: { json: string }): Promise<void> }
}

interface ContextLike {
  app?: { version?: string }
  location?: { directory?: string }
  options?: unknown
  model: { list(input?: unknown): Promise<unknown> }
  generate: { text(input: { prompt: string; model?: { providerID: string; id: string } }): Promise<unknown> }
  session: {
    create(input?: unknown): Promise<unknown>
    prompt(input: unknown): Promise<unknown>
    wait(input: unknown): Promise<unknown>
    context(input: unknown): Promise<unknown>
    synthetic(input: unknown): Promise<unknown>
  }
  tool: { transform(callback: (editor: ToolEditorLike) => void): Promise<unknown> }
  command: {
    transform(
      callback: (editor: {
        add(definition: {
          name: string
          description?: string
          execute(input: { sessionID: string; prompt: { text: string }; delivery: "steer" | "queue" }): Promise<void>
        }): void
      }) => void,
    ): Promise<unknown>
  }
  rpc: {
    register(definition: unknown, handlers: RpcHandlers): Promise<RpcRegistrationLike>
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by the tool and the command
// ---------------------------------------------------------------------------

function parseJson(value: unknown): Unknown {
  if (value === undefined || value === null) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" ? (parsed as Unknown) : {}
    } catch {
      return {}
    }
  }
  return typeof value === "object" ? (value as Unknown) : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function asList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean)
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return undefined
}

/** Compact one-line-per-step view of a run, used in tool output. */
function describeRun(run: SwarmRun): string {
  const done = run.steps.filter((step) => step.status === "done").length
  const lines = [
    `${run.id} · ${run.strategy} · ${run.status}${run.ms !== undefined ? ` · ${(run.ms / 1000).toFixed(1)}s` : ""}`,
    `steps ${done}/${run.steps.length} complete`,
  ]
  for (const step of run.steps) {
    const marker = step.status === "done" ? "✓" : step.status === "failed" ? "✗" : step.status === "running" ? "…" : "·"
    const when = step.ms !== undefined ? ` ${(step.ms / 1000).toFixed(1)}s` : ""
    lines.push(`${marker} ${step.kind} ${step.label}${when}${step.error ? ` — ${step.error}` : ""}`)
  }
  return lines.join("\n")
}

/** Renders the live step board shown on the tool card. */
function progressStatus(run: SwarmRun): string {
  const running = run.steps.find((step) => step.status === "running")
  const done = run.steps.filter((step) => step.status === "done").length
  if (run.status !== "running") return `${run.status} · ${done}/${run.steps.length} steps`
  return running
    ? `${done}/${run.steps.length} done · running ${running.label}`
    : `starting · ${run.steps.length} steps`
}

export default Plugin.define({
  id: "swarm",

  async setup(ctx) {
    const context = ctx as unknown as ContextLike
    const directory = context.location?.directory

    const store = createConfigStore(context, (next, from) => {
      log("config reloaded from:", from.join(", ") || "defaults", redact(next))
    })
    const log = createLogger(() => store.current().debugLog)

    const engine = new SwarmEngine({
      ctx: context,
      log,
      config: () => store.current(),
      sources: () => store.sources(),
      version: VERSION,
    })

    log(`loaded (opencode ${context.app?.version ?? "unknown"}), version ${VERSION}`)
    log("effective config:", redact(store.current()))

    // ---- RPC -------------------------------------------------------------
    let registration: RpcRegistrationLike | undefined
    try {
      registration = await context.rpc.register(SwarmRpc, {
        async state() {
          return { json: JSON.stringify(await engine.state()) }
        },
        async run(input) {
          const body = parseJson((input as Unknown)?.json)
          const task = asString(body.task)
          if (!task) return { json: JSON.stringify({ ok: false, error: "a task is required" }) }
          const run = await engine.start({
            task,
            strategy: asString(body.strategy),
            members: asList(body.members),
            copies: typeof body.copies === "number" ? body.copies : undefined,
            aggregator: asString(body.aggregator),
            workerMode: asString(body.workerMode),
            sessionID: asString(body.sessionID),
            source: "dashboard",
          })
          return { json: JSON.stringify({ ok: true, runID: run.id }) }
        },
        async cancel(input) {
          const body = parseJson((input as Unknown)?.json)
          const runID = asString(body.runID)
          const ok = runID ? engine.cancel(runID) : false
          return { json: JSON.stringify({ ok }) }
        },
        async config(input) {
          const body = parseJson((input as Unknown)?.json)
          const patch = body.patch && typeof body.patch === "object" ? (body.patch as Record<string, unknown>) : undefined
          if (patch) {
            const file = writeProjectConfig(directory, patch)
            log("config written to", file)
            store.reload()
          }
          return { json: JSON.stringify({ ok: true, config: store.current(), sources: store.sources() }) }
        },
        async log(input) {
          const body = parseJson((input as Unknown)?.json)
          const lines = typeof body.lines === "number" ? body.lines : 80
          return { json: JSON.stringify({ path: logFilePath(), text: readLogTail(lines) }) }
        },
      })
    } catch (error) {
      log("could not register the swarm RPC:", error instanceof Error ? error.message : error)
    }

    // Forward run changes to RPC subscribers so the dashboard is live.
    const unsubscribe = engine.onUpdate((run) => {
      if (!registration) return
      void registration.events.emit("updated", { json: JSON.stringify(run) }).catch((error) => {
        log("event emit failed:", error instanceof Error ? error.message : error)
      })
    })

    // ---- tool ------------------------------------------------------------
    const config = store.current()
    if (config.tool) {
      try {
        await context.tool.transform((editor) => {
          editor.namespace({
            name: NAMESPACE,
            description: "Run a swarm of OpenCode models on one task and collect their merged answer",
          })
          editor.add({
            name: "run",
            description:
              "Delegate a task to a swarm of OpenCode models working in parallel (or in debate/relay/vote/divide " +
              "order) and return their merged answer. Use this for hard questions, second opinions, reviews, or " +
              "work that benefits from several different models. It can also run agent workers that edit the repo. " +
              "Use `action: configure` to change the saved defaults (roster, strategy, copies) for future runs.",
            input: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["run", "status", "cancel", "models", "configure"],
                  description:
                    "What to do. `run` (default) sends a task to the swarm. `configure` saves defaults, and " +
                    "reports back which settings it accepted. `models` lists usable model references, `status` " +
                    "shows recent runs, `cancel` stops one.",
                },
                task: { type: "string", description: "The task or question for the swarm (required for `run`)." },
                strategy: {
                  type: "string",
                  enum: [...STRATEGIES],
                  description:
                    "mixture: everyone answers, one merges. debate: critique rounds. divide: split then merge. " +
                    "relay: each model refines the last. vote: a judge picks the best.",
                },
                members: {
                  type: "array",
                  items: { type: "string" },
                  description: 'Models as "providerID/modelID". Omit for the configured or automatic roster.',
                },
                copies: {
                  type: "integer",
                  minimum: 1,
                  maximum: 8,
                  description:
                    "Run each member this many times. Above 1 this is a swarm of the same model: several " +
                    "independent attempts, each given a different framing. Useful with the `vote` strategy.",
                },
                aggregator: {
                  type: "string",
                  description:
                    'Model that merges the members\' work, as "providerID/modelID". Use "auto" to restore the default.',
                },
                rounds: {
                  type: "integer",
                  minimum: 1,
                  maximum: 6,
                  description: "Debate rounds, for `action: configure`.",
                },
                concurrency: {
                  type: "integer",
                  minimum: 1,
                  maximum: 12,
                  description: "How many workers may run at once, for `action: configure`.",
                },
                timeoutMs: {
                  type: "integer",
                  minimum: 5000,
                  maximum: 900000,
                  description: "Per-worker timeout for text workers, in milliseconds, for `action: configure`.",
                },
                agentTimeoutMs: {
                  type: "integer",
                  minimum: 10000,
                  maximum: 3600000,
                  description:
                    "Per-worker timeout for agent workers, in milliseconds, for `action: configure`. Agent workers " +
                    "are full sessions and legitimately take minutes; do not set this to the text value.",
                },
                workerMode: {
                  type: "string",
                  enum: ["text", "agent"],
                  description: "`text` answers with no tools; `agent` gives each model a real session that can edit files.",
                },
                runID: { type: "string", description: "Run id, for `status` and `cancel`." },
              },
              additionalProperties: false,
            },
            execute: async (input, toolContext) => {
              const args = parseJson(input)
              const action = asString(args.action) ?? "run"

              if (action === "models") {
                const state = await engine.state()
                return { content: state.models.map((model) => model.key).join("\n") }
              }
              if (action === "status") {
                const runID = asString(args.runID)
                if (runID) {
                  const run = engine.run(runID)
                  return { content: run ? describeRun(run) : `no run ${runID}` }
                }
                const runs = engine.list(5)
                return {
                  content: runs.length ? runs.map(describeRun).join("\n\n") : "no swarm runs yet",
                }
              }
              if (action === "cancel") {
                const runID = asString(args.runID)
                const ok = runID ? engine.cancel(runID) : false
                return { content: ok ? `cancelled ${runID}` : `could not cancel ${runID ?? "(no run id)"}` }
              }

              if (action === "configure") {
                const { patch, rejected } = buildConfigPatch(args)
                const keys = Object.keys(patch)
                if (keys.length === 0 && rejected.length === 0) {
                  return {
                    content: [
                      "Nothing to configure. Pass any of: strategy, members, copies, aggregator, workerMode, rounds, concurrency.",
                      "",
                      "Current settings:",
                      describeConfig(store.current()),
                    ].join("\n"),
                  }
                }
                const written = writeProjectConfig(directory, patch)
                store.reload()
                log("config written to", written)
                return {
                  content: [
                    keys.length ? `Saved ${keys.join(", ")} to ${written}.` : "Nothing was saved.",
                    rejected.length ? `Ignored as invalid: ${rejected.join("; ")}.` : "",
                    "",
                    "Effective settings (used by the next run):",
                    describeConfig(store.current()),
                  ]
                    .filter(Boolean)
                    .join("\n"),
                }
              }

              const task = asString(args.task)
              if (!task) return { content: "The `task` field is required to run the swarm." }

              const run = await engine.start({
                task,
                strategy: asString(args.strategy),
                members: asList(args.members),
                copies: typeof args.copies === "number" ? args.copies : undefined,
                aggregator: asString(args.aggregator),
                workerMode: asString(args.workerMode),
                sessionID: undefined,
                source: "tool",
              })

              // Mirror the live board onto the tool card.
              const stopProgress = engine.onUpdate((update) => {
                if (update.id !== run.id || !toolContext.progress) return
                void toolContext.progress({ status: progressStatus(update) }).catch(() => {})
              })

              try {
                const finished = await waitForRun(engine, run.id, toolContext.signal)
                return {
                  content: finished.result
                    ? `${describeRun(finished)}\n\n=== SWARM RESULT ===\n${finished.result}`
                    : `${describeRun(finished)}\n\nThe swarm produced no merged answer.`,
                }
              } finally {
                stopProgress()
              }
            },
          })
        })
      } catch (error) {
        log("could not register the swarm tool:", error instanceof Error ? error.message : error)
      }
    }

    // ---- command ---------------------------------------------------------
    if (config.command) {
      try {
        await context.command.transform((editor) => {
          editor.add({
            name: "swarm",
            description: "Run a swarm of models on a task, or check on the swarm",
            execute: async ({ sessionID, prompt }) => {
              const text = (prompt.text ?? "").trim()
              const [head, ...rest] = text.split(/\s+/)
              const verb = (head ?? "").toLowerCase()

              // Results are posted as synthetic messages: they appear in the
              // timeline and stay in the session's context, but they do not
              // force a model turn (the agent can be asked to act on them).
              const post = (body: string) =>
                context.session.synthetic({
                  sessionID,
                  text: body,
                  description: "swarm",
                  metadata: { source: "swarm-command" },
                })

              if (!text || verb === "help") {
                await post(SWARM_HELP)
                return
              }

              if (verb === "status") {
                const runs = engine.list(5)
                await post(
                  runs.length
                    ? runs.map(describeRun).join("\n\n")
                    : "No swarm runs yet. Start one with `/swarm <task>`.",
                )
                return
              }

              // `/swarm debate <task>` and `/swarm strategy=debate <task>` both work.
              let strategy: string | undefined
              let task = rest.join(" ").trim()
              if ((STRATEGIES as readonly string[]).includes(verb)) {
                strategy = verb
              } else if (verb.startsWith("strategy=")) {
                strategy = verb.slice("strategy=".length)
                task = rest.join(" ").trim()
              } else {
                strategy = undefined
                task = text
              }
              if (!task) task = text

              if (!task) {
                await post(SWARM_HELP)
                return
              }

              const run = await engine.start({
                task,
                strategy,
                sessionID,
                source: "command",
              })

              const finished = await waitForRun(engine, run.id)
              await post(
                [
                  `The swarm (\`${finished.strategy}\`, ${finished.roster.length} models) finished ${finished.id}${
                    finished.ms ? ` in ${(finished.ms / 1000).toFixed(1)}s` : ""
                  }.`,
                  finished.warnings.length ? `Notes: ${finished.warnings.join("; ")}` : "",
                  "",
                  finished.result ?? finished.error ?? "(the swarm produced no answer)",
                ]
                  .filter(Boolean)
                  .join("\n"),
              )
            },
          })
        })
      } catch (error) {
        log("could not register the swarm command:", error instanceof Error ? error.message : error)
      }
    }

    return () => {
      unsubscribe()
      log("unloaded")
    }
  },
})

const SWARM_HELP = [
  "**swarm** runs several OpenCode models on one task and merges their answers.",
  "",
  "- `/swarm <task>` — run the configured strategy on a task",
  "- `/swarm debate <task>` — force a strategy (`mixture`, `debate`, `divide`, `relay`, `vote`)",
  "- `/swarm status` — show recent runs",
  "- `/swarm help` — this message",
  "",
  "Open the dashboard for a full view: it is the floating **Swarm** button in the OpenCode window. " +
    "Settings live in `.opencode/swarm.json`.",
].join("\n")

/**
 * Waits for a run to leave the running state, resolving early if the caller is
 * aborted (a cancelled tool call should not keep the run pinned forever).
 */
function waitForRun(
  engine: SwarmEngine,
  runID: string,
  signal?: AbortSignal,
): Promise<SwarmRun> {
  return new Promise<SwarmRun>((resolve) => {
    const current = engine.run(runID)
    if (current && current.status !== "running") {
      resolve(current)
      return
    }
    const stop = engine.onUpdate((run) => {
      if (run.id !== runID) return
      if (run.status !== "running") {
        stop()
        resolve(run)
      }
    })
    signal?.addEventListener("abort", () => {
      const run = engine.run(runID)
      if (run) {
        stop()
        resolve(run)
      }
    })
  })
}
