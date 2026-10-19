#!/usr/bin/env node
/**
 * Verify a patched dashboard against the pristine backup.
 *
 * The installer checks its own work, but this does the stronger, independent
 * check: it reads both archives and proves that the patch changed *exactly* the
 * two entries it claims to, and that every other file in the app is still
 * byte-for-byte what it was. Useful after an install, and after an app update
 * to see whether the patch is still present.
 *
 *   node verify.mjs
 */

import fs from "node:fs"
import { findAsar, leaves, readAsar } from "./install.mjs"

const PANEL_ENTRY = "/out/renderer/quorum-panel.js"
const HTML_ENTRY = "/out/renderer/index.html"
const MARKER = "<!-- quorum-dashboard -->"

const asarFlag = process.argv.indexOf("--asar")
const asar = asarFlag === -1 ? findAsar() : process.argv[asarFlag + 1]
const backup = `${asar}.quorum-backup`

let failures = 0
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

if (!fs.existsSync(backup)) {
  console.error(
    `No backup at ${backup}; nothing to compare against.\n` +
      "The dashboard does not appear to be installed. Install it with `node install.mjs` first.",
  )
  process.exitCode = 1
} else {
  const before = readAsar(backup)
  const after = readAsar(asar)
  const readEntry = (archive, entry) =>
    entry
      ? archive.blob.subarray(Number(entry.node.offset), Number(entry.node.offset) + Number(entry.node.size))
      : undefined

  const beforeLeaves = leaves(before.header)
  const afterLeaves = leaves(after.header)
  const beforeByPath = new Map(beforeLeaves.map((entry) => [entry.path, entry]))
  const afterByPath = new Map(afterLeaves.map((entry) => [entry.path, entry]))

  check("panel file was added", afterByPath.has(PANEL_ENTRY))
  check("entry count grew by exactly one", afterLeaves.length === beforeLeaves.length + 1,
    `${beforeLeaves.length} -> ${afterLeaves.length}`)

  // The panel must match the source file on disk exactly.
  const source = fs.readFileSync(new URL("./quorum-panel.js", import.meta.url))
  const panel = readEntry(after, afterByPath.get(PANEL_ENTRY))
  check("panel content matches the source file", Boolean(panel) && panel.equals(source),
    panel ? `${panel.length} vs ${source.length} bytes` : "missing")

  // index.html must contain the marker, both scripts, and still load the app.
  const html = readEntry(after, afterByPath.get(HTML_ENTRY))?.toString("utf8") ?? ""
  const original = readEntry(before, beforeByPath.get(HTML_ENTRY))?.toString("utf8") ?? ""
  check("index.html carries the marker", html.includes(MARKER))
  check("index.html loads the panel", html.includes('src="./quorum-panel.js"'))
  check("index.html still loads the app", html.includes("assets/main-"))
  check("capture runs before the app's module", html.indexOf("__quorumNet") < html.indexOf("assets/main-"))
  const stripped = html.replace(/<!-- quorum-dashboard -->[\s\S]*?<!-- \/quorum-dashboard -->/, "")
  check("removing the block restores index.html exactly", stripped === original,
    `${original.length} -> ${html.length} bytes`)

  // Every other file must be untouched — this is the real proof.
  let changed = []
  for (const [path, entry] of beforeByPath) {
    if (path === HTML_ENTRY) continue
    const now = afterByPath.get(path)
    if (!now) { changed.push(`${path} (missing)`); continue }
    if (now.node.link !== undefined || now.node.unpacked || entry.node.unpacked) continue
    const a = readEntry(before, entry)
    const b = readEntry(after, now)
    if (!a || !b || !a.equals(b)) changed.push(path)
  }
  check("no other file was modified", changed.length === 0, changed.slice(0, 5).join(", "))

  console.log(`\narchive  ${fs.statSync(asar).size} bytes`)
  console.log(`backup   ${fs.statSync(backup).size} bytes`)
  console.log(failures === 0
    ? "\nThe patch is exactly what it claims to be, and nothing else changed."
    : `\n${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
}
