#!/usr/bin/env node
/**
 * Install the dashboard as soon as the app lets go of its archive.
 *
 * Installing needs `app.asar` to be writable, which means OpenCode has to be
 * closed — but this plugin is driven *from* OpenCode, so "close it and then tell
 * me" cannot work. This watcher breaks that deadlock: start it, quit OpenCode
 * whenever you like, and the install runs by itself in the gap. Reopen OpenCode
 * afterwards and the panel is already there.
 *
 * It refuses to act unless BOTH are true, so it can never patch an app that is
 * merely slow to start:
 *   - no OpenCode.exe process is running, and
 *   - app.asar opens for writing.
 *
 *   node install-when-free.mjs                 # wait up to 45 minutes
 *   node install-when-free.mjs --timeout 10    # minutes
 *   node install-when-free.mjs --dry-run       # report the plan, never install
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const logDir = path.join(os.homedir(), ".local", "share", "opencode", "log")
const logFile = path.join(logDir, "swarm-install.log")

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}
const timeoutMinutes = Number(arg("--timeout", 45))
const dryRun = process.argv.includes("--dry-run")

function say(line) {
  const stamped = `${new Date().toISOString()} ${line}`
  console.log(stamped)
  try {
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(logFile, `${stamped}\n`, "utf8")
  } catch {
    /* logging must never break the install */
  }
}

function findAsar() {
  const local = process.env.LOCALAPPDATA
  const candidates = []
  if (local) {
    const programs = path.join(local, "Programs")
    if (fs.existsSync(programs)) {
      for (const entry of fs.readdirSync(programs)) {
        if (/opencode/i.test(entry)) candidates.push(path.join(programs, entry, "resources", "app.asar"))
      }
    }
  }
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  throw new Error("could not find app.asar")
}

const asar = findAsar()

function appRunning() {
  try {
    const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq OpenCode.exe", "/NH"], { encoding: "utf8" })
    return /OpenCode\.exe/i.test(out.stdout ?? "")
  } catch {
    // If tasklist is unavailable, fall back to the lock probe alone.
    return false
  }
}

function writable() {
  try {
    const handle = fs.openSync(asar, "r+")
    fs.closeSync(handle)
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

say(`watching ${asar}`)
say(`waiting for OpenCode to close (up to ${timeoutMinutes} minutes)${dryRun ? " [dry run]" : ""}`)

const deadline = Date.now() + timeoutMinutes * 60_000
let waited = 0
while (Date.now() < deadline) {
  if (!appRunning() && writable()) break
  if (waited % 60_000 < 5_000) say(`still waiting… (app running: ${appRunning()}, archive writable: ${writable()})`)
  await sleep(5_000)
  waited += 5_000
}

if (appRunning() || !writable()) {
  say("timed out — nothing was changed. Re-run when OpenCode is closed, or use harness.mjs instead.")
  process.exitCode = 1
} else if (dryRun) {
  say("the archive is free; a real run would install now. Nothing was changed (dry run).")
} else {
  say("archive is free — installing")

  const selftest = spawnSync(process.execPath, [path.join(here, "selftest.mjs")], { encoding: "utf8" })
  say(`selftest exit ${selftest.status}`)
  for (const line of (selftest.stdout ?? "").trim().split(/\r?\n/)) say(`  ${line}`)

  if (selftest.status !== 0) {
    say("selftest failed — refusing to install. The archive was not modified.")
    process.exitCode = 1
  } else {
    const install = spawnSync(process.execPath, [path.join(here, "install.mjs")], { encoding: "utf8" })
    say(`install exit ${install.status}`)
    for (const line of (install.stdout ?? "").trim().split(/\r?\n/)) say(`  ${line}`)
    if (install.stderr) for (const line of install.stderr.trim().split(/\r?\n/)) say(`  ! ${line}`)

    // Independent check: read the archive back and compare the two hashes.
    if (install.status === 0) {
      const crypto = await import("node:crypto")
      const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
      const patched = hash(asar)
      const backup = fs.existsSync(`${asar}.swarm-backup`) ? hash(`${asar}.swarm-backup`) : "(no backup)"
      say(`app.asar        ${patched.slice(0, 16)}…`)
      say(`backup          ${backup.slice(0, 16)}…`)
      say(patched !== backup ? "archive changed as intended" : "WARNING: archive is unchanged — install did not take effect")

      // Prove the app still starts, and put it back if it does not. A patched
      // archive that the app refuses to open is the one failure that matters, and
      // it is detectable: the app records a log directory on startup.
      if (!process.argv.includes("--no-verify-launch")) {
        const logsRoot = path.join(os.homedir(), "AppData", "Roaming", "ai.opencode.desktop", "logs")
        const exe = path.join(path.dirname(path.dirname(asar)), "OpenCode.exe")
        if (fs.existsSync(exe) && fs.existsSync(logsRoot)) {
          const known = new Set(fs.readdirSync(logsRoot))
          say("starting OpenCode to confirm it launches…")
          const { spawn } = await import("node:child_process")
          spawn(exe, [], { detached: true, stdio: "ignore" }).unref()

          let started = false
          for (let attempt = 0; attempt < 30 && !started; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 2000))
            started = fs.readdirSync(logsRoot).some((entry) => !known.has(entry))
          }

          if (started) {
            say("OpenCode started normally — the install is good.")
            say("Swarm is in the title bar, beside Home and New session.")
          } else {
            say("OpenCode did not start. Rolling back to the untouched archive…")
            try {
              fs.copyFileSync(backup, asar)
              say("rolled back — OpenCode is back to its original state. No reinstall needed.")
              say("Please report this; the panel is not installed.")
            } catch (error) {
              say(`ROLLBACK FAILED (${error}). Restore manually: copy ${backup} over ${asar}`)
            }
          }
        } else {
          say("Done. Start OpenCode — Swarm is in the title bar, beside Home and New session.")
        }
      } else {
        say("Done. Start OpenCode — Swarm is in the title bar, beside Home and New session.")
      }
    }
  }
}
