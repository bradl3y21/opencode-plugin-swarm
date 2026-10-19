/**
 * Quorum dashboard — the panel injected into the OpenCode desktop window.
 *
 * This file is loaded as a module by `out/renderer/index.html` after a minimal
 * patch. It is deliberately dependency-free: it runs in the app's renderer
 * process alongside the real UI, so it must not assume any framework, and it
 * must never throw in a way that could disturb the host app.
 *
 * How it reaches the server
 * -------------------------
 * The renderer is served from a custom `oc://` protocol and the OpenCode server
 * listens on a random localhost port with a password, so we do not know either
 * up front. Instead we wrap `fetch`/`XMLHttpRequest` and read the origin and
 * auth headers off the app's own API traffic — the same connection the app
 * already uses. That is version-proof and needs no configuration.
 */

;(function installQuorumPanel() {
  if (window.__quorumPanel) return
  window.__quorumPanel = { version: "1.1.0" }

  // -------------------------------------------------------------------------
  // Discover the server by observing the app's own requests
  //
  // The installer also injects an inline capture script that runs before the
  // app's module, so normally this is already done. The fallback below keeps
  // the panel working if that script was not installed for any reason.
  // -------------------------------------------------------------------------

  function installCapture() {
    const net = { origin: null, headers: {}, listeners: [], ready: false, remember: undefined }
    window.__quorumNet = net

    const notify = () => {
      net.ready = Boolean(net.origin)
      for (const listener of net.listeners) {
        try {
          listener()
        } catch {
          /* ignore */
        }
      }
    }

    const authHeader = /^(authorization|cookie|x-|proxy-authorization)/i
    const looksLikeApi = (url) => typeof url === "string" && url.includes("/api/")

    net.remember = (url, headers) => {
      if (!looksLikeApi(url)) return
      try {
        const parsed = new URL(url, window.location.href)
        if (parsed.origin && parsed.origin !== "null") net.origin = parsed.origin
      } catch {
        return
      }
      if (headers) {
        try {
          const accept = (value, key) => {
            if (authHeader.test(key)) net.headers[key] = value
          }
          if (typeof Headers === "function") new Headers(headers).forEach(accept)
          else if (headers.forEach) headers.forEach(accept)
          else for (const key of Object.keys(headers)) accept(headers[key], key)
        } catch {
          /* ignore */
        }
      }
      notify()
    }

    const realFetch = window.fetch
    if (realFetch) {
      window.fetch = function (input, init) {
        try {
          net.remember(
            typeof input === "string" ? input : input && input.url,
            (init && init.headers) || (input && input.headers),
          )
        } catch {
          /* ignore */
        }
        return realFetch.apply(this, arguments)
      }
    }

    try {
      const open = XMLHttpRequest.prototype.open
      const setHeader = XMLHttpRequest.prototype.setRequestHeader
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__quorumUrl = url
        return open.apply(this, arguments)
      }
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try {
          if (this.__quorumUrl && looksLikeApi(String(this.__quorumUrl))) {
            net.remember(String(this.__quorumUrl), { [name]: value })
          }
        } catch {
          /* ignore */
        }
        return setHeader.apply(this, arguments)
      }
    } catch {
      /* ignore */
    }

    return net
  }

  const net = window.__quorumNet || installCapture()
  if (!Array.isArray(net.listeners)) net.listeners = []
  const restFetch = window.fetch ? window.fetch.bind(window) : undefined

  /**
   * The request shape that worked, remembered after the first success. The app
   * rewrites CORS headers, so which shape is acceptable is not knowable up
   * front — it is discovered once and then reused.
   */
  let transportName = null
  /** The URL-encoded directory sent as `x-opencode-directory`. */
  let directory = null
  /** Diagnostics only: how many request failures have been written to the log. */
  let failuresLogged = 0

  /** One line of diagnostics; console.warn is captured in OpenCode's renderer log. */
  function note(message) {
    try {
      console.warn(`[quorum] ${message}`)
    } catch {
      /* ignore */
    }
  }

  /**
   * Learns the server's address without relying on seeing the app's traffic.
   *
   * Capture usually works, but if the app's own requests never pass through
   * `window.fetch` (some transports talk to the main process instead), nothing is
   * captured and the panel would wait forever. The app stores its server list, so
   * look for a loopback URL in the window's saved state and in local storage.
   */
  let discovering = null
  async function ensureOrigin() {
    if (net.origin) return net.origin
    const absolute = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/
    const scan = (text) => {
      const found = String(text ?? "").match(absolute)
      return found ? found[0] : null
    }
    try {
      const snapshot = await Promise.resolve(window.electron?.storageSnapshot)
      const found = scan(JSON.stringify(snapshot ?? {}))
      if (found) {
        net.origin = found
        note(`server address recovered from saved state: ${found}`)
        return net.origin
      }
    } catch {
      /* ignore */
    }
    try {
      for (const key of Object.keys(window.localStorage ?? {})) {
        const found = scan(window.localStorage.getItem(key))
        if (found) {
          net.origin = found
          note(`server address recovered from local storage: ${found}`)
          return net.origin
        }
      }
    } catch {
      /* ignore */
    }
    return null
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  /**
   * The RPC registry is per location, so the server must be told which project
   * to look in — with no location it answers `rpc.unavailable`. The app puts
   * that location in a header on its own calls, but it may not have made such a
   * call yet when the panel starts, so fall back to asking the server for its
   * project list, which needs no location of its own.
   */
  /** Project directories the server knows about, most recently active first. */
  async function projectDirectories() {
    try {
      const headers = { "content-type": "application/json" }
      if (net.headers.authorization) headers.authorization = net.headers.authorization
      const response = await restFetch(`${net.origin}/api/project`, { headers })
      if (!response.ok) return []
      const parsed = JSON.parse(await response.text())
      const projects = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : []
      return projects
        .slice()
        .sort((a, b) => (Number(b?.time?.active) || 0) - (Number(a?.time?.active) || 0))
        .map((project) => project?.canonical ?? project?.directory)
        .filter((value) => typeof value === "string" && value)
        .map((value) => encodeURIComponent(value))
    } catch {
      return []
    }
  }

  /** Directories recent sessions belong to — usually the window's own project. */
  async function sessionDirectories() {
    try {
      const headers = { "content-type": "application/json" }
      if (net.headers.authorization) headers.authorization = net.headers.authorization
      const response = await restFetch(`${net.origin}/api/session`, { headers })
      if (!response.ok) return []
      const parsed = JSON.parse(await response.text())
      const sessions = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : []
      return sessions
        .map((session) => session?.location?.directory)
        .filter((value) => typeof value === "string" && value)
        .map((value) => encodeURIComponent(value))
    } catch {
      return []
    }
  }

  /** True when the quorum RPC answers for this location. */
  async function servesQuorum(value) {
    try {
      const response = await restFetch(`${net.origin}/api/rpc/quorum/state`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": value },
        body: JSON.stringify({ location: { directory: value }, input: { json: "{}" } }),
      })
      await response.text()
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Finds the location the quorum RPC answers for.
   *
   * The registry is per project, so a location where the plugin is not loaded
   * answers `rpc.unavailable`. The header the app sends is usually right, but
   * after a restart it can name the app's home project rather than the one this
   * plugin lives in, so candidates are probed — captured header first, then
   * projects by recency — and the first working one is remembered.
   */
  async function resolveDirectory(force = false) {
    if (directory && !force) return directory
    const captured = net.headers["x-opencode-directory"]
    const candidates = []
    if (captured) candidates.push(captured)
    // Recent sessions first: they name the project the window is actually on,
    // whereas the project list can put the app's home directory first after a
    // restart — and that is exactly where the plugin is not loaded.
    const found = [...(await sessionDirectories()).slice(0, 12), ...(await projectDirectories())]
    for (const candidate of found) {
      if (!candidates.includes(candidate)) candidates.push(candidate)
    }
    for (const candidate of candidates.slice(0, 8)) {
      if (await servesQuorum(candidate)) {
        directory = candidate
        note(`location: ${candidate}`)
        return directory
      }
    }
    // Nothing answered: keep the best guess so the caller surfaces the real error.
    note(`no location answered for quorum (tried ${candidates.length})`)
    directory = candidates[0] ?? null
    return directory
  }

  function requestShapes() {
    const base = { "content-type": "application/json" }
    if (directory) base["x-opencode-directory"] = directory
    const shapes = [
      { name: "json", headers: { ...base, ...net.headers } },
      { name: "json+injected-auth", headers: { ...base } },
      { name: "json+minimal", headers: { "content-type": "application/json" } },
    ]
    if (!transportName) return shapes
    // Keep whichever shape worked first, so the common path stays one request.
    return [shapes.find((shape) => shape.name === transportName) ?? shapes[0], ...shapes.filter((shape) => shape.name !== transportName)]
  }

  async function rpc(method, body = {}) {
    if (!net.origin) await ensureOrigin()
    if (!net.origin) throw new Error("Looking for the OpenCode server… open or refresh a session and this will connect.")
    const url = `${net.origin}/api/rpc/quorum/${method}`
    const payload = JSON.stringify({ input: { json: JSON.stringify(body) } })
    await resolveDirectory()

    // Credentials are deliberately NOT sent: the app's main process rewrites
    // Access-Control-Allow-Origin to `*`, which the browser rejects outright for
    // a credentialed request, and it injects Authorization for loopback calls.
    let failure
    for (let pass = 0; pass < 2; pass++) {
      const attempts = []
      for (const shape of requestShapes()) {
        try {
          const response = await restFetch(url, { method: "POST", headers: shape.headers, body: payload })
          const text = await response.text()
          if (response.status === 401) throw new Error("authentication required for this request")
          if (!response.ok) {
            let message = `HTTP ${response.status}`
            try {
              const parsed = JSON.parse(text)
              message = parsed?.error?.message || parsed?.data?.message || parsed?.message || message
            } catch {
              /* keep the status text */
            }
            throw new Error(String(message))
          }
          transportName = shape.name
          state.transport = shape.name
          const parsed = JSON.parse(text)
          const envelope = parsed?.data ?? parsed?.output ?? parsed
          const raw = envelope?.json ?? envelope?.data?.json
          return typeof raw === "string" ? JSON.parse(raw) : envelope
        } catch (error) {
          // Every shape is tried before giving up: which shape the app accepts
          // cannot be predicted, and one wasted request is cheaper than a panel
          // that does not work.
          attempts.push(`${shape.name}: ${error && error.message ? error.message : String(error)}`)
          if (!failure) failure = error
        }
      }
      state.transportAttempts = attempts
      // A location that turned out to be wrong is worth one fresh discovery.
      // This is the common case after an app restart: the first header captured
      // can name a project the plugin is not loaded in.
      if (pass === 0 && /unavailable|not found|unknown location/i.test(String(failure?.message))) {
        await resolveDirectory(true)
        continue
      }
      break
    }
    throw failure ?? new Error("no usable transport")
  }

  // -------------------------------------------------------------------------
  // Styles (uses the app's own theme tokens, with fallbacks)
  // -------------------------------------------------------------------------

  const CSS = `
  .q-root { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
  .q-root * { box-sizing: border-box; }
  .q-launch {
    position: absolute; right: 18px; bottom: 18px; pointer-events: auto;
    display: flex; align-items: center; gap: 8px;
    padding: 9px 14px 9px 11px; border-radius: 999px; cursor: pointer;
    background: var(--surface-raised-strong, #1c1c1c);
    color: var(--text-base, #fafafa);
    border: 1px solid var(--border-base, #333);
    box-shadow: var(--shadow-lg, 0 8px 30px rgba(0,0,0,.35));
    font-family: var(--font-family-sans, system-ui, sans-serif);
    font-size: 12px; font-weight: 600; letter-spacing: .01em; user-select: none;
    transition: transform .12s ease, background .12s ease;
  }
  .q-launch:hover { transform: translateY(-1px); background: var(--surface-raised-strong-hover, #262626); }
  .q-launch .q-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--icon-weak-base, #666); }
  .q-launch[data-active="true"] .q-dot { background: var(--icon-success-base, #46a758); }
  .q-launch[data-busy="true"] .q-dot { background: var(--icon-warning-base, #f5a623); animation: q-pulse 1s ease-in-out infinite; }
  @keyframes q-pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }

  .q-panel {
    /* Never cover the window's own title bar: the traffic-light / close buttons
       live there and are drawn above the page, so a control placed under them
       would silently close the app instead. --q-top is measured at runtime. */
    position: absolute; top: var(--q-top, 40px); right: 0; bottom: 0; width: min(460px, 94vw);
    pointer-events: auto; display: flex; flex-direction: column;
    background: var(--background-base, #101010);
    color: var(--text-base, #fafafa);
    border-left: 1px solid var(--border-base, #2a2a2a);
    box-shadow: -18px 0 60px rgba(0,0,0,.35);
    font-family: var(--font-family-sans, system-ui, sans-serif);
    font-size: 12px; transform: translateX(102%); transition: transform .18s ease;
  }
  .q-panel[data-open="true"] { transform: none; }
  .q-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border-weak-base, #222); }
  .q-title { font-size: 13px; font-weight: 600; }
  .q-sub { color: var(--text-weak-base, #8a8a8a); font-size: 11px; }
  .q-grow { flex: 1; }
  .q-iconbtn {
    background: transparent; border: 1px solid transparent; color: var(--icon-weak-base, #999);
    border-radius: var(--radius-md, 6px); cursor: pointer; font-size: 12px; line-height: 1;
    padding: 5px 7px; font-family: inherit;
  }
  .q-iconbtn:hover { background: var(--surface-base-hover, #1e1e1e); color: var(--text-base, #fafafa); }
  .q-body { flex: 1; overflow-y: auto; padding: 12px 14px 20px; }
  .q-foot { padding: 8px 14px; border-top: 1px solid var(--border-weak-base, #222); color: var(--text-weak-base, #8a8a8a); font-size: 10px; display: flex; gap: 8px; align-items: center; }

  .q-section { margin-bottom: 16px; }
  .q-label { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-weak-base, #8a8a8a); margin-bottom: 6px; font-weight: 600; }
  .q-row { display: flex; gap: 8px; align-items: center; }
  .q-row + .q-row { margin-top: 8px; }

  select.q-input, input.q-input, textarea.q-input {
    width: 100%; background: var(--input-base, #171717); color: var(--text-base, #fafafa);
    border: 1px solid var(--border-base, #2f2f2f); border-radius: var(--radius-md, 6px);
    padding: 7px 9px; font-family: inherit; font-size: 12px; outline: none;
  }
  select.q-input:focus, input.q-input:focus, textarea.q-input:focus { border-color: var(--border-focus, #4b8bf5); }
  textarea.q-input { resize: vertical; min-height: 68px; line-height: 1.45; }

  .q-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 7px 12px; border-radius: var(--radius-md, 6px); cursor: pointer;
    background: var(--surface-interactive-base, #2b6cf6); color: var(--text-base, #fff);
    border: 1px solid transparent; font-family: inherit; font-size: 12px; font-weight: 600;
  }
  .q-btn:hover { background: var(--surface-interactive-hover, #3b7bf6); }
  .q-btn:disabled { opacity: .5; cursor: default; }
  .q-btn.q-ghost { background: transparent; border-color: var(--border-base, #333); color: var(--text-base, #fafafa); font-weight: 500; }
  .q-btn.q-ghost:hover { background: var(--surface-base-hover, #1e1e1e); }
  .q-btn.q-danger { background: var(--surface-critical-base, #b4323a); }

  .q-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
  .q-chip {
    display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border-radius: 999px;
    background: var(--surface-inset-base, #1b1b1b); border: 1px solid var(--border-weak-base, #2a2a2a);
    font-size: 11px; color: var(--text-base, #fafafa);
  }
  .q-chip button { background: none; border: none; color: var(--icon-weak-base, #999); cursor: pointer; padding: 0; font-size: 11px; line-height: 1; }
  .q-chip button:hover { color: var(--icon-critical-base, #f66); }
  .q-modelist { max-height: 156px; overflow-y: auto; border: 1px solid var(--border-weak-base, #262626); border-radius: var(--radius-md, 6px); margin-top: 6px; }
  .q-model {
    display: flex; align-items: center; gap: 8px; padding: 5px 8px; cursor: pointer; font-size: 11px;
  }
  .q-model:hover { background: var(--surface-base-hover, #1c1c1c); }
  .q-model[data-on="true"] { background: var(--surface-interactive-weak, #182a4d); }
  .q-model .q-mname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .q-model .q-mprov { color: var(--text-weak-base, #888); font-size: 10px; }
  .q-empty { color: var(--text-weak-base, #8a8a8a); padding: 8px; font-size: 11px; }

  .q-steps { display: flex; flex-direction: column; gap: 5px; }
  .q-step {
    border: 1px solid var(--border-weak-base, #262626); border-radius: var(--radius-md, 6px);
    background: var(--surface-inset-base, #161616); overflow: hidden;
  }
  .q-stephead { display: flex; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; }
  .q-stephead:hover { background: var(--surface-base-hover, #1c1c1c); }
  .q-badge { width: 16px; text-align: center; font-size: 11px; }
  .q-step[data-status="running"] .q-badge { color: var(--icon-warning-base, #f5a623); }
  .q-step[data-status="done"] .q-badge { color: var(--icon-success-base, #46a758); }
  .q-step[data-status="failed"] .q-badge { color: var(--icon-critical-base, #ef5350); }
  .q-step[data-status="pending"] .q-badge { color: var(--icon-weak-base, #777); }
  .q-steplabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .q-stepmeta { color: var(--text-weak-base, #888); font-size: 10px; font-variant-numeric: tabular-nums; }
  .q-stepbody { padding: 8px; border-top: 1px solid var(--border-weak-base, #242424); }
  .q-pre {
    white-space: pre-wrap; word-break: break-word; margin: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace); font-size: 11px; line-height: 1.5;
    max-height: 260px; overflow: auto; color: var(--text-base, #fafafa);
  }
  .q-err { color: var(--text-critical-base, #ef5350); }

  .q-result {
    border: 1px solid var(--border-weaker-base, #2a2a2a); border-radius: var(--radius-lg, 8px);
    background: var(--surface-raised-base, #171717); padding: 10px; margin-top: 6px;
  }
  .q-runlist { display: flex; flex-direction: column; gap: 3px; }
  .q-run {
    display: flex; gap: 8px; align-items: center; padding: 5px 7px; border-radius: var(--radius-sm, 4px);
    cursor: pointer; font-size: 11px;
  }
  .q-run:hover { background: var(--surface-base-hover, #1c1c1c); }
  .q-run .q-rtask { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .q-run .q-rmeta { color: var(--text-weak-base, #888); font-size: 10px; }
  .q-banner { padding: 8px 10px; border-radius: var(--radius-md, 6px); margin-bottom: 10px; font-size: 11px; }
  .q-banner[data-kind="warn"] { background: var(--surface-warning-weak, #3a2f10); color: var(--text-warning-base, #f5c04a); }
  .q-banner[data-kind="error"] { background: var(--surface-critical-weak, #3a1414); color: var(--text-critical-base, #ef8080); }
  .q-banner[data-kind="info"] { background: var(--surface-inset-base, #1b1b1b); color: var(--text-weak-base, #9a9a9a); }

  /* OpenCode styles its own [data-selected] rows; the title-bar button has no
     such variant, so mirror the same treatment for our openers. */
  [data-quorum-opener][data-selected="true"] {
    background: var(--v2-background-bg-layer-01, var(--surface-base-hover, rgba(255, 255, 255, .08)));
    color: var(--v2-text-text-base, var(--text-base, #fff));
  }
  [data-quorum-opener][data-selected="true"] [data-slot="icon-svg"] {
    color: var(--v2-icon-icon-base, currentColor);
  }
  `

  function injectStyles() {
    if (document.getElementById("quorum-panel-styles")) return
    const style = document.createElement("style")
    style.id = "quorum-panel-styles"
    style.textContent = CSS
    document.head.appendChild(style)
  }

  // -------------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------------

  function el(tag, props, children) {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === "class") node.className = value
        else if (key === "text") node.textContent = value
        else if (key === "html") node.innerHTML = value
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value)
        else if (key === "style") node.setAttribute("style", value)
        else node.setAttribute(key, value)
      }
    }
    for (const child of children || []) if (child) node.appendChild(child)
    return node
  }

  // -------------------------------------------------------------------------
  // State and rendering
  // -------------------------------------------------------------------------

  const state = {
    open: false,
    loading: false,
    error: null,
    banner: null,
    data: null,
    task: "",
    strategy: null,
    workerMode: null,
    members: null, // null = follow config/auto
    copies: null,
    expanded: new Set(),
    modelFilter: "",
    filterFocused: false,
    transport: null,
    pollTimer: null,
  }

  let dom = null
  /** Signature of the last rendered state, so an unchanged poll does not rebuild the DOM. */
  let lastRenderSignature = null

  /**
   * Everything the rendered output depends on. Polling makes the panel re-render
   * every couple of seconds; rebuilding identical markup threw away the scroll
   * position while reading a run, so an unchanged signature now skips the rebuild.
   */
  function renderSignature() {
    const data = state.data
    return JSON.stringify({
      open: state.open,
      loading: state.loading,
      error: state.error,
      banner: state.banner ? `${state.banner.kind}:${state.banner.text}` : null,
      filter: state.modelFilter,
      expanded: [...state.expanded].sort(),
      strategy: state.strategy,
      mode: state.workerMode,
      members: state.members,
      copies: state.copies,
      config: data?.config ?? null,
      models: data?.models?.length ?? 0,
      runs: (data?.runs ?? []).map((run) => [
        run.id,
        run.status,
        run.ms ?? 0,
        run.result?.length ?? 0,
        run.warnings?.length ?? 0,
        (run.steps ?? []).map((step) => [step.id, step.status, step.ms ?? 0, step.chars ?? 0, step.output?.length ?? 0]),
      ]),
    })
  }

  // A small read-only view of the panel's state, handy when something looks
  // wrong: `window.__quorumPanel.state()` in devtools.
  window.__quorumPanel.state = () => ({
    open: state.open,
    loading: state.loading,
    error: state.error,
    strategy: state.strategy,
    workerMode: state.workerMode,
    members: state.members,
    modelFilter: state.modelFilter,
    serverOrigin: net.origin,
    capturedHeaders: Object.keys(net.headers),
    capturedDirectory: net.headers["x-opencode-directory"] ?? null,
    resolvedDirectory: directory,
    transport: state.transport,
    transportAttempts: state.transportAttempts ?? null,
    hasData: Boolean(state.data),
    dataStrategy: state.data?.config?.strategy ?? null,
    dataMembers: state.data?.config?.members ?? null,
    runs: state.data?.runs?.length ?? null,
    models: state.data?.models?.length ?? null,
  })

  const STRATEGY_HELP = {
    mixture: "Everyone answers in parallel; one model merges the results.",
    debate: "Models critique and revise each other over several rounds.",
    divide: "A planner splits the task; workers solve the parts; results are merged.",
    relay: "Each model improves the previous model's draft in turn.",
    vote: "Models answer independently; a judge picks the strongest.",
  }

  function currentStrategy() {
    return state.strategy || state.data?.config?.strategy || "mixture"
  }
  function currentMode() {
    return state.workerMode || state.data?.config?.workerMode || "text"
  }
  function currentMembers() {
    return state.members ?? state.data?.config?.members ?? []
  }
  function currentCopies() {
    const value = Number(state.copies ?? state.data?.config?.copies ?? 1)
    return Number.isFinite(value) && value > 0 ? Math.min(8, Math.round(value)) : 1
  }

  function setState(patch) {
    Object.assign(state, patch)
    render()
  }

  async function refresh(quiet) {
    if (!quiet) setState({ loading: true, error: null })
    try {
      const data = await rpc("state")
      setState({ data, loading: false, error: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState({ loading: false, error: message })
      // Say why, in the renderer log, the first few times. A panel that cannot
      // reach the server otherwise fails silently.
      if (failuresLogged < 3) {
        failuresLogged++
        note(`state request failed: ${message}`)
      }
    } finally {
      // Poll even after a failure. The panel usually starts before the app has
      // made a project-scoped request, so treating the first failure as fatal
      // would strand it for the rest of the session.
      ensurePolling()
    }
  }

  function ensurePolling() {
    const running = Boolean(state.data?.runs?.some((run) => run.status === "running"))
    // Responsive while you are watching, cheap when you are not.
    const interval = !state.open ? 15_000 : running ? 1_200 : 2_500
    if (state.pollTimer) {
      if (state.pollTimer.interval === interval) return
      clearInterval(state.pollTimer.id)
    }
    const id = setInterval(() => {
      // While closed the only job is keeping the launcher dot honest.
      void refresh(true)
    }, interval)
    state.pollTimer = { id, interval }
  }

  async function startRun() {
    const task = (state.task || "").trim()
    if (!task) {
      setState({ banner: { kind: "warn", text: "Enter a task first." } })
      return
    }
    const body = { task, strategy: currentStrategy(), workerMode: currentMode() }
    const members = currentMembers()
    if (members.length) body.members = members
    setState({ loading: true, banner: { kind: "info", text: "Starting the quorum…" } })
    try {
      const result = await rpc("run", body)
      if (result && result.ok === false) throw new Error(result.error || "could not start")
      setState({ loading: false, banner: { kind: "info", text: `Run ${result?.runID ?? ""} started.` } })
      await refresh(true)
    } catch (error) {
      setState({ loading: false, banner: { kind: "error", text: error.message } })
    }
  }

  async function cancelRun(runID) {
    try {
      await rpc("cancel", { runID })
      await refresh(true)
    } catch (error) {
      setState({ banner: { kind: "error", text: error.message } })
    }
  }

  async function saveConfig(patch) {
    try {
      const result = await rpc("config", { patch })
      setState({ data: state.data ? { ...state.data, config: result.config, sources: result.sources } : state.data })
      return true
    } catch (error) {
      setState({ banner: { kind: "error", text: error.message } })
      return false
    }
  }

  function statusBadge(status) {
    return status === "done" ? "✓" : status === "failed" ? "✗" : status === "running" ? "◐" : status === "cancelled" ? "⊘" : "·"
  }

  function fmtMs(ms) {
    if (ms === undefined || ms === null) return ""
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
  }

  // ---- sections -----------------------------------------------------------

  function renderBanner() {
    if (state.error) {
      return el("div", { class: "q-banner", "data-kind": "error", text: `Server: ${state.error}` })
    }
    if (!net.origin) {
      return el("div", {
        class: "q-banner",
        "data-kind": "info",
        text: "Looking for the OpenCode server… open or refresh a session and this will connect.",
      })
    }
    if (state.banner) {
      return el("div", { class: "q-banner", "data-kind": state.banner.kind, text: state.banner.text })
    }
    return null
  }

  function renderConfig() {
    const data = state.data
    if (!data) return el("div", { class: "q-section" })

    const strategy = el(
      "select",
      {
        class: "q-input",
        onchange: async (event) => {
          // Only a real user interaction may change saved configuration.
          // Synthetic events (from automation or another script in the page)
          // must not be able to rewrite quorum.json.
          if (!event.isTrusted) return
          const value = event.target.value
          setState({ strategy: value })
          await saveConfig({ strategy: value })
        },
      },
      Object.keys(STRATEGY_HELP).map((key) => {
        const option = el("option", { value: key, text: key })
        if (key === currentStrategy()) option.selected = true
        return option
      }),
    )

    const mode = el(
      "select",
      {
        class: "q-input",
        onchange: async (event) => {
          if (!event.isTrusted) return
          const value = event.target.value
          setState({ workerMode: value })
          await saveConfig({ workerMode: value })
        },
      },
      [
        el("option", { value: "text", text: "text — model calls, no tools" }),
        el("option", { value: "agent", text: "agent — real sessions that can edit files" }),
      ],
    )
    mode.value = currentMode()

    // --- members ---
    const members = currentMembers()
    const chips = el("div", { class: "q-chips" })
    if (members.length === 0) {
      chips.appendChild(
        el("span", {
          class: "q-chip",
          text: `auto (${data.config?.autoMembers ?? 4} diverse models)`,
        }),
      )
    } else {
      for (const member of members) {
        chips.appendChild(
          el("span", { class: "q-chip" }, [
            el("span", { text: member }),
            el("button", {
              title: "Remove",
              text: "×",
              onclick: async () => {
                const next = members.filter((entry) => entry !== member)
                setState({ members: next })
                await saveConfig({ members: next })
              },
            }),
          ]),
        )
      }
    }

    const search = el("input", {
      class: "q-input",
      id: "q-filter",
      placeholder: "Filter models…",
      value: state.modelFilter,
      onfocus: () => {
        state.filterFocused = true
      },
      onblur: () => {
        state.filterFocused = false
      },
      oninput: (event) => {
        // Re-rendering replaces this input, so focus is restored in render().
        state.modelFilter = event.target.value
        render()
      },
    })

    const filter = state.modelFilter.toLowerCase()
    const chosen = new Set(currentMembers())
    const list = el("div", { class: "q-modelist" })
    const models = (data.models || []).filter(
      (model) => !filter || model.key.toLowerCase().includes(filter) || model.label.toLowerCase().includes(filter),
    )
    if (models.length === 0) list.appendChild(el("div", { class: "q-empty", text: "No models match." }))
    for (const model of models) {
      const on = chosen.has(model.key)
      list.appendChild(
        el(
          "div",
          {
            class: "q-model",
            "data-on": String(on),
            title: on ? "Click to remove from the quorum" : "Click to add to the quorum",
            onclick: async (event) => {
              if (event && !event.isTrusted) return
              const next = new Set(chosen)
              if (on) next.delete(model.key)
              else next.add(model.key)
              const list = [...next]
              setState({ members: list })
              await saveConfig({ members: list })
            },
          },
          [
            el("span", { class: "q-badge", text: on ? "✓" : "·" }),
            el("span", { class: "q-mname", text: model.label }),
            el("span", { class: "q-mprov", text: model.provider.split("/")[0] }),
          ],
        ),
      )
    }

    const copiesInput = el("input", {
      class: "q-input",
      type: "number",
      min: "1",
      max: "8",
      step: "1",
      title: "Run each member this many times. Above 1 this is a quorum of the same model.",
      value: String(currentCopies()),
      onchange: async (event) => {
        if (!event.isTrusted) return
        const value = Math.min(8, Math.max(1, Math.round(Number(event.target.value) || 1)))
        setState({ copies: value })
        await saveConfig({ copies: value })
      },
    })

    return el("div", { class: "q-section" }, [
      el("label", { class: "q-label", text: "Strategy" }),
      strategy,
      el("div", { class: "q-sub", text: STRATEGY_HELP[currentStrategy()] || "", style: "margin-top:5px" }),
      el("div", { class: "q-row", style: "margin-top:12px" }, [
        el("div", { class: "q-grow" }, [el("label", { class: "q-label", text: "Workers" }), mode]),
        el("div", { style: "width:86px" }, [el("label", { class: "q-label", text: "Copies" }), copiesInput]),
      ]),
      currentCopies() > 1
        ? el("div", {
            class: "q-sub",
            text: `each member runs ${currentCopies()}× with a different framing — a quorum of the same model`,
            style: "margin-top:5px",
          })
        : null,
      el("label", { class: "q-label", text: "Members", style: "margin-top:12px" }),
      chips,
      search,
      list,
    ])
  }

  function renderTask() {
    const textarea = el("textarea", {
      class: "q-input",
      placeholder: "What should the quorum work on?",
      oninput: (event) => {
        state.task = event.target.value
        dom.run.disabled = !state.task.trim()
      },
    })
    textarea.value = state.task

    const run = el("button", {
      class: "q-btn",
      text: "Run quorum",
      onclick: () => void startRun(),
    })
    run.disabled = !state.task.trim()
    dom.run = run

    return el("div", { class: "q-section" }, [
      el("label", { class: "q-label", text: "Task" }),
      textarea,
      el("div", { class: "q-row", style: "margin-top:8px" }, [run]),
    ])
  }

  function renderRuns() {
    const runs = state.data?.runs ?? []
    const active = runs.filter((run) => run.status === "running")
    if (runs.length === 0) {
      return el("div", { class: "q-section" }, [
        el("label", { class: "q-label", text: "Runs" }),
        el("div", { class: "q-sub", text: "No runs yet." }),
      ])
    }
    const list = el("div", { class: "q-runlist" })
    for (const run of runs.slice(0, 8)) {
      list.appendChild(
        el("div", { class: "q-run", onclick: () => setState({ expanded: new Set(run.steps.map((s) => s.id)) }) }, [
          el("span", { class: "q-badge", text: statusBadge(run.status) }),
          el("span", { class: "q-rtask", text: run.task.slice(0, 70) }),
          el("span", { class: "q-rmeta", text: `${run.strategy} · ${fmtMs(run.ms)}` }),
        ]),
      )
    }
    return el("div", { class: "q-section" }, [
      el("div", { class: "q-row" }, [
        el("label", { class: "q-label q-grow", text: "Runs", style: "margin:0" }),
        ...active.map((run) =>
          el("button", {
            class: "q-btn q-danger",
            style: "padding:3px 8px;font-size:11px",
            text: `Cancel ${run.id.replace("quorum_", "")}`,
            onclick: () => void cancelRun(run.id),
          }),
        ),
      ]),
      list,
    ])
  }

  function renderCurrent() {
    const runs = state.data?.runs ?? []
    const run = runs.find((entry) => entry.status === "running") || runs[0]
    if (!run) return null

    const steps = el("div", { class: "q-steps" })
    for (const step of run.steps) {
      const expanded = state.expanded.has(step.id)
      const body = expanded
        ? el("div", { class: "q-stepbody" }, [
            step.error
              ? el("pre", { class: "q-pre q-err", text: step.error })
              : el("pre", { class: "q-pre", text: step.output || "(no output)" }),
          ])
        : null
      steps.appendChild(
        el("div", { class: "q-step", "data-status": step.status, "data-step": step.id }, [
          el("div", {
            class: "q-stephead",
            onclick: () => {
              const next = new Set(state.expanded)
              if (expanded) next.delete(step.id)
              else next.add(step.id)
              setState({ expanded: next })
            },
          }, [
            el("span", { class: "q-badge", text: statusBadge(step.status) }),
            el("span", { class: "q-steplabel", text: `${step.kind} · ${step.label}` }),
            el("span", { class: "q-stepmeta", text: step.error ? "failed" : fmtMs(step.ms) }),
          ]),
          body,
        ]),
      )
    }

    const result = run.result
      ? el("div", { class: "q-result" }, [
          el("div", { class: "q-row" }, [
            el("label", { class: "q-label q-grow", text: "Result", style: "margin:0" }),
            el("button", {
              class: "q-iconbtn",
              text: "copy",
              onclick: () => {
                void navigator.clipboard?.writeText(run.result)
                setState({ banner: { kind: "info", text: "Copied the quorum result." } })
              },
            }),
          ]),
          el("pre", { class: "q-pre", text: run.result }),
        ])
      : run.error
        ? el("div", { class: "q-banner", "data-kind": "error", text: run.error })
        : null

    const warnings = run.warnings?.length
      ? el("div", { class: "q-sub", text: run.warnings.join(" · "), style: "margin-top:6px" })
      : null

    return el("div", { class: "q-section" }, [
      el("label", {
        class: "q-label",
        text: `Current run — ${run.status}${run.ms ? ` in ${fmtMs(run.ms)}` : ""}`,
      }),
      el("div", { class: "q-sub", text: `${run.id} · ${run.strategy} · ${run.workerMode} workers`, style: "margin-bottom:7px" }),
      steps,
      result,
      warnings,
    ])
  }

  // ---- full render --------------------------------------------------------

  function render() {
    if (!dom) return
    // The app re-renders its own chrome freely, so re-attaching the openers is
    // part of every render. Both calls are no-ops when nothing has changed.
    if (!openersHealthy()) syncOpeners()
    syncOpenerState()
    dom.root.setAttribute("data-busy", String(Boolean(state.data?.runs?.some((run) => run.status === "running"))))
    dom.panel.setAttribute("data-open", String(state.open))
    dom.launch.setAttribute("data-active", String(state.open))

    if (!state.open) return

    // An unchanged poll must not touch the DOM: it would reset the scroll
    // position while the user is reading a run.
    const signature = renderSignature()
    if (signature === lastRenderSignature) return
    lastRenderSignature = signature

    // Preserve scroll positions across a genuine rebuild: the panel body, every
    // expanded step's output, and the model list.
    const bodyScroll = dom.body.scrollTop
    const stepScrolls = new Map()
    for (const element of dom.body.querySelectorAll(".q-step[data-step]")) {
      const pre = element.querySelector(".q-pre")
      const id = element.getAttribute("data-step")
      if (pre && id) stepScrolls.set(id, pre.scrollTop)
    }
    const previousList = dom.body.querySelector(".q-modelist")
    const previousScroll = previousList ? previousList.scrollTop : 0

    dom.body.replaceChildren(
      ...[
        renderBanner(),
        renderConfig(),
        renderTask(),
        renderCurrent(),
        renderRuns(),
      ].filter(Boolean),
    )

    dom.body.scrollTop = bodyScroll
    for (const [id, top] of stepScrolls) {
      const pre = dom.body.querySelector(`.q-step[data-step="${id}"] .q-pre`)
      if (pre && top) pre.scrollTop = top
    }
    const modelList = dom.body.querySelector(".q-modelist")
    if (modelList && previousScroll) modelList.scrollTop = previousScroll

    // Keep the caret in the model filter across the re-render it triggers.
    if (state.filterFocused) {
      const filter = dom.body.querySelector("#q-filter")
      if (filter) {
        filter.focus()
        const end = filter.value.length
        try {
          filter.setSelectionRange(end, end)
        } catch {
          /* ignore */
        }
      }
    }

    const config = state.data?.config
    dom.foot.replaceChildren(
      el("span", { text: config ? `${currentMembers().length || config.autoMembers} members · concurrency ${config.concurrency}` : "" }),
      el("span", { class: "q-grow" }),
      el("span", { text: "quorum.json" }),
    )
  }

  // -------------------------------------------------------------------------
  // Mount
  // -------------------------------------------------------------------------

  /**
   * How far down the window's own chrome reaches.
   *
   * The app draws a custom title bar (drag regions marked with
   * `-webkit-app-region`), and its close/minimise buttons sit in that strip,
   * above the page. Measuring it beats hard-coding a height that an app update
   * could change.
   */
  function chromeInset() {
    let bottom = 0
    const probe = (element, depth) => {
      if (!element || depth > 8) return
      let region = ""
      try {
        const style = getComputedStyle(element)
        region = style.webkitAppRegion || style.getPropertyValue("-webkit-app-region") || ""
      } catch {
        /* ignore */
      }
      if (region && region !== "none") {
        const rect = element.getBoundingClientRect()
        if (rect.height > 0 && rect.height < 200) bottom = Math.max(bottom, rect.bottom)
      }
      for (const child of element.children) probe(child, depth + 1)
    }
    try {
      probe(document.body, 0)
    } catch {
      /* ignore */
    }
    return Math.round(bottom)
  }

  function applyChromeInset() {
    const inset = Math.max(40, Math.min(120, chromeInset()))
    document.documentElement.style.setProperty("--q-top", `${inset}px`)
  }

  /**
   * Places the opener inside OpenCode's own chrome.
   *
   * The buttons are clones of real ones — "New session" in the title bar and
   * "Settings" in the home sidebar — so they inherit the shipped sizing, hover,
   * focus ring and icon treatment exactly, instead of approximating them with
   * my own CSS. The floating button is kept only as a fallback for a layout
   * where neither anchor exists, so the feature can never become unreachable.
   */
  const QUORUM_ICON = "models"

  function iconMarkup(name) {
    return `<svg data-slot="icon-svg" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><use href="#opencode-v2-icon-${name}"></use></svg>`
  }

  function openersHealthy() {
    return Array.isArray(dom?.openers) && dom.openers.length > 0 && dom.openers.every((opener) => opener.isConnected)
  }

  function wireOpener(button, where) {
    button.setAttribute("data-quorum-opener", where)
    button.removeAttribute("data-action")
    button.setAttribute("aria-label", "Quorum")
    button.setAttribute("title", "Quorum — run several models on one task")
    const svg = button.querySelector("svg")
    if (svg && svg.parentElement) svg.outerHTML = iconMarkup(QUORUM_ICON)
    button.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      toggle()
    })
  }

  function syncOpeners() {
    if (!dom) return 0
    if (openersHealthy()) return dom.openers.length
    const openers = []

    // 1. Title bar: a global action, next to Home and New session, in every view.
    const titlebar = document.querySelector("[data-slot=titlebar-v2]")
    const existingTitlebar = titlebar?.querySelector("[data-quorum-opener=titlebar]")
    if (existingTitlebar) {
      openers.push(existingTitlebar)
    } else if (titlebar) {
      const reference =
        Array.from(titlebar.querySelectorAll("button")).find(
          (button) => (button.getAttribute("aria-label") || "").trim() === "New session",
        ) ?? titlebar.querySelector("button")
      if (reference?.parentElement) {
        const button = reference.cloneNode(true)
        wireOpener(button, "titlebar")
        reference.parentElement.insertBefore(button, reference.nextSibling)
        openers.push(button)
      }
    }

    // 2. Home sidebar: beside Settings and Help, where the app's own nav lives.
    const settings = Array.from(document.querySelectorAll("aside button")).find(
      (button) => (button.textContent || "").trim() === "Settings",
    )
    const existingSidebar = settings?.parentElement?.querySelector("[data-quorum-opener=sidebar]")
    if (existingSidebar) {
      openers.push(existingSidebar)
    } else if (settings?.parentElement) {
      const entry = settings.cloneNode(true)
      wireOpener(entry, "sidebar")
      const label = entry.querySelector("span")
      if (label) label.textContent = "Quorum"
      settings.parentElement.insertBefore(entry, settings)
      openers.push(entry)
    }

    dom.openers = openers
    if (dom.launch) dom.launch.style.display = openers.length > 0 ? "none" : ""
    return openers.length
  }

  /** Mirrors the panel's open state onto the openers, so the entry looks active. */
  function syncOpenerState() {
    for (const opener of dom?.openers ?? []) {
      if (state.open) opener.setAttribute("data-selected", "true")
      else opener.removeAttribute("data-selected")
    }
  }

  function mount() {
    injectStyles()
    applyChromeInset()
    // Measuring walks the DOM, so do it once per resize burst rather than on
    // every resize event.
    let resizeTimer
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(applyChromeInset, 150)
    })

    const launch = el("div", { class: "q-launch", title: "Open the quorum dashboard", onclick: toggle }, [
      el("span", { class: "q-dot" }),
      el("span", { text: "Quorum" }),
    ])

    const close = () => setState({ open: false })
    const head = el("div", { class: "q-head" }, [
      el("div", {}, [
        el("div", { class: "q-title", text: "Quorum" }),
        el("div", { class: "q-sub", text: "Several models, one answer" }),
      ]),
      el("span", { class: "q-grow" }),
      el("button", { class: "q-iconbtn", text: "refresh", onclick: () => void refresh(false) }),
      el("button", { class: "q-iconbtn", text: "✕", title: "Close", onclick: close }),
    ])
    const body = el("div", { class: "q-body" })
    const foot = el("div", { class: "q-foot" })
    const panel = el("div", { class: "q-panel", "data-open": "false" }, [head, body, foot])
    const root = el("div", { class: "q-root" }, [launch, panel])

    // Dismiss on a click anywhere outside the panel. This listens on the
    // document, not on the overlay: the overlay is `pointer-events: none`, so a
    // click on OpenCode's own UI never passes through it. The event's path is
    // used rather than `panel.contains(target)`, because an interaction inside
    // the panel can re-render it and detach the clicked element — a detached
    // target would look "outside" and close the panel on the user.
    document.addEventListener("click", (event) => {
      if (!state.open) return
      const path = typeof event.composedPath === "function" ? event.composedPath() : []
      if (path.includes(panel) || path.includes(launch)) return
      close()
    })

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) close()
    })

    document.body.appendChild(root)
    dom = { root, panel, body, foot, launch, run: null, openers: [] }
    render()

    // Keep the openers attached if the app re-renders its chrome. The health
    // check is O(1) when they are connected, so this stays cheap during streaming.
    let openerTimer
    new MutationObserver(() => {
      clearTimeout(openerTimer)
      openerTimer = setTimeout(() => {
        if (!dom) return
        if (!openersHealthy()) syncOpeners()
        syncOpenerState()
      }, 200)
    }).observe(document.body, { childList: true, subtree: true })

    // The panel loads before the app has necessarily made any request, so try
    // once shortly after mount rather than waiting for captured traffic. The
    // note is a single line in OpenCode's renderer log, which makes a silent
    // "panel never started" impossible to miss.
    setTimeout(() => {
      note(`panel loaded; server=${net.origin ?? "unknown"}; openers=${dom?.openers?.length ?? 0}`)
      prime()
      // Report what actually happened on the first request, so a failure is
      // diagnosable from the log rather than by inference.
      setTimeout(() => {
        note(
          `first fetch: ${JSON.stringify({
            error: state.error,
            models: state.data?.models?.length ?? null,
            transport: state.transport,
            directory: directory ? "resolved" : null,
            attempts: state.transportAttempts,
          })}`,
        )
      }, 5000)
    }, 1500)
  }

  function toggle() {
    setState({ open: !state.open, banner: null })
    if (state.open) void refresh(false)
  }

  // Once the server address is known, pull the state so the launcher dot
  // reflects reality without the user having to open the panel. This runs at
  // most once, because `net` reports every API request the app makes.
  let primed = false
  const prime = () => {
    if (primed) return
    primed = true
    void refresh(true)
  }
  net.listeners.push(prime)
  if (net.origin) prime()

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount)
  } else {
    mount()
  }
})()
