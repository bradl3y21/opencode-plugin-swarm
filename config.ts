import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Configuration for the swarm plugin.
 *
 * Resolution order (later wins):
 *   1. built-in defaults
 *   2. `~/.config/opencode/swarm.json`      (global)
 *   3. `<project>/.opencode/swarm.json`     (project)
 *   4. `OPENCODE_SWARM_*` environment variables
 *   5. plugin `options` from `opencode.json(c)`
 *
 * The dashboard writes the project file, and the running plugin re-reads it the
 * next time it is asked for anything, so changes apply without a restart.
 */

export const STRATEGIES = ["mixture", "debate", "divide", "relay", "vote"] as const
export type Strategy = (typeof STRATEGIES)[number]

export const WORKER_MODES = ["text", "agent"] as const
export type WorkerMode = (typeof WORKER_MODES)[number]

export interface SwarmConfig {
  /** Master switch. Turn off to keep the plugin loaded but idle. */
  enabled: boolean
  strategy: Strategy
  /**
   * Members of the swarm, written as `providerID/modelID`. Empty means
   * "pick automatically", which chooses a diverse roster from the models the
   * user has enabled (see `autoMembers`).
   */
  members: string[]
  /** Model that merges the members' work into the final answer. */
  aggregator?: string
  /** Model that splits a task into subtasks for the `divide` strategy. */
  planner?: string
  /** Model that judges the winner for the `vote` strategy. */
  judge?: string
  /**
   * `text`  - workers are plain model calls (fast, cheap, no tools).
   * `agent` - workers are real OpenCode sessions that can use tools and edit
   *           files. Powerful, and it touches your repository.
   */
  workerMode: WorkerMode
  /** Debate rounds (including the opening round). */
  rounds: number
  /**
   * How many times to run each member. Above 1 this is a swarm of the same
   * model: several independent attempts, each given a deliberately different
   * framing so they do not simply repeat each other.
   */
  copies: number
  /** How many workers may run at the same time. */
  concurrency: number
  /** How many models `members` auto-selection picks. */
  autoMembers: number
  /**
   * Per-worker timeout for text workers, in milliseconds.
   *
   * Text workers are single model calls, so a couple of minutes is already
   * generous.
   */
  timeoutMs: number
  /**
   * Per-worker timeout for agent workers, in milliseconds.
   *
   * Agent workers are full sessions that may read files, run commands and edit
   * code, so they legitimately take many minutes. Applying the text timeout to
   * them marked finished work as timed out.
   */
  agentTimeoutMs: number
  /** Truncate each worker's output before it is handed to the aggregator. */
  maxOutputChars: number
  /**
   * Stream progress into the session that started the run as synthetic
   * messages, so the swarm is visible in the chat timeline.
   */
  streamToSession: boolean
  /** Register the `swarm` tool so the agent can run the swarm itself. */
  tool: boolean
  /** Register the `/swarm` command. */
  command: boolean
  /** Keep worker sessions after an agent-mode run so you can inspect them. */
  keepWorkerSessions: boolean
  /** Append plugin activity to `~/.local/share/opencode/log/swarm.log`. */
  debugLog: boolean
}

export const DEFAULTS: SwarmConfig = {
  enabled: true,
  strategy: "mixture",
  members: [],
  aggregator: undefined,
  planner: undefined,
  judge: undefined,
  workerMode: "text",
  rounds: 2,
  copies: 1,
  concurrency: 4,
  autoMembers: 4,
  timeoutMs: 180_000,
  agentTimeoutMs: 900_000,
  maxOutputChars: 6_000,
  streamToSession: true,
  tool: true,
  command: true,
  keepWorkerSessions: true,
  debugLog: true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function merge<T>(base: T, override: unknown): T {
  if (override === undefined) return base
  if (!isRecord(base) || !isRecord(override)) return override as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = isRecord(out[key]) && isRecord(value) ? merge(out[key], value) : value
  }
  return out as T
}

/** Replaces `{env:NAME}` anywhere in a string with that environment variable. */
function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "")
  }
  if (Array.isArray(value)) return value.map(expandEnv)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) out[key] = expandEnv(entry)
    return out
  }
  return value
}

