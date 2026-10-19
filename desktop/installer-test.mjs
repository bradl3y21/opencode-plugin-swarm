/**
 * Offline proof for the append-only installer.
 *
 * Patches *copies* of the real archive — never the installed one — and checks the
 * invariants that make it safe, including on a copy deliberately given the quirk
 * that broke an earlier install (bytes in the data section that no entry claims).
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { findAsar, leaves, readAsar } from "./install.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const work = path.join(os.tmpdir(), "swarm-asar-test")
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })

let failures = 0
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

/**
 * The archive to test against: the untouched backup when the panel is installed.
 * Testing against a patched archive would make "entry count grew by one" fail for
 * the right reason and hide the real invariant.
 */
function sourceArchive() {
  const installed = findAsar()
  const backup = `${installed}.swarm-backup`
  return fs.existsSync(backup) ? backup : installed
}

/** Copies the real archive to a working file, optionally with trailing junk bytes. */
function makeCase(name, { junkBytes = 0 } = {}) {
  const target = path.join(work, `${name}.asar`)
  const source = fs.readFileSync(sourceArchive())
  if (junkBytes > 0) {
    // Simulates an archive whose data section holds bytes no entry claims —
    // the shape of the build that failed to start after the old installer.
    fs.writeFileSync(target, Buffer.concat([source, Buffer.alloc(junkBytes, 0x20)]))
  } else {
    fs.writeFileSync(target, source)
  }
  return target
}

function run(script, args) {
  return spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: "utf8" })
}

for (const isCase of [
  { name: "clean", junkBytes: 0 },
  { name: "unclaimed-bytes", junkBytes: 2 },
]) {
  console.log(`\n=== ${isCase.name} archive ===`)
  const target = makeCase(isCase.name, isCase)
  const before = readAsar(target)
  const beforeEntries = new Map(leaves(before.header).map((e) => [e.path, `${e.node.offset}:${e.node.size}`]))
  const beforeBlob = before.blob

  const installed = run("install.mjs", ["--asar", target])
  check("installer succeeded", installed.status === 0, (installed.stdout || "").trim().split("\n").slice(-1)[0] || installed.stderr?.slice(0, 120))
  if (installed.status !== 0) {
    console.log(installed.stdout?.slice(-600) ?? "")
    console.log(installed.stderr?.slice(0, 400) ?? "")
    continue
  }

  const after = readAsar(target)
  const afterEntries = new Map(leaves(after.header).map((e) => [e.path, `${e.node.offset}:${e.node.size}`]))

  // The property that failed before: nothing existing may move, and the original
  // data must survive untouched as a prefix of the new data section.
  const moved = [...beforeEntries.keys()]
    .filter((p) => p !== "/out/renderer/index.html")
    .filter((p) => afterEntries.get(p) !== beforeEntries.get(p))
  check("no pre-existing entry moved", moved.length === 0, moved.slice(0, 3).join(", "))
  check(
    "original data section preserved as a prefix",
    after.blob.subarray(0, beforeBlob.length).equals(beforeBlob),
    `${beforeBlob.length} -> ${after.blob.length} bytes`,
  )
  check(
    "the panel was appended at the end",
    Number(afterEntries.get("/out/renderer/swarm-panel.js")?.split(":")[0]) === beforeBlob.length,
  )
  check("entry count grew by exactly one", afterEntries.size === beforeEntries.size + 1)

  const html = afterEntries.get("/out/renderer/index.html")
  const htmlBytes = after.blob
    .subarray(Number(html.split(":")[0]), Number(html.split(":")[0]) + Number(html.split(":")[1]))
    .toString("utf8")
  check("index.html carries the marker", htmlBytes.includes("<!-- swarm-dashboard -->"))

  // And the separate verifier agrees.
  const verified = run("verify.mjs", ["--asar", target])
  check("verify.mjs passes", verified.status === 0, verified.status === 0 ? "" : (verified.stdout || "").split("\n").filter((l) => l.startsWith("FAIL")).join("; "))
}

console.log(`\n${failures === 0 ? "All installer checks passed." : `${failures} check(s) failed.`}`)
console.log(`working copies in ${work}`)
process.exitCode = failures === 0 ? 0 : 1
