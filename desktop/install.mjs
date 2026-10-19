#!/usr/bin/env node
/**
 * Swarm dashboard installer for the OpenCode desktop app.
 *
 * The desktop app is an Electron bundle whose window is loaded from
 * `resources/app.asar`. This script adds one file to that archive and appends a
 * single `<script>` tag to `out/renderer/index.html`, which is how the swarm
 * panel gets into the real app window.
 *
 * Safety
 * ------
 * - The original archive is copied to `app.asar.swarm-backup` before the first
 *   write, and `--uninstall` restores it byte for byte.
 * - `--dry-run` reports exactly what would change without touching anything.
 * - The archive is written to a temporary file and renamed into place, so an
 *   interrupted run cannot leave a half-written archive.
 * - Embedded ASAR integrity validation is disabled in this build, so a modified
 *   archive still loads. (Check with `--fuse` if you are unsure.)
 *
 * Usage:
 *   node install.mjs                 # install or update the panel
 *   node install.mjs --dry-run       # show what would change
 *   node install.mjs --uninstall     # restore the original archive
 *   node install.mjs --asar <path>   # target a specific app.asar
 *   node install.mjs --fuse          # report the Electron fuse state
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MARKER_START = "<!-- swarm-dashboard -->"
const MARKER_END = "<!-- /swarm-dashboard -->"
const PANEL_ENTRY = "/out/renderer/swarm-panel.js"
const HTML_ENTRY = "/out/renderer/index.html"

/**
 * Installed as a classic inline script placed *before* the app's own module, so
 * it wraps `fetch`/`XMLHttpRequest` before anything can capture the originals.
 * It records the server origin and auth headers off the app's own API traffic,
 * which is how the panel learns how to talk to the server.
 */
const NET_CAPTURE = `(function(){
if(window.__swarmNet)return;
var net={origin:null,headers:{},listeners:[],ready:false};
window.__swarmNet=net;
function notify(){net.ready=!!net.origin;for(var i=0;i<net.listeners.length;i++){try{net.listeners[i]()}catch(e){}}}
function isApi(u){return typeof u==="string"&&u.indexOf("/api/")!==-1}
function remember(u,h){
  if(!isApi(u))return;
  try{var p=new URL(u,location.href);if(p.origin&&p.origin!=="null")net.origin=p.origin}catch(e){return}
  if(h){try{
    var accept=function(v,k){if(/^(authorization|cookie|x-|proxy-authorization)/i.test(k))net.headers[k]=v};
    if(typeof Headers==="function")new Headers(h).forEach(accept);
    else if(h.forEach)h.forEach(accept);
    else for(var k in h)if(Object.prototype.hasOwnProperty.call(h,k))accept(h[k],k);
  }catch(e){}}
  notify();
}
net.remember=remember;
/** Any absolute http(s) URL the app touches reveals the server's address. */
function rememberAbsolute(u){
  try{
    var url=new URL(u,location.href);
    if(url.protocol==="http:"||url.protocol==="https:"){
      if(net.origin!==url.origin){net.origin=url.origin;}
      notify();
    }
  }catch(e){}
}
net.rememberAbsolute=rememberAbsolute;
var of=window.fetch;
if(of)window.fetch=function(input,init){
  try{remember(typeof input==="string"?input:(input&&input.url),(init&&init.headers)||(input&&input.headers))}catch(e){}
  return of.apply(this,arguments);
};
try{
  var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open=function(m,u){this.__swarmUrl=u;try{rememberAbsolute(String(u))}catch(e){};return xo.apply(this,arguments)};
  XMLHttpRequest.prototype.setRequestHeader=function(n,v){
    try{if(this.__swarmUrl&&isApi(String(this.__swarmUrl)))remember(String(this.__swarmUrl),{[n]:v})}catch(e){}
    return xs.apply(this,arguments);
  };
}catch(e){}
// Streaming transports are not subject to CORS and often reveal the address even
// when nothing uses fetch directly.
try{
  var WS=window.WebSocket;
  if(WS){window.WebSocket=function(u,p){try{rememberAbsolute(String(u))}catch(e){};return p===undefined?new WS(u):new WS(u,p)};window.WebSocket.prototype=WS.prototype;}
}catch(e){}
try{
  var ES=window.EventSource;
  if(ES){window.EventSource=function(u,c){try{rememberAbsolute(String(u))}catch(e){};return c===undefined?new ES(u):new ES(u,c)};window.EventSource.prototype=ES.prototype;}
}catch(e){}
})();`

const here = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Archive format
// ---------------------------------------------------------------------------

