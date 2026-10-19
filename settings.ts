import { STRATEGIES, WORKER_MODES, type SwarmConfig } from "./config"

/**
 * Tool-argument handling for saved configuration.
 *
 * Kept separate from the plugin entrypoint (and free of runtime imports) so the
 * rules can be tested directly: this is the code that decides what an agent is
 * allowed to persist.
 */

type Unknown = Record<string, unknown>

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

/** The live configuration, rendered for tool output. */
export function describeConfig(config: SwarmConfig): string {
  return JSON.stringify(
    {
      strategy: config.strategy,
      members: config.members,
      copies: config.copies,
      aggregator: config.aggregator ?? "auto",
      workerMode: config.workerMode,
      rounds: config.rounds,
      concurrency: config.concurrency,
      timeoutMs: config.timeoutMs,
      agentTimeoutMs: config.agentTimeoutMs,
    },
    null,
    2,
  )
}

/**
 * Turns tool arguments into a validated configuration patch.
 *
 * Only recognised settings with sane values are written; anything else is
 * reported back rather than persisted, so an agent cannot save a configuration
 * the plugin will not understand.
 */
export function buildConfigPatch(args: Unknown): { patch: Record<string, unknown>; rejected: string[] } {
  const patch: Record<string, unknown> = {}
  const rejected: string[] = []

  const strategy = asString(args.strategy)
  if (strategy !== undefined) {
    if ((STRATEGIES as readonly string[]).includes(strategy)) patch.strategy = strategy
    else rejected.push(`strategy "${strategy}" (expected ${STRATEGIES.join(", ")})`)
  }

  const workerMode = asString(args.workerMode)
  if (workerMode !== undefined) {
    if ((WORKER_MODES as readonly string[]).includes(workerMode)) patch.workerMode = workerMode
    else rejected.push(`workerMode "${workerMode}" (expected ${WORKER_MODES.join(" or ")})`)
  }

  if (args.members !== undefined) {
    const members = asList(args.members)
    if (members) patch.members = members
    else rejected.push("members (expected a list of model references)")
  }

  const aggregator = asString(args.aggregator)
  if (aggregator !== undefined) {
    // "auto" restores the default, which is the first member of the roster.
    patch.aggregator = aggregator === "auto" ? null : aggregator
  }

  for (const [key, min, max] of [
    ["copies", 1, 8],
    ["rounds", 1, 6],
    ["concurrency", 1, 12],
    ["timeoutMs", 5_000, 900_000],
    ["agentTimeoutMs", 10_000, 3_600_000],
  ] as const) {
    const raw = args[key]
    if (raw === undefined) continue
    const value = Math.round(Number(raw))
    if (Number.isFinite(value) && value >= min && value <= max) patch[key] = value
    else rejected.push(`${key} (expected ${min} to ${max})`)
  }

  return { patch, rejected }
}
