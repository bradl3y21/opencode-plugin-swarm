import { Rpc } from "@opencode/plugin"

/**
 * The quorum RPC contract.
 *
 * It is shared by three callers: the desktop dashboard (over HTTP), the
 * terminal UI (through `context.client.rpc`), and anything else that wants to
 * drive the quorum.
 *
 * Every payload crosses the wire as a JSON string inside a `{ json }` envelope.
 * That keeps the contract stable as the run shape grows, and sidesteps schema
 * drift between the plugin and the clients that talk to it.
 */

const envelopeInput = {
  type: "object",
  properties: { json: { type: "string" } },
  required: ["json"],
  additionalProperties: false,
} as const

const envelopeOutput = {
  type: "object",
  properties: { json: { type: "string" } },
  required: ["json"],
  additionalProperties: false,
} as const

export const QuorumRpc = Rpc.define({
  id: "quorum",
  methods: {
    /**
     * Everything a dashboard needs to draw itself: config, runs, models.
     * `json` is `{}`.
     */
    state: {
      input: envelopeInput,
      output: envelopeOutput,
    },
    /** Start a run. `json` is `{ task, strategy?, members?, workerMode?, sessionID?, source? }`. */
    run: {
      input: envelopeInput,
      output: envelopeOutput,
    },
    /** Cancel a run by id. `json` is `{ runID }`. */
    cancel: {
      input: envelopeInput,
      output: envelopeOutput,
    },
    /** Read or write configuration. `json` is `{ patch? }`; a patch writes to the project file. */
    config: {
      input: envelopeInput,
      output: envelopeOutput,
    },
    /** Tail the plugin log. `json` is `{ lines? }`. */
    log: {
      input: envelopeInput,
      output: envelopeOutput,
    },
  },
  events: {
    /** A run changed. `json` is the run snapshot. */
    updated: {
      schema: {
        type: "object",
        properties: { json: { type: "string" } },
        required: ["json"],
        additionalProperties: false,
      },
    },
  },
})