/**
 * An asar archive is: a small pickle prologue, the JSON header, then the file
 * data. Offsets in the header are relative to the start of that data section.
 *
 * The header JSON is padded to a 4-byte boundary (Chromium pickle alignment), so
 * the data section starts after the *padded* length, not the raw one. Getting
 * that wrong shifts every entry, and writing it wrong produces an archive the
 * app refuses to open.
 */
const align4 = (value) => Math.ceil(value / 4) * 4

function readAsar(file) {
  const fd = fs.openSync(file, "r")
  try {
    const prologue = Buffer.alloc(16)
    fs.readSync(fd, prologue, 0, 16, 0)
    const jsonLength = prologue.readUInt32LE(12)
    const json = Buffer.alloc(jsonLength)
    fs.readSync(fd, json, 0, jsonLength, 16)
    const header = JSON.parse(json.toString("utf8"))
    const dataStart = 16 + align4(jsonLength)
    const size = fs.fstatSync(fd).size
    const blob = Buffer.alloc(Math.max(0, size - dataStart))
    if (blob.length) fs.readSync(fd, blob, 0, blob.length, dataStart)
    return { header, blob, dataStart, jsonLength, json: json.toString("utf8") }
  } finally {
    fs.closeSync(fd)
  }
}

/** Every file (not directory, not symlink) in the header, in archive order. */
function leaves(header) {
  const out = []
  const walk = (node, prefix) => {
    for (const key of Object.keys(node.files ?? {})) {
      const child = node.files[key]
      const full = `${prefix}/${key}`
      if (child.files) walk(child, full)
      else out.push({ node: child, path: full })
    }
  }
  walk(header, "")
  return out
}

/**
 * Writes a header + data section back as an archive.
 *
 * The prologue mirrors what the app itself writes: a 4 (the size of the first
 * pickle field), the padded payload size + 8, the padded payload size + 4, then
 * the real JSON length. Padding the JSON to four bytes is not cosmetic —
 * Chromium's pickle requires it, and an unaligned payload makes the app refuse
 * the whole archive.
 */
function serialize(header, blob) {
  const raw = Buffer.from(JSON.stringify(header), "utf8")
  const padded = align4(raw.length)
  const json = padded === raw.length ? raw : Buffer.concat([raw, Buffer.alloc(padded - raw.length)])

  const prologue = Buffer.alloc(16)
  prologue.writeUInt32LE(4, 0)
  prologue.writeUInt32LE(padded + 8, 4)
  prologue.writeUInt32LE(padded + 4, 8)
  prologue.writeUInt32LE(raw.length, 12)
  return Buffer.concat([prologue, json, blob])
}

/** Finds a file node, without creating anything. */
function fileNode(header, target) {
  let node = header
  for (const key of target.split("/").filter(Boolean)) {
    node = node?.files?.[key]
    if (!node) return undefined
  }
  return node
}

/**
 * Applies a patch by APPENDING to the archive and repointing only the entries
 * that changed.
 *
 * Every existing entry keeps its recorded offset and size exactly as it was, and
 * the original data section is preserved byte for byte as a prefix: the new and
 * rewritten files are written after it. A previous version of this installer
 * instead re-packed the archive, recomputing every offset — and an app update
 * afterwards failed to start, because an archive's recorded boundaries are not
 * always a perfect tiling (this build left bytes no entry claimed), so packing
 * it tightly moved data that the app still read. Appending cannot move
 * anything, so it is safe on any archive shape.
 */
function patchArchive(header, blob, { replaced, added }) {
  const parts = []
  let cursor = blob.length
  const repoint = (target, data) => {
    const node = fileNode(header, target) ?? ensureFileNode(header, target)
    node.offset = String(cursor)
    node.size = data.length
    parts.push(data)
    cursor += data.length
  }
  for (const [target, data] of added) repoint(target, data)
  for (const [target, data] of replaced) repoint(target, data)
  return serialize(header, Buffer.concat([blob, ...parts]))
}

