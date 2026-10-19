import { type QuorumConfig, type Strategy, type WorkerMode } from "./config"
import { createHistory, type RunHistory } from "./history"
import { logFilePath } from "./log"
import {
  autoRoster,
  listModels,
  modelKey,
  resolveRole,
  resolveRoster,
  type ModelOption,
  type ModelRef,
} from "./models"
import {
  aggregatePrompt,
  critiquePrompt,
  extractJson,
  judgePrompt,
  mergePrompt,
  planPrompt,
  proposePrompt,
  refinePrompt,
  subtaskPrompt,
  trim,
} from "./prompts"

/**
 * The quorum engine.
 *
 * A "run" takes a task, sends it to several models at the same time (or in a
 * deliberate order, depending on the strategy), and merges what comes back into
 * one answer. The engine owns all run state and pushes a snapshot out whenever
 * anything changes, so every front-end is a dumb view over the same data.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type StepStatus = "pending" | "running" | "done" | "failed" | "cancelled"

export interface QuorumStep {
  id: string
  /** What this step is doing, e.g. "member" or "aggregator". */
  kind: "member" | "planner" | "aggregator" | "judge" | "relay" | "subtask"
  /** Human label: model name, or the subtask title. */
  label: string
  model: string
  round?: number
  status: StepStatus
  startedAt?: number
  finishedAt?: number
  ms?: number
  chars?: number
  output?: string
  error?: string
  /** Set in agent mode: the session the worker ran in. */
  sessionID?: string
}

export interface QuorumRun {
  id: string
  task: string
  strategy: Strategy
  workerMode: WorkerMode
  status: "running" | "done" | "failed" | "cancelled"
  startedAt: number
  finishedAt?: number
  ms?: number
  roster: string[]
  aggregator?: string
  steps: QuorumStep[]
  result?: string
  error?: string
  /** The session this run was started from, when there was one. */
  sessionID?: string
  source: "tool" | "command" | "rpc" | "dashboard"
  warnings: string[]
}

export interface QuorumState {
  version: string
  directory?: string
  config: QuorumConfig
  sources: string[]
  models: Array<{
    key: string
    id: string
    providerID: string
    label: string
    provider: string
    tools: boolean
  }>
  runs: QuorumRun[]
  logPath: string
  capabilities: {
    /** Agent mode creates real sessions that can edit files. */
    agentWorkers: boolean
    streaming: boolean
  }
}

export interface RunInput {
  task: string
  strategy?: string
  members?: string[]
  aggregator?: string
  workerMode?: string
  /** How many times to run each member; above 1, a quorum of the same model. */
  copies?: number
  sessionID?: string
  parentID?: string
  source?: QuorumRun["source"]
}

// ---------------------------------------------------------------------------
// The slice of the OpenCode plugin context the engine uses
// ---------------------------------------------------------------------------

export interface EngineContext {
  app?: { version?: string }
  location?: { directory?: string }
  model: {
    list(input?: unknown): Promise<unknown>
    default?(input?: unknown): Promise<unknown>
  }
  generate: {
    text(input: { prompt: string; model?: { providerID: string; id: string } }): Promise<unknown>
  }
  session: {
    create(input?: unknown): Promise<unknown>
    prompt(input: unknown): Promise<unknown>
    wait(input: unknown): Promise<unknown>
    context(input: unknown): Promise<unknown>
    synthetic(input: unknown): Promise<unknown>
    remove(input: unknown): Promise<unknown>
  }
}

export type Logger = (...args: unknown[]) => void

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Unknown = Record<string, unknown>

function isRecord(value: unknown): value is Unknown {
  return typeof value === "object" && value !== null
}

/** Client responses may be wrapped as `{ data, location }`. Accept both shapes. */
function unwrap<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined
  if (isRecord(value) && "data" in value) return value.data as T
  return value as T
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function shortID(): string {
  return Math.random().toString(36).slice(2, 8)
}

function shortModel(ref: { providerID: string; id: string }): string {
  return ref.id
}

/**
 * Pulls the assistant's text out of a session transcript.
 *
 * The message shape has changed across OpenCode versions, so this reads the
 * plausible locations instead of assuming one.
 */
