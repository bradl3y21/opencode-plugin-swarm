import { Plugin } from "@opencode/plugin/tui"
import { QuorumRpc } from "./rpc"

/**
 * Terminal UI for the quorum.
 *
 * This half only loads in the terminal client (OpenCode does not load TUI
 * plugins in the desktop app; the desktop uses the dashboard injected into the
 * app window instead). It talks to the same server plugin over RPC, so both
 * front-ends always agree.
 */

interface DialogOption<Value> {
  title: string
  value: Value
  description?: string
}

interface TuiContext {
  client: {
    rpc(definition: unknown): Record<string, (input: unknown) => Promise<{ json?: string }>>
  }
  location?: { directory?: string }
  ui: {
    dialog: {
      alert(options: { title: string; message: string }): Promise<void>
      prompt(options: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>
      select<Value>(options: {
        title: string
        placeholder?: string
        options: readonly DialogOption<Value>[]
        current?: Value
      }): Promise<Value | undefined>
    }
    toast: { show(options: { message: string; variant?: "info" | "success" | "warning" | "error" }): void }
  }
  keymap: {
    layer(factory: () => unknown): void
  }
}

export default Plugin.define({
  id: "quorum.tui",

  setup(rawContext) {
    const context = rawContext as unknown as TuiContext
    const quorum = context.client.rpc(QuorumRpc)

    const call = async <T>(method: string, body: unknown = {}): Promise<T | undefined> => {
      try {
        const fn = quorum[method]
        if (!fn) throw new Error(`unknown method ${method}`)
        const result = await fn({ json: JSON.stringify(body) })
        const text = typeof result?.json === "string" ? result.json : undefined
        return text ? (JSON.parse(text) as T) : undefined
      } catch (error) {
        context.ui.toast.show({
          message: `quorum: ${error instanceof Error ? error.message : String(error)}`,
          variant: "error",
        })
        return undefined
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [
        {
          id: "quorum.dashboard",
          title: "Quorum dashboard",
          description: "Run and watch a quorum of models",
          group: "Plugins",
          bind: "f9",
          palette: true,
          slash: { name: "quorum", aliases: ["quorums"] },
          run: () => openDashboard(context, call),
        },
      ],
      bindings: ["quorum.dashboard"],
    }))
  },
})

async function openDashboard(
  context: TuiContext,
  call: <T>(method: string, body?: unknown) => Promise<T | undefined>,
): Promise<void> {
  for (;;) {
    const state = await call<{
      config: { strategy: string; workerMode: string; members: string[]; autoMembers: number }
      models: Array<{ key: string; label: string; provider: string }>
      runs: Array<{ id: string; task: string; status: string; strategy: string; steps: Array<{ status: string }> }>
    }>("state")
    if (!state) return

    const running = state.runs.filter((run) => run.status === "running").length
    const choice = await context.ui.dialog.select<string>({
      title: `Quorum — ${state.config.strategy}, ${state.config.members.length || `${state.config.autoMembers} auto`} members${
        running ? `, ${running} running` : ""
      }`,
      placeholder: "Choose an action",
      options: [
        { value: "run", title: "Run a task", description: "Send one task to the quorum" },
        { value: "strategy", title: `Strategy: ${state.config.strategy}`, description: "How the models work together" },
        {
          value: "members",
          title: `Members: ${state.config.members.length || `${state.config.autoMembers} auto`}`,
          description: "Which models join the quorum",
        },
        {
          value: "mode",
          title: `Workers: ${state.config.workerMode}`,
          description: state.config.workerMode === "agent" ? "Real sessions that can edit files" : "Plain model calls, no tools",
        },
        { value: "runs", title: `Recent runs (${state.runs.length})`, description: "Inspect or cancel" },
        { value: "close", title: "Close" },
      ],
    })
    if (!choice || choice === "close") return

    switch (choice) {
      case "run": {
        const task = await context.ui.dialog.prompt({
          title: "Quorum task",
          description: "What should the quorum work on?",
          placeholder: "Review the current change for correctness…",
        })
        if (!task?.trim()) break
        const started = await call<{ runID?: string; ok: boolean; error?: string }>("run", { task: task.trim() })
        if (started?.ok) {
          context.ui.toast.show({ message: `Quorum started: ${started.runID ?? ""}`, variant: "success" })
        } else if (started?.error) {
          context.ui.toast.show({ message: started.error, variant: "error" })
        }
        break
      }
      case "strategy": {
        const strategy = await context.ui.dialog.select<string>({
          title: "Quorum strategy",
          options: [
            { value: "mixture", title: "mixture", description: "Everyone answers; one model merges the result." },
            { value: "debate", title: "debate", description: "Models critique and revise each other over rounds." },
            { value: "divide", title: "divide", description: "Planner splits the task; workers solve parts; merged." },
            { value: "relay", title: "relay", description: "Each model improves the previous model's draft." },
            { value: "vote", title: "vote", description: "A judge picks the strongest answer." },
          ],
        })
        if (!strategy) break
        await call("config", { patch: { strategy } })
        context.ui.toast.show({ message: `Strategy: ${strategy}`, variant: "success" })
        break
      }
      case "members": {
        const members = await context.ui.dialog.prompt({
          title: "Quorum members",
          description: `Comma separated provider/model. Known models:\n${state.models
            .slice(0, 20)
            .map((model) => model.key)
            .join(", ")}${state.models.length > 20 ? ", …" : ""}`,
          placeholder: "opencode-go/kimi-k2.7-code, opencode-go/claude-opus-5-5",
          value: state.config.members.join(", "),
        })
        if (members === undefined) break
        const list = members
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
        await call("config", { patch: { members: list } })
        context.ui.toast.show({
          message: list.length ? `Members: ${list.length}` : "Members: automatic",
          variant: "success",
        })
        break
      }
      case "mode": {
        const mode = await context.ui.dialog.select<string>({
          title: "Worker mode",
          options: [
            { value: "text", title: "text", description: "Plain model calls. Fast and cheap, no tools." },
            { value: "agent", title: "agent", description: "Real sessions. Can read and edit your files." },
          ],
        })
        if (!mode) break
        await call("config", { patch: { workerMode: mode } })
        context.ui.toast.show({ message: `Workers: ${mode}`, variant: "success" })
        break
      }
      case "runs": {
        if (state.runs.length === 0) {
          await context.ui.dialog.alert({ title: "No runs yet", message: "Start one with 'Run a task'." })
          break
        }
        const runID = await context.ui.dialog.select<string>({
          title: "Recent runs",
          options: state.runs.map((run) => ({
            value: run.id,
            title: `${run.status === "running" ? "…" : run.status === "done" ? "✓" : "✗"} ${run.task.slice(0, 60)}`,
            description: `${run.id} · ${run.strategy} · ${run.steps.filter((step) => step.status === "done").length}/${run.steps.length} steps`,
          })),
        })
        if (!runID) break
        const detail = await call<{ runs: Array<{ id: string; result?: string; error?: string }> }>("state", { runID })
        const found = detail?.runs.find((run) => run.id === runID)
        await context.ui.dialog.alert({
          title: `Run ${runID}`,
          message: found?.result ?? found?.error ?? "(no result yet)",
        })
        break
      }
      default:
        break
    }
  }
}