function ensureFileNode(header, target) {
  const segments = target.split("/").filter(Boolean)
  let node = header
  for (let index = 0; index < segments.length - 1; index++) {
    const key = segments[index]
    if (!node.files) node.files = {}
    if (!node.files[key]) node.files[key] = { files: {} }
    node = node.files[key]
    if (!node.files) {
      throw new Error(`cannot add ${target}: ${key} is a file, not a directory`)
    }
  }
  const name = segments[segments.length - 1]
  node.files[name] = { size: 0, offset: "0" }
  return node.files[name]
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

function patchHtml(html) {
  // The marker block carries no surrounding whitespace so that removing it
  // restores the byte-exact original. It is placed before the app's own module
  // script so the network capture is installed first.
  const block = `${MARKER_START}<script>${NET_CAPTURE}</script><script type="module" src="./swarm-panel.js"></script>${MARKER_END}`
  const start = html.indexOf(MARKER_START)
  if (start !== -1) {
    const end = html.indexOf(MARKER_END)
    if (end === -1) throw new Error("index.html has a broken swarm marker block")
    return html.slice(0, start) + block + html.slice(end + MARKER_END.length)
  }
  const moduleTag = html.indexOf('<script type="module"')
  if (moduleTag !== -1) return `${html.slice(0, moduleTag)}${block}${html.slice(moduleTag)}`
  const head = html.lastIndexOf("</head>")
  if (head === -1) throw new Error("could not find </head> in index.html")
  return `${html.slice(0, head)}${block}${html.slice(head)}`
}

function unpatchHtml(html) {
  const start = html.indexOf(MARKER_START)
  if (start === -1) return html
  const end = html.indexOf(MARKER_END)
  if (end === -1) return html
  return html.slice(0, start) + html.slice(end + MARKER_END.length)
}

function findAsar(input) {
  if (input) return input
  const candidates = []
  const local = process.env.LOCALAPPDATA
  if (local) {
    const programs = path.join(local, "Programs")
    if (fs.existsSync(programs)) {
      for (const entry of fs.readdirSync(programs)) {
        if (!/opencode/i.test(entry)) continue
        candidates.push(path.join(programs, entry, "resources", "app.asar"))
      }
    }
    candidates.push(path.join(local, "opencode", "resources", "app.asar"))
  }
  if (process.platform === "darwin") candidates.push("/Applications/OpenCode.app/Contents/Resources/app.asar")
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  throw new Error("could not find app.asar — pass one with --asar <path>")
}

/** Reports the Electron fuse that decides whether a patched archive is allowed. */
function fuseReport(asarPath) {
  const exe = path.join(path.dirname(path.dirname(asarPath)), "OpenCode.exe")
  if (!fs.existsSync(exe)) return "(executable not found next to app.asar; skipping fuse check)"
  const needle = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX")
  const fd = fs.openSync(exe, "r")
  try {
    const chunk = 8 * 1024 * 1024
    const size = fs.fstatSync(fd).size
    let carry = Buffer.alloc(0)
    let position = 0
    while (position < size) {
      const length = Math.min(chunk, size - position)
      const buffer = Buffer.allocUnsafe(length)
      fs.readSync(fd, buffer, 0, length, position)
      const haystack = Buffer.concat([carry, buffer])
      const found = haystack.indexOf(needle)
      if (found !== -1) {
        const base = position - carry.length + found + needle.length
        const head = Buffer.alloc(16)
        fs.readSync(fd, head, 0, 16, base)
        const count = head[1]
        const names = [
          "RunAsNode",
          "EnableCookieEncryption",
          "EnableNodeOptionsEnvironmentVariable",
          "EnableNodeCliInspectArguments",
          "EnableEmbeddedAsarIntegrityValidation",
          "OnlyLoadAppFromAsar",
        ]
        const lines = []
        for (let index = 0; index < count; index++) {
          const value = head[2 + index]
          const state = value === 0x31 ? "ENABLED" : value === 0x30 ? "disabled" : `0x${value.toString(16)}`
          lines.push(`  ${names[index] ?? `fuse${index}`}: ${state}`)
        }
        return lines.join("\n")
      }
      carry = buffer.subarray(Math.max(0, buffer.length - 64))
      position += length
    }
    return "  (fuse wire not found)"
  } finally {
    fs.closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)
  const flag = (name) => args.includes(name)
  const value = (name) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }

  const asar = findAsar(value("--asar"))
  const backup = `${asar}.swarm-backup`

  console.log(`swarm dashboard installer`)
  console.log(`  archive: ${asar}`)

  if (flag("--fuse")) {
    console.log("Electron fuses:")
    console.log(fuseReport(asar))
    if (!flag("--uninstall")) return
  }

  if (flag("--uninstall")) {
    if (!fs.existsSync(backup)) {
      console.error("No backup found; nothing to restore.")
      process.exitCode = 1
      return
    }
    if (flag("--dry-run")) {
      console.log(`would restore ${backup} -> ${asar}`)
      return
    }
    fs.copyFileSync(backup, asar)
    console.log(`restored the original archive from ${backup}`)
    console.log("Restart OpenCode to finish.")
    return
  }

  const panelSource = path.join(here, "swarm-panel.js")
  if (!fs.existsSync(panelSource)) throw new Error(`missing panel source: ${panelSource}`)
  const panel = fs.readFileSync(panelSource)

  const archive = readAsar(asar)
  const existing = leaves(archive.header)
  const html = existing.find((entry) => entry.path === HTML_ENTRY)
  if (!html) throw new Error("could not find out/renderer/index.html in the archive")

  const offset = Number(html.node.offset)
  const originalHtml = archive.blob.subarray(offset, offset + Number(html.node.size)).toString("utf8")
  const patchedHtml = Buffer.from(patchHtml(originalHtml), "utf8")

  // Snapshot what every existing entry looks like *before* touching anything, so
  // the install can prove afterwards that none of them moved.
  const beforeSignatures = new Map(
    leaves(archive.header).map((entry) => [entry.path, `${entry.node.offset}:${entry.node.size}`]),
  )

  const added = new Map()
  const replaced = new Map([[HTML_ENTRY, patchedHtml]])
  if (existing.some((entry) => entry.path === PANEL_ENTRY)) replaced.set(PANEL_ENTRY, panel)
  else added.set(PANEL_ENTRY, panel)

  // The backup must hold the *pristine* archive, so that --uninstall and
  // verify.mjs are meaningful. An app update replaces the archive (and deletes
  // the backup with it), so refresh it whenever the current archive is
  // unpatched and differs from what the backup holds.
  const alreadyPatched = originalHtml.includes(MARKER_START)
  const needsBackup =
    !fs.existsSync(backup) || (!alreadyPatched && !fs.readFileSync(backup).equals(fs.readFileSync(asar)))

  console.log(`  panel:   ${PANEL_ENTRY} (${panel.length} bytes)`)
  console.log(`  html:    ${HTML_ENTRY} ${originalHtml.length} -> ${patchedHtml.length} bytes`)
  console.log(`  backup:  ${backup}${fs.existsSync(backup) ? "" : " (not present — will be created)"}`)

  if (flag("--dry-run")) {
    if (needsBackup) console.log("          (would refresh the backup to the current original archive)")
    console.log("dry run: nothing written.")
    return
  }

  if (needsBackup) {
    fs.copyFileSync(asar, backup)
    console.log("  backed up the current original archive")
  }

  const output = patchArchive(archive.header, archive.blob, { replaced, added })
  const temporary = `${asar}.swarm-tmp`
  try {
    fs.writeFileSync(temporary, output)
    fs.renameSync(temporary, asar)
  } catch (error) {
    // Never leave a half-written archive or a stray temp file behind.
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      /* ignore */
    }
    const code = error && typeof error === "object" ? error.code : undefined
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new Error(
        "the archive is locked because OpenCode is running. Quit OpenCode completely, then run this again.",
      )
    }
    throw error
  }

  // Verify by reading the archive back.
  const check = readAsar(asar)
  const checkHtml = leaves(check.header).find((entry) => entry.path === HTML_ENTRY)
  const checkPanel = leaves(check.header).find((entry) => entry.path === PANEL_ENTRY)
  if (!checkHtml || !checkPanel) throw new Error("verification failed: patched entries are missing")
  const htmlBack = check.blob
    .subarray(Number(checkHtml.node.offset), Number(checkHtml.node.offset) + Number(checkHtml.node.size))
    .toString("utf8")
  if (!htmlBack.includes(MARKER_START)) throw new Error("verification failed: marker missing from index.html")
  if (!check.blob.subarray(Number(checkPanel.node.offset), Number(checkPanel.node.offset) + Number(checkPanel.node.size)).includes(Buffer.from("Swarm dashboard"))) {
    throw new Error("verification failed: panel content looks wrong")
  }

  // The whole point of appending: every pre-existing entry must be exactly where
  // it was. If any moved, the archive is not safe for the app to read.
  const moved = []
  for (const entry of leaves(check.header)) {
    if (entry.path === HTML_ENTRY || entry.path === PANEL_ENTRY) continue
    const before = beforeSignatures.get(entry.path)
    if (before !== `${entry.node.offset}:${entry.node.size}`) moved.push(entry.path)
  }
  if (moved.length) {
    throw new Error(`verification failed: ${moved.length} existing entr(ies) moved, e.g. ${moved[0]}`)
  }

  console.log(`\ninstalled (${output.length} bytes).`)
  console.log("Every pre-existing file kept its original offset, size and bytes; the panel and the")
  console.log("patched index.html were appended at the end.")
  console.log("Restart OpenCode: Swarm appears in the title bar (beside Home / New session)")
  console.log("and in the sidebar above Settings.")
  console.log(`If OpenCode does not start, restore the untouched archive with:`)
  console.log(`  node "${path.join(here, "install.mjs")}" --uninstall`)
}

export { readAsar, serialize, patchArchive, leaves, fileNode, patchHtml, unpatchHtml, findAsar, fuseReport, NET_CAPTURE }

function isMain() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
}

if (isMain()) {
  try {
    main()
  } catch (error) {
    console.error(`\ninstaller failed: ${error instanceof Error ? error.message : error}`)
    if (error && error.code === "EBUSY") {
      console.error("The archive is in use. Quit OpenCode completely, then run this again.")
    }
    process.exitCode = 1
  }
}