export function extractAssistantText(messages: unknown): string {
  const list = unwrap<unknown[]>(messages)
  if (!Array.isArray(list)) return ""
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index]
    if (!isRecord(message)) continue
    // Transcripts use `type` ("user" | "assistant" | "idle"); older shapes used
    // `role`, so accept either.
    const kind =
      asString(message.type) ?? asString(message.role) ?? (isRecord(message.info) ? asString(message.info.role) : undefined)
    if (kind !== "assistant") continue

    const parts = Array.isArray(message.content)
      ? message.content
      : Array.isArray(message.parts)
        ? message.parts
        : []
    const text = parts
      .map((part) => {
        if (!isRecord(part)) return ""
        if (asString(part.type) === "text") return asString(part.text) ?? ""
        if (asString(part.type) === "reasoning") return ""
        return asString(part.text) ?? ""
      })
      .filter(Boolean)
      .join("\n")
      .trim()
    if (text) return text

    const direct = asString(message.text)
    if (direct) return direct
  }
  return ""
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  })
  await Promise.all(workers)
  return results
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Framings given to repeated copies of the same model.
 *
 * A transient generation takes only a prompt and a model — there is no
 * temperature or sampling control — so several copies of one prompt would come
 * back much the same. Giving each copy a different lens is what makes a
 * same-model quorum worth running: the copies then disagree in useful ways, and
 * the aggregator has something real to merge.
 */
const ANGLES = [
  "first principles — reason it out from basics",
  "risk-focused — hunt for what could go wrong",
  "simplest thing that works — prefer the smallest solution",
  "edge cases — enumerate the awkward inputs and boundaries",
  "the sceptic — argue against the obvious answer",
  "practical experience — what usually happens in practice",
  "alternatives — propose a different approach to the obvious one",
  "concrete detail — be unusually specific",
]

/** Repeats each member `copies` times, labelling each copy with its framing. */
function expandCopies(roster: ModelOption[], copies: number): ModelOption[] {
  if (copies <= 1) return roster
  const out: ModelOption[] = []
  for (let copy = 0; copy < copies; copy++) {
    for (const model of roster) {
      out.push({ ...model, label: `${model.label} · ${ANGLES[copy % ANGLES.length]}` })
    }
  }
  return out
}

export interface EngineOptions {
  ctx: EngineContext
  log: Logger
  /** Live config, re-read on every access so edits apply without a restart. */
  config: () => QuorumConfig
  sources: () => string[]
  /** Module-scope quorum version string, shown in the dashboard. */
  version: string
}

export class QuorumEngine {
  private readonly ctx: EngineContext
  private readonly log: Logger
  private readonly config: () => QuorumConfig
  private readonly sources: () => string[]
  private readonly version: string

  private readonly runs = new Map<string, QuorumRun>()
  private readonly history: RunHistory
  private readonly cancelled = new Set<string>()
  private readonly listeners = new Set<(run: QuorumRun) => void>()
  private modelsCache?: { at: number; models: ModelOption[] }
  private preferredCache?: { at: number; models: ModelRef[] }
  /** modelKey -> when it last failed, so the auto roster can steer around it. */
  private readonly failures = new Map<string, number>()
  /** modelKey -> when it last answered, so the auto roster can steer towards it. */
  private readonly successes = new Map<string, number>()
  private lastStreamedAt = new Map<string, number>()

  /** How long a model is skipped by the automatic roster after a failure. */
  private static readonly FAILURE_MEMORY_MS = 15 * 60_000
  /** How long a model that answered is favoured by the automatic roster. */
  private static readonly SUCCESS_MEMORY_MS = 60 * 60_000

  constructor(options: EngineOptions) {
    this.ctx = options.ctx
    this.log = options.log
    this.config = options.config
    this.sources = options.sources
    this.version = options.version
    this.history = createHistory(options.ctx.location?.directory, (message) => this.log(message))
    for (const run of this.history.load()) this.runs.set(run.id, run)
  }

  // ---- observation -------------------------------------------------------

