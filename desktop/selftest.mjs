#!/usr/bin/env node
/**
 * Safety checks for the archive writer.
 *
 * Run this before installing: it proves that repacking the archive is
 * byte-for-byte lossless, and that the HTML patch behaves correctly. If this
 * passes, the installer cannot corrupt the app bundle.
 *
 * It understands both states, because the archive you are looking at may
 * already carry the patch (an update, or a re-install):
 *   - pristine: patching adds the block, is idempotent, and is reversible;
 *   - patched:  removing the block yields the pristine form, and re-patching
 *               that form reproduces the patched form exactly.
 *
 *   node selftest.mjs
 */

import fs from "node:fs"
import { findAsar, leaves, patchArchive, patchHtml, readAsar, unpatchHtml } from "./install.mjs"

const HTML_ENTRY = "/out/renderer/index.html"
const MARKER = "<!-- swarm-dashboard -->"

const asar = findAsar()
const original = fs.readFileSync(asar)
const { header, blob, json } = readAsar(asar)

let failures = 0
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const countScripts = (html) => (html.match(/<script/g) ?? []).length
/** Parsing and re-encoding normalises differences that are only textual. */
const canonical = (text) => JSON.stringify(JSON.parse(text))

// 1. A patch must APPEND, and never move anything that already exists. That is
//    the property that matters: a previous version re-packed the archive and
//    recomputed every offset, which broke an app update because an archive's
//    recorded boundaries are not always a perfect tiling. Proven here on a probe
//    patch, so it is checked before anything is written.
const probeArchive = readAsar(asar)
const probeBefore = leaves(probeArchive.header).map((entry) => ({
  path: entry.path,
  signature: `${entry.node.offset}:${entry.node.size}`,
}))
const PROBE_PATH = "/swarm-selftest-probe.js"
const probeBytes = Buffer.from("// swarm selftest probe\n", "utf8")
const probePatched = patchArchive(probeArchive.header, probeArchive.blob, {
  replaced: new Map([[HTML_ENTRY, Buffer.from("<!-- probe -->", "utf8")]]),
  added: new Map([[PROBE_PATH, probeBytes]]),
})
const probeJsonLength = probePatched.readUInt32LE(12)
const probeDataStart = 16 + Math.ceil(probeJsonLength / 4) * 4
const probeHeader = JSON.parse(probePatched.subarray(16, 16 + probeJsonLength).toString("utf8"))
const probeBlob = probePatched.subarray(probeDataStart)
const probeAfter = new Map(leaves(probeHeader).map((entry) => [entry.path, entry]))

check(
  "the original data section is preserved byte for byte as a prefix",
  probeBlob.subarray(0, probeArchive.blob.length).equals(probeArchive.blob),
  `${probeArchive.blob.length} of ${probeBlob.length} bytes`,
)
check("entry count grew by exactly one", probeAfter.size === probeBefore.length + 1, `${probeBefore.length} -> ${probeAfter.size}`)

const moved = probeBefore
  .filter((entry) => entry.path !== HTML_ENTRY && entry.path !== PROBE_PATH)
  .filter((entry) => `${probeAfter.get(entry.path)?.node.offset}:${probeAfter.get(entry.path)?.node.size}` !== entry.signature)
  .map((entry) => entry.path)
check("no pre-existing entry moved", moved.length === 0, moved.slice(0, 3).join(", "))

const probeNode = probeAfter.get(PROBE_PATH)?.node
check(
  "the new entry was appended at the end of the data section",
  Number(probeNode?.offset) === probeArchive.blob.length,
  `offset ${probeNode?.offset}, data ends at ${probeArchive.blob.length}`,
)
check(
  "the appended bytes read back exactly",
  Boolean(probeNode) &&
    probeBlob
      .subarray(Number(probeNode.offset), Number(probeNode.offset) + Number(probeNode.size))
      .equals(probeBytes),
)

// The header JSON is padded to four bytes (Chromium pickle alignment). Writing it
// unpadded produces an archive the app refuses to open — this is what broke a
// 2.0.32 install — and reading it unpadded shifts every entry.
const probePrologue = [0, 4, 8, 12].map((offset) => probePatched.readUInt32LE(offset))
const probeRawLength = probePrologue[3]
check(
  "patched header is 4-byte aligned",
  probePrologue[0] === 4 &&
    probePrologue[1] === Math.ceil(probeRawLength / 4) * 4 + 8 &&
    probePrologue[2] === Math.ceil(probeRawLength / 4) * 4 + 4,
  `prologue ${probePrologue.join(", ")}`,
)

// Every entry must sit inside the data section without overlapping another.
// (Replacing an entry by appending leaves its old bytes orphaned, so a hole is
// expected — but two entries must never claim the same bytes.)
const probePacked = leaves(probeHeader).filter((entry) => entry.node.link === undefined && !entry.node.unpacked)
const extent = probePacked
  .map((entry) => ({
    path: entry.path,
    start: Number(entry.node.offset),
    end: Number(entry.node.offset) + Number(entry.node.size),
  }))
  .sort((left, right) => left.start - right.start)
let extentProblem = ""
for (let index = 0; index < extent.length; index++) {
  const current = extent[index]
  if (current.start < 0 || current.end > probeBlob.length) extentProblem = `${current.path} is out of bounds`
  const previous = extent[index - 1]
  if (previous && current.start < previous.end) extentProblem = `${current.path} overlaps ${previous.path}`
}
check("no entry overlaps another or falls out of bounds", extentProblem === "", extentProblem)

// 2. The archive must contain what we patch.
const files = leaves(header)
const html = files.find((entry) => entry.path === HTML_ENTRY)
check("index.html is present", Boolean(html))
check("renderer directory is present", files.some((entry) => entry.path.startsWith("/out/renderer/")))

if (html) {
  const offset = Number(html.node.offset)
  const current = blob.subarray(offset, offset + Number(html.node.size)).toString("utf8")
  const patched = current.includes(MARKER)
  console.log(`      archive state: ${patched ? "already patched" : "pristine"}`)

  if (patched) {
    const base = unpatchHtml(current)
    const basePatched = patchHtml(base)
    check("removing the block yields a shorter base form", base.length < current.length, `${current.length} -> ${base.length} bytes`)
    check("the base form has no marker", !base.includes(MARKER))
    // These must hold no matter which build of the plugin wrote what is
    // installed: a re-install replaces the block rather than depending on it.
    check("patching the base form is idempotent", patchHtml(basePatched) === basePatched)
    check("patching the base form is reversible", unpatchHtml(basePatched) === base)
    check("re-patching replaces the installed block", patchHtml(current) === basePatched)
    check("the block accounts for exactly two scripts", countScripts(basePatched) === countScripts(base) + 2)
    check("the base form still loads the app", base.includes("assets/main-"))
    check("capture runs before the app's module", basePatched.indexOf("__swarmNet") < basePatched.indexOf("assets/main-"))
    check("keeps </head>", basePatched.includes("</head>"))
  } else {
    const once = patchHtml(current)
    check("html patch is idempotent", patchHtml(once) === once)
    check("html patch is reversible", unpatchHtml(once) === current)
    check("html patch adds two scripts", countScripts(once) === countScripts(current) + 2)
    check("patch is placed before the app's module", once.indexOf(MARKER) < once.indexOf("assets/main-"))
    check("network capture is inline", once.includes("__swarmNet"))
    check("html patch keeps </head>", once.includes("</head>"))
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed — do not install.`)
process.exitCode = failures === 0 ? 0 : 1
