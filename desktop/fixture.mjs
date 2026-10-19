/**
 * A minimal, valid `app.asar`, for machines without the desktop app.
 *
 * The installer and the self-test are only meaningful against a real archive, so
 * they use the installed app when there is one. Contributors and CI have no app
 * to point at, and an untestable installer is worse than a smaller test: this
 * builds an archive with the same shape (a header, a data section, an entry that
 * is not four-byte aligned) so the invariants can still be checked anywhere.
 *
 *   node fixture.mjs [--out <path>]
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { findAsar, serialize } from "./install.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))

/** The renderer files the panel patch expects to find. */
export const FIXTURE_FILES = [
  {
    path: "/out/renderer/index.html",
    body:
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>OpenCode</title>" +
      "<link rel=\"stylesheet\" href=\"./assets/index-fixture.css\">" +
      "<script type=\"module\" crossorigin src=\"./assets/main-fixture.js\"></script>" +
      "</head><body><div id=\"root\"></div></body></html>",
  },
  { path: "/out/renderer/app.js", body: "console.log('fixture app')" },
  { path: "/package.json", body: '{"name":"opencode-fixture","version":"0.0.0"}' },
]

/** Builds an archive whose first data entry is deliberately unaligned. */
export function buildFixture(target) {
  const header = { files: {} }
  const chunks = [Buffer.from([0x21])] // one byte no entry claims, as this app leaves
  let cursor = chunks[0].length

  for (const file of FIXTURE_FILES) {
    const data = Buffer.from(file.body, "utf8")
    const segments = file.path.split("/").filter(Boolean)
    let node = header
    for (const key of segments.slice(0, -1)) {
      node.files[key] ??= { files: {} }
      node = node.files[key]
    }
    node.files[segments[segments.length - 1]] = { size: data.length, offset: String(cursor) }
    chunks.push(data)
    cursor += data.length
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, serialize(header, Buffer.concat(chunks)))
  return target
}

/** The archive to test against: the installed app, else a fixture. */
export function resolveArchive(explicit) {
  if (explicit) return explicit
  try {
    return findAsar()
  } catch {
    const target = path.join(os.tmpdir(), "quorum-fixture", "app.asar")
    return buildFixture(target)
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invoked) {
  const index = process.argv.indexOf("--out")
  const out = index === -1 ? path.join(here, "fixture.asar") : process.argv[index + 1]
  buildFixture(out)
  console.log(`fixture archive written to ${out}`)
}
