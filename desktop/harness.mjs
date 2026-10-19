#!/usr/bin/env node
/**
 * Dashboard harness — run the panel without touching the app.
 *
 * The desktop panel normally needs a patched `app.asar` and a restart, which is
 * a slow loop to develop in. This serves the *real* panel file and the *real*
 * network-capture snippet on a throwaway origin, and proxies `/api/*` to the
 * running OpenCode server with its credentials attached. Because the page and
 * the proxy share an origin, the browser rules that would otherwise block a
 * local page from reaching the server do not apply, so what you see is what the
 * desktop app will do.
 *
 *   node harness.mjs                      # http://127.0.0.1:8799/
 *   node harness.mjs --port 8801
 *   node harness.mjs --directory "C:/path/to/project"
 *   node harness.mjs --upstream http://127.0.0.1:49374
 *
 * The upstream defaults to the most recent `127.0.0.1:<port>` in OpenCode's log,
 * which is where the server records where it is listening.
 */

import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const { NET_CAPTURE } = await import(pathToFileURL(path.join(here, "install.mjs")).href)

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

const project = path.resolve(arg("--directory", path.resolve(here, "../../../..")))
const port = Number(arg("--port", 8799))

const configDir = path.join(os.homedir(), ".config", "opencode")
const password = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, "service.json"), "utf8")).password ?? ""
  } catch {
    return ""
  }
})()

function discoverUpstream() {
  const explicit = arg("--upstream")
  if (explicit) return explicit
  try {
    const log = fs.readFileSync(path.join(os.homedir(), ".local", "share", "opencode", "log", "opencode.log"), "utf8")
    const found = [...log.matchAll(/127\.0\.0\.1:(\d{4,5})/g)]
    if (found.length) return `http://127.0.0.1:${found[found.length - 1][1]}`
  } catch {
    /* fall through */
  }
  return "http://127.0.0.1:4096"
}

const upstream = discoverUpstream()
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
const panelPath = path.join(here, "quorum-panel.js")

const html = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>quorum harness</title>
<style>body{margin:0;font:13px system-ui;background:#0d0d0d;color:#eee}#fake{padding:40px}</style>
</head><body>
<div id="fake"><h1>Pretend OpenCode app</h1><p id="status">booting…</p></div>
<script>${NET_CAPTURE}</script>
<script>
  // Stand in for the app's own API traffic so the capture has something to read.
  fetch("/api/info").then(function (r) { return r.json() }).then(function (j) {
    document.getElementById("status").textContent = "app connected to " + ((j.urls && j.urls[0]) || "?") + " (v" + j.version + ")";
  }).catch(function (e) { document.getElementById("status").textContent = "app error: " + e.message });
</script>
<script type="module" src="/quorum-panel.js"></script>
</body></html>`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    res.end(html())
    return
  }
  if (url.pathname === "/quorum-panel.js") {
    // Read per request so edits are picked up on a page refresh.
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
    res.end(fs.readFileSync(panelPath, "utf8"))
    return
  }

  try {
    const headers = { ...req.headers }
    delete headers.host
    delete headers["content-length"]
    headers.authorization = auth
    headers["x-opencode-directory"] = encodeURIComponent(project)
    const body = await new Promise((resolve) => {
      const chunks = []
      req.on("data", (chunk) => chunks.push(chunk))
      req.on("end", () => resolve(Buffer.concat(chunks)))
    })
    const response = await fetch(upstream + url.pathname + url.search, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
    })
    const out = Buffer.from(await response.arrayBuffer())
    const passthrough = {}
    response.headers.forEach((value, key) => {
      if (["content-encoding", "content-length", "transfer-encoding"].includes(key)) return
      passthrough[key] = value
    })
    res.writeHead(response.status, passthrough)
    res.end(out)
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: String(error) }))
  }
})

server.listen(port, "127.0.0.1", () => {
  console.log(`quorum dashboard harness: http://127.0.0.1:${port}/`)
  console.log(`  panel     ${panelPath}`)
  console.log(`  upstream  ${upstream}`)
  console.log(`  directory ${project}`)
  if (!password) console.log("  warning: no password in ~/.config/opencode/service.json — requests will be rejected")
})
