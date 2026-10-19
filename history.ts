/**
 * Run history on disk.
 *
 * Runs live in memory while the plugin is loaded, which means a reload or a
 * service restart loses them — including the answer someone was reading. Every
 * finished run is appended here so the dashboard and `/quorum status` still show
 * what happened before.
 *
 * The file is per directory (`.`), because one machine runs many projects and a
 * run only makes sense next to the code it was about.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { QuorumRun } from "./engine"

/** How many runs to keep per directory. */
const KEEP = 20
/** Long outputs are trimmed: this is a history, not an archive. */
const MAX_STEP_CHARS = 2_000
const MAX_RESULT_CHARS = 8_000

const FILE = path.join(os.homedir(), ".local", "share", "opencode", "quorum-runs.json")

type Store = Record<string, QuorumRun[]>

function read(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

function trim(run: QuorumRun): QuorumRun {
  return {
    ...run,
    result: run.result && run.result.length > MAX_RESULT_CHARS ? `${run.result.slice(0, MAX_RESULT_CHARS)}…` : run.result,
    steps: run.steps.map((step) => ({
      ...step,
      output:
        step.output && step.output.length > MAX_STEP_CHARS ? `${step.output.slice(0, MAX_STEP_CHARS)}…` : step.output,
    })),
  }
}

export interface RunHistory {
  load(): QuorumRun[]
  save(runs: Iterable<QuorumRun>): void
}

export function createHistory(directory: string | undefined, log: (message: string) => void): RunHistory {
  const key = directory ?? "(no directory)"

  return {
    /**
     * Finished runs, oldest first. A run recorded as still running belongs to a
     * process that died: it is reported as interrupted rather than left spinning
     * forever in the panel.
     */
    load() {
      const stored = read()[key]
      if (!Array.isArray(stored)) return []
      return stored
        .filter((run) => run && typeof run.id === "string")
        .map((run) =>
          run.status === "running"
            ? {
                ...run,
                status: "failed" as const,
                error: run.error ?? "interrupted by a restart",
                finishedAt: run.finishedAt ?? Date.now(),
                steps: run.steps?.map((step) =>
                  step.status === "running" ? { ...step, status: "failed" as const, error: step.error ?? "interrupted" } : step,
                ),
              }
            : run,
        )
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    },

    save(runs) {
      try {
        const finished = [...runs].filter((run) => run.status !== "running").slice(-KEEP)
        const store = read()
        store[key] = finished.map(trim)
        fs.mkdirSync(path.dirname(FILE), { recursive: true })
        const temp = `${FILE}.tmp`
        fs.writeFileSync(temp, JSON.stringify(store, null, 1), "utf8")
        fs.renameSync(temp, FILE)
      } catch (error) {
        log(`could not write run history: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

export const historyFile = FILE