  onUpdate(listener: (run: QuorumRun) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(run: QuorumRun): void {
    const snapshot = this.clone(run)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.log("listener failed:", error instanceof Error ? error.message : error)
      }
    }
    void this.streamToSession(snapshot)
  }

  private clone(run: QuorumRun): QuorumRun {
    return { ...run, steps: run.steps.map((step) => ({ ...step })), warnings: [...run.warnings] }
  }

  run(id: string): QuorumRun | undefined {
    const found = this.runs.get(id)
    return found ? this.clone(found) : undefined
  }

  list(limit = 25): QuorumRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((run) => this.clone(run))
  }

  async models(force = false): Promise<ModelOption[]> {
    const ttl = 30_000
    if (!force && this.modelsCache && Date.now() - this.modelsCache.at < ttl) return this.modelsCache.models
    try {
      const models = await listModels(this.ctx as never)
      this.modelsCache = { at: Date.now(), models }
      return models
    } catch (error) {
      this.log("could not list models:", error instanceof Error ? error.message : error)
      return this.modelsCache?.models ?? []
    }
  }

  /**
   * The model the user has actually selected for this location.
   *
   * Model metadata carries no reliable quality signal (in practice a $50/M
   * output model can be an idle experiment while a cheap one is the workhorse),
   * so the one trustworthy hint is what the user runs themselves. The automatic
   * roster is seeded with it before any heuristic pick.
   */
  private async preferredModels(): Promise<ModelRef[]> {
    if (this.preferredCache !== undefined && Date.now() - this.preferredCache.at < 60_000) {
      return this.preferredCache.models
    }
    let models: ModelRef[] = []
    try {
      const fn = this.ctx.model.default
      if (typeof fn === "function") {
        const raw = await fn.call(this.ctx.model)
        const info = unwrap<Unknown>(raw) ?? (isRecord(raw) ? raw : undefined)
        const providerID = info ? asString(info.providerID) : undefined
        const id = info ? (asString(info.id) ?? asString(info.modelID)) : undefined
        if (providerID && id) models = [{ providerID, id }]
      }
    } catch (error) {
      this.log("could not read the default model:", error instanceof Error ? error.message : error)
    }
    this.preferredCache = { at: Date.now(), models }
    return models
  }

  async state(): Promise<QuorumState> {
    const models = await this.models()
    return {
      version: this.version,
      directory: this.ctx.location?.directory,
      config: this.config(),
      sources: this.sources(),
      models: models.map((model) => ({
        key: modelKey(model),
        id: model.id,
        providerID: model.providerID,
        label: model.label,
        provider: model.provider,
        tools: model.tools,
      })),
      runs: this.list(),
      logPath: logFilePath(),
      capabilities: { agentWorkers: true, streaming: true },
    }
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id)
    if (!run || run.status !== "running") return false
    this.cancelled.add(id)
    run.warnings.push("cancelled by request")
    for (const step of run.steps) {
      if (step.status === "running" || step.status === "pending") {
        step.status = "cancelled"
        step.finishedAt = Date.now()
      }
    }
    this.finish(run, "cancelled", run.result)
    return true
  }

  /**
   * Models that failed recently, pruned as they age out. Their keys let the
   * automatic roster prefer a model that is at least answering.
   */
  private recentFailures(): Set<string> {
    const cutoff = Date.now() - QuorumEngine.FAILURE_MEMORY_MS
    const out = new Set<string>()
    for (const [key, at] of this.failures) {
      if (at >= cutoff) out.add(key)
      else this.failures.delete(key)
    }
    return out
  }

  /** And the mirror: models that have recently produced an answer. */
  private recentSuccesses(): Set<string> {
    const cutoff = Date.now() - QuorumEngine.SUCCESS_MEMORY_MS
    const out = new Set<string>()
    for (const [key, at] of this.successes) {
      if (at >= cutoff) out.add(key)
      else this.successes.delete(key)
    }
    return out
  }

  // ---- roster ------------------------------------------------------------

  private async resolveRoster(
    input: RunInput,
    strategy: Strategy,
  ): Promise<{
    roster: ModelOption[]
    aggregator?: ModelOption
    warnings: string[]
  }> {
    const config = this.config()
    const models = await this.models()
    const warnings: string[] = []

    const requested = input.members && input.members.length > 0 ? input.members : config.members
    let roster: ModelOption[]
    if (requested.length > 0) {
      const resolved = resolveRoster(models, requested)
      roster = resolved.roster
      if (resolved.substituted.length) {
        warnings.push(`resolved model names: ${resolved.substituted.join(", ")}`)
      }
      if (resolved.unknown.length) {
        warnings.push(`unknown models ignored: ${resolved.unknown.join(", ")}`)
      }
    } else {
      const avoid = this.recentFailures()
      const good = this.recentSuccesses()
      roster = autoRoster(models, config.autoMembers, {
        preferred: await this.preferredModels(),
        avoid,
        good,
      })
      if (roster.length === 0) warnings.push("no models were available to build a roster")
      else warnings.push(`auto roster: ${roster.map((model) => model.id).join(", ")}`)
      if (avoid.size > 0) warnings.push(`steered around ${avoid.size} model(s) that failed recently`)
      if (good.size > 0) warnings.push(`favouring ${good.size} model(s) that answered recently`)
    }

    // The aggregator defaults to the strongest member of the panel. It stays in
    // the roster as well, so a run always uses every member you asked for.
    const usesAggregator = strategy === "mixture" || strategy === "debate"
    const aggregator = resolveRole(models, input.aggregator ?? config.aggregator, roster[0])
    if (
      usesAggregator &&
      aggregator &&
      roster.length > 1 &&
      roster.some((model) => modelKey(model) === modelKey(aggregator))
    ) {
      warnings.push(`${aggregator.id} both answers and aggregates`)
    }

    return { roster, aggregator, warnings }
  }

  // ---- running -----------------------------------------------------------

  async start(input: RunInput): Promise<QuorumRun> {
    const config = this.config()
    const strategy = (input.strategy && this.validStrategy(input.strategy)) || config.strategy
    const workerMode = (input.workerMode && this.validMode(input.workerMode)) || config.workerMode

    const { roster, aggregator, warnings } = await this.resolveRoster(input, strategy)

    // Copies turn "one agent" into "a quorum of that agent": the same model run
    // several times over. With no sampling control available, identical prompts
    // would produce near-identical answers, so each copy is given a different
    // framing — that is what makes consensus or comparison meaningful.
    const copies = Math.min(8, Math.max(1, Math.round(input.copies ?? config.copies)))
    const workers = expandCopies(roster, copies)
    if (copies > 1) {
      warnings.push(`${copies} copies of ${roster.map((model) => model.id).join(", ")}`)
    }

    const run: QuorumRun = {
      id: `quorum_${shortID()}`,
      task: input.task,
      strategy,
      workerMode,
      status: "running",
      startedAt: Date.now(),
      roster: workers.map(modelKey),
      aggregator: aggregator ? modelKey(aggregator) : undefined,
      steps: [],
      sessionID: input.sessionID,
      source: input.source ?? "rpc",
      warnings,
    }
    this.runs.set(run.id, run)
    // Bound the history; the dashboard only ever shows recent runs.
    if (this.runs.size > 100) {
      const oldest = [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0]
      if (oldest) this.runs.delete(oldest.id)
    }
    this.emit(run)

    void this.execute(run, workers, aggregator).catch((error) => {
      run.error = error instanceof Error ? error.message : String(error)
      this.finish(run, "failed")
    })

    return this.clone(run)
  }

  private validStrategy(value: string): Strategy | undefined {
    const strategies: Strategy[] = ["mixture", "debate", "divide", "relay", "vote"]
    return (strategies as string[]).includes(value) ? (value as Strategy) : undefined
  }

  private validMode(value: string): WorkerMode | undefined {
    return value === "text" || value === "agent" ? value : undefined
  }

  /** Runs the configured strategy to completion. */
  private async execute(run: QuorumRun, roster: ModelOption[], aggregator?: ModelOption): Promise<void> {
    const config = this.config()
    if (roster.length === 0) {
      run.warnings.push("no members to run")
      this.finish(run, "failed", undefined)
      return
    }

    const isCancelled = (): boolean => this.cancelled.has(run.id)
    this.emit(run)

    switch (run.strategy) {
      case "debate":
        await this.runDebate(run, roster, aggregator, isCancelled)
        break
      case "divide":
        await this.runDivide(run, roster, aggregator, isCancelled)
        break
      case "relay":
        await this.runRelay(run, roster, isCancelled)
        break
      case "vote":
        await this.runVote(run, roster, aggregator, isCancelled)
        break
      case "mixture":
      default:
        await this.runMixture(run, roster, aggregator, isCancelled)
        break
    }

    if (isCancelled()) {
      if (run.status === "running") this.finish(run, "cancelled")
      return
    }
    // Never report success for a run that produced nothing: "done" with an empty
    // result is worse than an honest failure.
    if (!run.error && !run.result) {
      run.error = run.steps.find((step) => step.error)?.error ?? "the run finished without a result"
    }
    this.finish(run, run.error ? "failed" : "done")
  }

  // ---- strategy: mixture -------------------------------------------------

  private async runMixture(
    run: QuorumRun,
    roster: ModelOption[],
    aggregator: ModelOption | undefined,
    isCancelled: () => boolean,
  ): Promise<void> {
    const config = this.config()
    const steps = roster.map((model) =>
      this.addStep(run, {
        kind: "member",
        label: model.label,
        model: modelKey(model),
      }),
    )
    this.emit(run)

    const answers = await pool(
      roster.map((model, index) => ({ model, step: steps[index] as QuorumStep })),
      config.concurrency,
      async ({ model, step }) => {
        if (isCancelled()) return { role: model.id, text: "", error: "cancelled" }
        const text = await this.callWorker(run, step, model, proposePrompt(run.task, model.label))
        return { role: model.id, text, error: step.error }
      },
    )

    if (isCancelled()) return
    await this.aggregate(run, aggregator, answers, isCancelled)
  }

  // ---- strategy: debate --------------------------------------------------

  private async runDebate(
    run: QuorumRun,
    roster: ModelOption[],
    aggregator: ModelOption | undefined,
    isCancelled: () => boolean,
  ): Promise<void> {
    const config = this.config()
    // Each member keeps its own latest answer; later rounds revise it in place.
    const answers = new Map<string, string>()

    for (let round = 1; round <= config.rounds; round++) {
      if (isCancelled()) return
      const steps = roster.map((model) =>
        this.addStep(run, {
          kind: "member",
          label: model.label,
          model: modelKey(model),
          round,
        }),
      )
      this.emit(run)

      await pool(
        roster.map((model, index) => ({ model, step: steps[index] as QuorumStep })),
        config.concurrency,
        async ({ model, step }) => {
          if (isCancelled()) return { role: model.id, text: "", error: "cancelled" }
          const key = modelKey(model)
          const previous = answers.get(key)
          const prompt =
            round === 1
              ? proposePrompt(run.task, model.label)
              : critiquePrompt(
                  run.task,
                  previous ?? "",
                  roster
                    .filter((other) => modelKey(other) !== key)
                    .map((other) => ({ role: other.id, text: answers.get(modelKey(other)) ?? "(no answer)" })),
                )
          const text = await this.callWorker(run, step, model, prompt)
          if (text) answers.set(key, text)
          return { role: round === 1 ? model.id : `${model.id} (round ${round})`, text, error: step.error }
        },
      )

      if (round === 1) run.warnings.push(`debate: ${config.rounds} round(s)`)
      // Only the final round feeds the aggregator; earlier rounds exist to
      // sharpen the members' own answers.
      if (round === config.rounds) {
        const finalAnswers = roster.map((model) => ({
          role: model.id,
          text: answers.get(modelKey(model)) ?? "",
        }))
        if (isCancelled()) return
        await this.aggregate(run, aggregator, finalAnswers, isCancelled)
      }
    }
  }

  // ---- strategy: divide --------------------------------------------------

  private async runDivide(
    run: QuorumRun,
    roster: ModelOption[],
    aggregator: ModelOption | undefined,
    isCancelled: () => boolean,
  ): Promise<void> {
    const config = this.config()
    const models = await this.models()
    const planner = resolveRole(models, config.planner, roster[0]) ?? roster[0]
    if (!planner) return

    const planStep = this.addStep(run, { kind: "planner", label: planner.label, model: modelKey(planner) })
    this.emit(run)
    const planText = await this.callWorker(
      run,
      planStep,
      planner,
      planPrompt(run.task, Math.max(2, Math.min(8, roster.length * 2))),
      "text",
    )
    if (isCancelled()) return

    const parsed = extractJson(planText)
    const subtasks: Array<{ title: string; instruction: string }> = []
    if (isRecord(parsed) && Array.isArray(parsed.subtasks)) {
      for (const entry of parsed.subtasks) {
        if (!isRecord(entry)) continue
        const title = asString(entry.title) ?? `subtask ${subtasks.length + 1}`
        const instruction = asString(entry.instruction) ?? asString(entry.task) ?? title
        subtasks.push({ title, instruction })
      }
    }
    if (subtasks.length === 0) {
      run.warnings.push("planner returned no usable subtasks; falling back to a mixture run")
      await this.runMixture(run, roster, aggregator, isCancelled)
      return
    }

    const steps = subtasks.map((subtask) => this.addStep(run, { kind: "subtask", label: subtask.title, model: "" }))
    this.emit(run)

    const parts = await pool(
      subtasks.map((subtask, index) => ({ subtask, step: steps[index] as QuorumStep })),
      config.concurrency,
      async ({ subtask, step }, index) => {
        if (isCancelled()) return { title: subtask.title, text: "", error: "cancelled" }
        const model = roster[index % roster.length] as ModelOption
        step.model = modelKey(model)
        step.label = `${subtask.title} · ${model.id}`
        const text = await this.callWorker(
          run,
          step,
          model,
          subtaskPrompt(run.task, subtask.title, subtask.instruction),
        )
        return { title: subtask.title, text, error: step.error }
      },
    )

    if (isCancelled()) return

    const target = aggregator ?? roster[0]
    if (!target) return
    const mergeStep = this.addStep(run, { kind: "aggregator", label: target.label, model: modelKey(target) })
    this.emit(run)
    const merged = await this.callWorker(run, mergeStep, target, mergePrompt(run.task, parts), "text")
    if (merged) run.result = merged
  }

  // ---- strategy: relay ---------------------------------------------------

  private async runRelay(run: QuorumRun, roster: ModelOption[], isCancelled: () => boolean): Promise<void> {
    let draft = ""
    for (const model of roster) {
      if (isCancelled()) return
      const step = this.addStep(run, { kind: "relay", label: model.label, model: modelKey(model) })
      this.emit(run)
      const prompt = draft ? refinePrompt(run.task, draft, model.label) : proposePrompt(run.task, model.label)
      const text = await this.callWorker(run, step, model, prompt)
      // A failed stage keeps the previous draft rather than throwing the work away.
      if (text) draft = text
    }
    run.result = draft
  }

  // ---- strategy: vote ----------------------------------------------------

  private async runVote(
    run: QuorumRun,
    roster: ModelOption[],
    aggregator: ModelOption | undefined,
    isCancelled: () => boolean,
  ): Promise<void> {
    const config = this.config()
    const steps = roster.map((model) => this.addStep(run, { kind: "member", label: model.label, model: modelKey(model) }))
    this.emit(run)

    const answers = await pool(
      roster.map((model, index) => ({ model, step: steps[index] as QuorumStep })),
      config.concurrency,
      async ({ model, step }) => {
        if (isCancelled()) return { role: model.id, text: "", error: "cancelled" }
        const text = await this.callWorker(run, step, model, proposePrompt(run.task, model.label))
        return { role: model.id, text, error: step.error }
      },
    )
    if (isCancelled()) return

    const models = await this.models()
    const target = aggregator ?? resolveRole(models, config.judge, roster[0]) ?? roster[0]
    if (!target) return

    const judgeStep = this.addStep(run, { kind: "judge", label: target.label, model: modelKey(target) })
    this.emit(run)
    const verdict = await this.callWorker(
      run,
      judgeStep,
      target,
      judgePrompt(
        run.task,
        answers.map((answer) => ({ role: answer.role, text: answer.text })),
      ),
      "text",
    )
    if (isCancelled()) return

    const parsed = extractJson(verdict)
    if (isRecord(parsed)) {
      const answer = asString(parsed.answer)
      const rationale = asString(parsed.rationale)
      const winner = parsed.winner
      const confidence = parsed.confidence
      if (answer) {
        run.result = answer
        run.warnings.push(
          `judge: winner=${String(winner)} confidence=${String(confidence)}${rationale ? ` — ${rationale}` : ""}`,
        )
        return
      }
    }
    run.result = verdict
    run.warnings.push("judge did not return parseable JSON; raw verdict used")
  }

  // ---- aggregation -------------------------------------------------------

  private async aggregate(
    run: QuorumRun,
    aggregator: ModelOption | undefined,
    answers: Array<{ role: string; text: string; error?: string }>,
    isCancelled: () => boolean,
  ): Promise<void> {
    const usable = answers.filter((answer) => answer.text)
    if (usable.length === 0) {
      run.warnings.push("every member failed; no aggregation")
      run.error = "every member failed"
      return
    }
    if (isCancelled()) return

    if (!aggregator) {
      // No aggregator configured: return the longest answer rather than nothing.
      const best = usable.reduce((a, b) => (b.text.length > a.text.length ? b : a))
      run.result = best.text
      run.warnings.push("no aggregator configured; returned the most detailed member answer")
      return
    }

    const step = this.addStep(run, { kind: "aggregator", label: aggregator.label, model: modelKey(aggregator) })
    this.emit(run)
    const prompt = aggregatePrompt(
      run.task,
      answers.map((answer) => ({
        role: answer.role,
        text: trim(answer.text, this.config().maxOutputChars),
        error: answer.error,
      })),
    )
    const text = await this.callWorker(run, step, aggregator, prompt, "text")
    if (text) run.result = text
    else run.warnings.push("aggregator produced no output; returning member answers")
    if (!run.result) {
      const best = usable.reduce((a, b) => (b.text.length > a.text.length ? b : a))
      run.result = best.text
    }
  }

  // ---- workers -----------------------------------------------------------

  private addStep(run: QuorumRun, step: Omit<QuorumStep, "id" | "status">): QuorumStep {
    const created: QuorumStep = { id: `step_${shortID()}`, status: "pending", ...step }
    run.steps.push(created)
    return created
  }

  /**
   * Runs one worker and records the outcome on its step. A worker failure is
   * never fatal: the step is marked failed and the run continues without it.
   *
   * `mode` defaults to the run's worker mode. Merging, planning and judging pass
   * "text" explicitly: they are pure synthesis, and giving them an agent session
   * costs minutes for no benefit.
   */
  private async callWorker(
    run: QuorumRun,
    step: QuorumStep,
    model: ModelOption,
    prompt: string,
    mode: "text" | "agent" = run.workerMode,
  ): Promise<string> {
    if (this.cancelled.has(run.id)) {
      step.status = "cancelled"
      step.finishedAt = Date.now()
      return ""
    }
    const config = this.config()
    step.status = "running"
    step.startedAt = Date.now()
    this.emit(run)

    const label = `${step.kind}:${model.id}`
    try {
      const text =
        mode === "agent"
          ? await this.runAgentWorker(run, step, model, prompt)
          : await this.runTextWorker(model, prompt, label, config.timeoutMs)
      const cleaned = text.trim()
      // A run cancelled while this worker was in flight must not look finished.
      step.status = this.cancelled.has(run.id) ? "cancelled" : "done"
      step.output = cleaned
      step.chars = cleaned.length
      if (step.status === "done") {
        this.successes.set(modelKey(model), Date.now())
        if (this.successes.size > 200) {
          const oldest = [...this.successes.entries()].sort((a, b) => a[1] - b[1])[0]
          if (oldest) this.successes.delete(oldest[0])
        }
      }
      return cleaned
    } catch (error) {
      step.status = "failed"
      step.error = error instanceof Error ? error.message : String(error)
      // Remember it: the automatic roster will steer around this model for a
      // while, which is the only reliable signal that a model is not answering.
      this.failures.set(modelKey(model), Date.now())
      if (this.failures.size > 200) {
        const oldest = [...this.failures.entries()].sort((a, b) => a[1] - b[1])[0]
        if (oldest) this.failures.delete(oldest[0])
      }
      this.log(`worker ${label} failed:`, step.error)
      return ""
    } finally {
      step.finishedAt = Date.now()
      step.ms = step.startedAt ? step.finishedAt - step.startedAt : undefined
      this.emit(run)
    }
  }

  private async runTextWorker(
    model: ModelOption,
    prompt: string,
    label: string,
    timeoutMs: number,
  ): Promise<string> {
    const call = this.ctx.generate.text({
      prompt,
      model: { providerID: model.providerID, id: model.id },
    })
    const result = await withTimeout(call, timeoutMs, label)
    const payload = unwrap<{ text?: string }>(result)
    const text = asString(payload?.text) ?? asString((result as Unknown | undefined)?.text) ?? ""
    if (!text) throw new Error("model returned no text")
    return text
  }

  /**
   * Runs a worker as a real session: it can read files, run commands and edit the
   * repository.
   *
   * Completion is read from the transcript's `idle` marker rather than trusted to
   * `session.wait`, and a timeout never throws away work that was produced:
   * whatever the session has answered by then is harvested. Declaring failure on
   * the clock alone is what made finished agent work look timed out.
   */
  private async runAgentWorker(
    run: QuorumRun,
    step: QuorumStep,
    model: ModelOption,
    prompt: string,
  ): Promise<string> {
    const config = this.config()
    const created = await this.ctx.session.create({
      title: `quorum · ${step.kind} · ${shortModel(model)}`,
      parentID: run.sessionID,
      model: { providerID: model.providerID, id: model.id },
      metadata: { quorumRunID: run.id, quorumStepID: step.id },
    })
    const session = unwrap<{ id?: string }>(created)
    const sessionID = asString(session?.id)
    if (!sessionID) throw new Error("could not create a worker session")
    step.sessionID = sessionID
    this.emit(run)

    await this.ctx.session.prompt({ sessionID, text: prompt })

    const finished = await this.waitForAgent(run.id, sessionID, config.agentTimeoutMs)
    const text = (await this.agentAnswer(sessionID)).trim()

    // Still-running sessions are left alone: their work is often the point, and
    // removing one mid-flight would discard it.
    if (finished && !config.keepWorkerSessions) {
      try {
        await this.ctx.session.remove({ sessionID })
        step.sessionID = undefined
      } catch (error) {
        this.log("could not remove worker session:", error instanceof Error ? error.message : error)
      }
    }

    if (!text) {
      throw new Error(
        finished
          ? "the worker session finished without answering"
          : `no answer after ${Math.round(config.agentTimeoutMs / 1000)}s — session ${sessionID} is still working`,
      )
    }
    if (!finished) {
      run.warnings.push(
        `${model.id} passed the ${Math.round(config.agentTimeoutMs / 1000)}s limit; collected what it had produced ` +
          `(session ${sessionID} may still be running)`,
      )
    }
    return text
  }

  /** Waits for a worker session to go idle, polling the transcript as a backstop. */
  private async waitForAgent(runID: string, sessionID: string, timeoutMs: number): Promise<boolean> {
    // Fire `wait` but do not depend on it: if it never settles, polling still
    // notices the session going idle.
    void this.ctx.session.wait({ sessionID }).catch(() => {})
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.agentIdle(sessionID)) return true
      // Only this run's cancellation stops the wait.
      if (this.cancelled.has(runID)) return false
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    return false
  }

  /** True once the session has recorded an `idle` message (its own completion marker). */
  private async agentIdle(sessionID: string): Promise<boolean> {
    try {
      const messages = unwrap<unknown[]>(await this.ctx.session.context({ sessionID }))
      if (!Array.isArray(messages)) return false
      return messages.some((message) => isRecord(message) && asString(message.type) === "idle")
    } catch (error) {
      this.log("could not read worker transcript:", error instanceof Error ? error.message : error)
      return false
    }
  }

  private async agentAnswer(sessionID: string): Promise<string> {
    try {
      return extractAssistantText(unwrap<unknown[]>(await this.ctx.session.context({ sessionID })))
    } catch (error) {
      this.log("could not read worker answer:", error instanceof Error ? error.message : error)
      return ""
    }
  }

  // ---- lifecycle ---------------------------------------------------------

  private finish(run: QuorumRun, status: QuorumRun["status"], result?: string): void {
    if (run.status !== "running") return
    run.status = status
    run.finishedAt = Date.now()
    run.ms = run.finishedAt - run.startedAt
    if (result !== undefined) run.result = result
    if (status === "failed" && !run.error) {
      run.error = run.steps.find((step) => step.error)?.error ?? "run failed"
    }
    this.cancelled.delete(run.id)
    this.log(`run ${run.id} ${status} in ${run.ms}ms (${run.strategy})`)
    this.history.save(this.runs.values())
    this.emit(run)
  }

  // ---- streaming into the session ---------------------------------------

  /**
   * Mirrors the run into the originating session as a synthetic message so the
   * quorum is visible in the chat timeline. Throttled, because a run can emit
   * several updates per second.
   */
  private async streamToSession(run: QuorumRun): Promise<void> {
    const config = this.config()
    if (!config.streamToSession || !run.sessionID) return

    const now = Date.now()
    const last = this.lastStreamedAt.get(run.id) ?? 0
    const finished = run.status !== "running"
    if (!finished && now - last < 1_500) return
    this.lastStreamedAt.set(run.id, now)
    if (finished) this.lastStreamedAt.delete(run.id)

    const counts = run.steps.reduce<Record<string, number>>((acc, step) => {
      acc[step.status] = (acc[step.status] ?? 0) + 1
      return acc
    }, {})
    const summary = Object.entries(counts)
      .map(([status, count]) => `${count} ${status}`)
      .join(", ")
    const active = run.steps.find((step) => step.status === "running")
    const lines = [
      `quorum ${run.id} · ${run.strategy} · ${run.status}`,
      `task: ${run.task.slice(0, 160)}`,
      `steps: ${summary || "waiting"}`,
      active ? `running: ${active.label}` : "",
      run.result ? `result ready (${run.result.length} chars)` : "",
    ].filter(Boolean)

    try {
      await this.ctx.session.synthetic({
        sessionID: run.sessionID,
        text: lines.join("\n"),
        description: `quorum ${run.id}`,
        metadata: { quorumRunID: run.id, status: run.status },
      })
    } catch (error) {
      // Streaming is a nicety; never let it fail a run.
      this.log("could not stream to session:", error instanceof Error ? error.message : error)
    }
  }

  /** Describes a run in one line per step. Used by the tool and the command. */
  formatResult(run: QuorumRun): string {
    const header = `quorum ${run.id} · ${run.strategy} · ${run.status} · ${run.steps.filter((s) => s.status === "done").length}/${run.steps.length} steps`
    const body = run.result ?? run.error ?? "(no result)"
    return `${header}\n\n${body}`
  }
}
