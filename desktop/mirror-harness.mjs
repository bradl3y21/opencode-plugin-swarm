/**
 * Mirror harness — the real desktop UI, in a browser, for development.
 *
 * `--from-asar` (the default) serves the *installed app's own* renderer files
 * straight out of `app.asar`, and proxies `/api/*` to the running service with
 * credentials attached. That makes the browser show exactly what the desktop
 * window will show, for whatever version is installed — which is what you want
 * when verifying UI integration after an app update.
 *
 * Without `--from-asar` it proxies the web UI the server itself serves.
 *
 * In both cases the same `index.html` patch the installer applies is applied
 * here, so the panel loads exactly as it will in the app.
 *
 *   node mirror-harness.mjs [--port 8799] [--upstream http://127.0.0.1:PORT]
 */

import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const installer = await import(pathToFileURL(path.join(here, "install.mjs")).href)
const { NET_CAPTURE, patchHtml, readAsar, leaves, findAsar } = installer

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}
const PORT = Number(arg("--port", 8799))
const fromAsar = !process.argv.includes("--no-asar")

/** The desktop app logs the authoritative service URL; the shared log can be stale. */
function discoverUpstream() {
  const explicit = arg("--upstream")
  if (explicit) return explicit
  const logs = path.join(os.homedir(), "AppData", "Roaming", "ai.opencode.desktop", "logs")
  try {
    const dirs = fs.readdirSync(logs).sort()
    for (let i = dirs.length - 1; i >= 0; i--) {
      const file = path.join(logs, dirs[i], "main.log")
      if (!fs.existsSync(file)) continue
      const hits = [...fs.readFileSync(file, "utf8").matchAll(/url:\s*'(http:\/\/127\.0\.0\.1:\d+)/g)]
      if (hits.length) return hits[hits.length - 1][1]
    }
  } catch {
    /* fall through */
  }
  try {
    const log = fs.readFileSync(path.join(os.homedir(), ".local", "share", "opencode", "log", "opencode.log"), "utf8")
    const hits = [...log.matchAll(/127\.0\.0\.1:(\d{4,5})/g)]
    if (hits.length) return `http://127.0.0.1:${hits[hits.length - 1][1]}`
  } catch {
    /* fall through */
  }
  return "http://127.0.0.1:4096"
}

const service = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "opencode", "service.json"), "utf8"))
const auth = "Basic " + Buffer.from(`opencode:${service.password}`).toString("base64")
const UPSTREAM = discoverUpstream()
/** The project directory the harness reports; defaults to where it was started. */
const DIRECTORY = (arg("--directory") ?? process.cwd()).replace(/\\/g, "/")

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".aac": "audio/aac",
  ".mp3": "audio/mpeg",
  ".txt": "text/plain; charset=utf-8",
}
const typeFor = (name) => TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream"

// Read the installed renderer once; it does not change while this runs.
let archive
if (fromAsar) {
  archive = readAsar(findAsar())
  archive.index = new Map(leaves(archive.header).map((entry) => [entry.path, entry]))
}
function readRendererFile(urlPath) {
  if (!archive) return null
  const rel = urlPath === "/" ? "/out/renderer/index.html" : `/out/renderer${urlPath}`
  const entry = archive.index.get(rel)
  if (!entry || entry.node.unpacked) return null
  const start = Number(entry.node.offset)
  let body = archive.blob.subarray(start, start + Number(entry.node.size))

  // This app build records some entry boundaries one byte off, leaving a stray
  // `}` at the head of a JS file and its real last byte one past the recorded
  // end (verified empirically: [start+1, start+1+size) parses, [start, start+size)
  // does not). Neither file type can legitimately begin with `}`, so shift the
  // window by one byte. A dev-harness concern only: the installer copies bytes
  // verbatim and never depends on entry boundaries being semantically aligned.
  if ((rel.endsWith(".js") || rel.endsWith(".mjs") || rel.endsWith(".css")) && body.length > 1 && body[0] === 0x7d) {
    body = archive.blob.subarray(start + 1, start + 1 + Number(entry.node.size))
  }
  return { name: rel, body }
}

const SKIP = new Set(["content-encoding", "content-length", "transfer-encoding", "content-security-policy", "x-frame-options"])

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (url.pathname === "/quorum-panel.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
    return res.end(fs.readFileSync(path.join(here, "quorum-panel.js"), "utf8"))
  }

  // The desktop renderer, served verbatim from app.asar.
  const file = readRendererFile(url.pathname)
  if (file) {
    const isHtml = file.name.endsWith(".html")
    const body = isHtml ? Buffer.from(patchHtml(file.body.toString("utf8")), "utf8") : file.body
    res.writeHead(200, { "content-type": typeFor(file.name), "cache-control": "no-store", "content-length": body.length })
    return res.end(body)
  }

  try {
    const headers = { ...req.headers }
    delete headers.host
    delete headers["content-length"]
    delete headers["accept-encoding"]
    // Drop conditional-request headers: a 304 would make the browser reuse a
    // previously cached (unpatched) document.
    delete headers["if-none-match"]
    delete headers["if-modified-since"]
    delete headers["if-range"]
    headers.authorization = auth
    headers["x-opencode-directory"] = encodeURIComponent(DIRECTORY)
    const body = await new Promise((resolve) => {
      const chunks = []
      req.on("data", (chunk) => chunks.push(chunk))
      req.on("end", () => resolve(Buffer.concat(chunks)))
    })
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      redirect: "manual",
    })
    const out = {}
    upstream.headers.forEach((value, key) => {
      if (!SKIP.has(key)) out[key] = value
    })
    const contentType = upstream.headers.get("content-type") ?? ""
    let payload = Buffer.from(await upstream.arrayBuffer())
    // Apply the same patch the installer applies, so the panel loads for real.
    if (contentType.includes("text/html")) {
      payload = Buffer.from(patchHtml(payload.toString("utf8")), "utf8")
      delete out["content-length"]
    }
    // Never let the browser reuse a previously unpatched document.
    out["cache-control"] = "no-store"
    delete out["etag"]
    delete out["last-modified"]
    res.writeHead(upstream.status, out)
    res.end(payload)
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain" })
    res.end(`mirror error: ${error}`)
  }
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mirror harness: http://127.0.0.1:${PORT}/`)
  console.log(`  renderer  ${fromAsar ? "from app.asar (exactly the installed desktop UI)" : "proxied from the server"}`)
  console.log(`  upstream  ${UPSTREAM}`)
})