function readJson(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return undefined
    const raw = fs.readFileSync(file, "utf8")
    try {
      return JSON.parse(raw)
    } catch {
      // Forgive comments only after plain JSON fails, so values that contain
      // `//` are never rewritten.
      return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))
    }
  } catch (error) {
    console.error(`[swarm] could not read ${file}:`, error instanceof Error ? error.message : error)
    return undefined
  }
}

function asBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return undefined
}

function asNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function asList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function fromEnv(): Record<string, unknown> {
  const env = process.env
  const out: Record<string, unknown> = {}
  const enabled = asBool(env.OPENCODE_SWARM_ENABLED)
  if (enabled !== undefined) out.enabled = enabled
  if (env.OPENCODE_SWARM_STRATEGY && (STRATEGIES as readonly string[]).includes(env.OPENCODE_SWARM_STRATEGY.trim())) {
    out.strategy = env.OPENCODE_SWARM_STRATEGY.trim()
  }
  const members = asList(env.OPENCODE_SWARM_MEMBERS)
  if (members) out.members = members
  if (env.OPENCODE_SWARM_AGGREGATOR) out.aggregator = env.OPENCODE_SWARM_AGGREGATOR
  if (env.OPENCODE_SWARM_PLANNER) out.planner = env.OPENCODE_SWARM_PLANNER
  if (env.OPENCODE_SWARM_JUDGE) out.judge = env.OPENCODE_SWARM_JUDGE
  if (env.OPENCODE_SWARM_WORKER_MODE && (WORKER_MODES as readonly string[]).includes(env.OPENCODE_SWARM_WORKER_MODE.trim())) {
    out.workerMode = env.OPENCODE_SWARM_WORKER_MODE.trim()
  }
  const rounds = asNumber(env.OPENCODE_SWARM_ROUNDS)
  if (rounds !== undefined) out.rounds = rounds
  const copies = asNumber(env.OPENCODE_SWARM_COPIES)
  if (copies !== undefined) out.copies = copies
  const concurrency = asNumber(env.OPENCODE_SWARM_CONCURRENCY)
  if (concurrency !== undefined) out.concurrency = concurrency
  const autoMembers = asNumber(env.OPENCODE_SWARM_AUTO_MEMBERS)
  if (autoMembers !== undefined) out.autoMembers = autoMembers
  const timeoutMs = asNumber(env.OPENCODE_SWARM_TIMEOUT_MS)
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs
  const agentTimeoutMs = asNumber(env.OPENCODE_SWARM_AGENT_TIMEOUT_MS)
  if (agentTimeoutMs !== undefined) out.agentTimeoutMs = agentTimeoutMs
  const maxOutputChars = asNumber(env.OPENCODE_SWARM_MAX_OUTPUT_CHARS)
  if (maxOutputChars !== undefined) out.maxOutputChars = maxOutputChars
  const stream = asBool(env.OPENCODE_SWARM_STREAM)
  if (stream !== undefined) out.streamToSession = stream
  const tool = asBool(env.OPENCODE_SWARM_TOOL)
  if (tool !== undefined) out.tool = tool
  const command = asBool(env.OPENCODE_SWARM_COMMAND)
  if (command !== undefined) out.command = command
  const keepWorkerSessions = asBool(env.OPENCODE_SWARM_KEEP_WORKER_SESSIONS)
  if (keepWorkerSessions !== undefined) out.keepWorkerSessions = keepWorkerSessions
  const debugLog = asBool(env.OPENCODE_SWARM_DEBUG_LOG)
  if (debugLog !== undefined) out.debugLog = debugLog
  return out
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function normalize(config: SwarmConfig): SwarmConfig {
  if (!(STRATEGIES as readonly string[]).includes(config.strategy)) config.strategy = DEFAULTS.strategy
  if (!(WORKER_MODES as readonly string[]).includes(config.workerMode)) config.workerMode = DEFAULTS.workerMode
  config.rounds = clamp(Number(config.rounds) || DEFAULTS.rounds, 1, 6)
  config.copies = clamp(Number(config.copies) || DEFAULTS.copies, 1, 8)
  config.concurrency = clamp(Number(config.concurrency) || DEFAULTS.concurrency, 1, 12)
  config.autoMembers = clamp(Number(config.autoMembers) || DEFAULTS.autoMembers, 1, 16)
  config.timeoutMs = clamp(Number(config.timeoutMs) || DEFAULTS.timeoutMs, 5_000, 900_000)
  config.agentTimeoutMs = clamp(Number(config.agentTimeoutMs) || DEFAULTS.agentTimeoutMs, 10_000, 3_600_000)
  config.maxOutputChars = clamp(Number(config.maxOutputChars) || DEFAULTS.maxOutputChars, 200, 100_000)
  const members = config.members as unknown
  config.members = (Array.isArray(members) ? members : typeof members === "string" ? String(members).split(",") : [])
    .map((entry) => String(entry).trim())
    .filter(Boolean)
  return config
}

export interface LoadedConfig {
  config: SwarmConfig
  sources: string[]
}

/** The two files the dashboard and the loader agree on. */
export function configFiles(directory?: string): { global: string; project?: string } {
  return {
    global: path.join(os.homedir(), ".config", "opencode", "swarm.json"),
    project: directory ? path.join(directory, ".opencode", "swarm.json") : undefined,
  }
}

export function loadConfig(ctx: { location?: { directory?: string }; options?: unknown }): LoadedConfig {
  const sources: string[] = []
  let config = structuredClone(DEFAULTS)

  const globalFile = configFiles().global
  const globalJson = readJson(globalFile)
  if (globalJson !== undefined) {
    config = merge(config, expandEnv(globalJson))
    sources.push(globalFile)
  }

  const directory = ctx.location?.directory
  const projectFile = configFiles(directory).project
  if (projectFile) {
    const projectJson = readJson(projectFile)
    if (projectJson !== undefined) {
      config = merge(config, expandEnv(projectJson))
      sources.push(projectFile)
    }
  }

  const environment = expandEnv(fromEnv())
  if (Object.keys(environment as object).length) {
    config = merge(config, environment)
    sources.push("environment")
  }

  if (ctx.options && isRecord(ctx.options) && Object.keys(ctx.options).length) {
    config = merge(config, expandEnv(ctx.options))
    sources.push("plugin options")
  }

  return { config: normalize(config), sources }
}

export interface ConfigStore {
  current(): SwarmConfig
  sources(): string[]
  reload(): SwarmConfig
}

/** Cheap change check so hand edits take effect without a restart. */
function fileStamps(directory?: string): string {
  const { global, project } = configFiles(directory)
  return [global, project]
    .filter((file): file is string => Boolean(file))
    .map((file) => {
      try {
        const stat = fs.statSync(file)
        return `${file}:${stat.mtimeMs}:${stat.size}`
      } catch {
        return `${file}:0`
      }
    })
    .join("|")
}

export function createConfigStore(
  ctx: { location?: { directory?: string }; options?: unknown },
  onReload?: (config: SwarmConfig, sources: string[]) => void,
): ConfigStore {
  const directory = ctx.location?.directory
  let stamps = fileStamps(directory)
  let loaded = loadConfig(ctx)

  const reread = (notify: boolean): SwarmConfig => {
    stamps = fileStamps(directory)
    loaded = loadConfig(ctx)
    if (notify) onReload?.(loaded.config, loaded.sources)
    return loaded.config
  }

  return {
    current() {
      if (fileStamps(directory) !== stamps) return reread(true)
      return loaded.config
    },
    sources: () => loaded.sources,
    reload: () => reread(false),
  }
}

/** Keeps the file self-documenting after the panel rewrites it. */
const BANNER = [
  "// swarm configuration — the Swarm panel writes this file, and the plugin",
  "// re-reads it immediately. Reference: .opencode/plugins/swarm/README.md",
  "",
].join("\n")

/** Merges `patch` into the project config file, creating it when needed. */
export function writeProjectConfig(directory: string | undefined, patch: Record<string, unknown>): string {
  const file = configFiles(directory).project ?? path.join(process.cwd(), ".opencode", "swarm.json")
  const existing = readJson(file)
  const merged = merge(isRecord(existing) ? existing : {}, patch)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Write then rename so a concurrent read never sees a half-written file.
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, `${BANNER}${JSON.stringify(merged, null, 2)}\n`, "utf8")
  fs.renameSync(temp, file)
  return file
}

/** Config without secrets, safe to log or send to a client. */
export function redact(config: SwarmConfig): SwarmConfig {
  return { ...config }
}
