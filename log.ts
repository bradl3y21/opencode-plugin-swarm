import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Swarm logging.
 *
 * OpenCode does not capture plugin console output in its own log, so every
 * line is appended to `~/.local/share/opencode/log/swarm.log` as well as the
 * console. The dashboard and the `/swarm activity` action read this file.
 */

const LOG_DIR = path.join(os.homedir(), ".local", "share", "opencode", "log")
const LOG_FILE = path.join(LOG_DIR, "swarm.log")
const MAX_BYTES = 512 * 1024

export type Log = (...args: unknown[]) => void

export function logFilePath(): string {
  return LOG_FILE
}

function format(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") return value
      if (value instanceof Error) return `${value.name}: ${value.message}`
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(" ")
}

function append(line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    // Keep the file from growing without bound across long sessions.
    try {
      if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      // Missing file on first write; nothing to rotate.
    }
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8")
  } catch {
    // Logging must never take the plugin down.
  }
}

/**
 * Creates a logger. `enabled` is read lazily so a live config reload can turn
 * logging on or off without restarting the plugin.
 */
export function createLogger(enabled: () => boolean): Log {
  return (...args: unknown[]) => {
    const line = `${new Date().toISOString()} ${format(args)}`
    if (enabled()) {
      console.log(`[swarm] ${format(args)}`)
      append(line)
    }
  }
}

export function clearLog(): void {
  try {
    fs.rmSync(LOG_FILE, { force: true })
  } catch {
    // Ignore.
  }
}

export function readLogTail(lines = 60): string {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean)
    return content.slice(Math.max(0, content.length - lines)).join("\n") || "(the log is empty)"
  } catch {
    return "(no log file yet)"
  }
}
