/**
 * Model roster handling.
 *
 * A model reference is written as `providerID/modelID`, for example
 * `opencode-go/kimi-k2.7-code`. Because provider IDs can themselves contain a
 * slash (`opencode/openai/gpt-oss-20b`), a reference is only split on the FIRST
 * slash: everything before it is the provider, everything after it is the model.
 */

export interface ModelRef {
  providerID: string
  id: string
}

export interface ModelOption extends ModelRef {
  label: string
  provider: string
  tools: boolean
  enabled: boolean
  cost?: { input?: number; output?: number }
}

type Unknown = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function modelKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}`
}

/** Splits a `provider/model` reference on the first slash. */
export function parseModelRef(value: string): ModelRef | undefined {
  const trimmed = value.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Normalises whatever the model list returns into the flat shape we use. */
export function toModelOption(raw: unknown): ModelOption | undefined {
  if (!isRecord(raw)) return undefined
  const providerID = asString(raw.providerID) ?? asString(raw.provider)
  const id = asString(raw.id) ?? asString(raw.modelID)
  if (!providerID || !id) return undefined
  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {}
  const cost = isRecord(raw.cost) ? raw.cost : Array.isArray(raw.cost) ? (raw.cost[0] as Unknown) : {}
  return {
    providerID,
    id,
    provider: providerID,
    label: asString(raw.name) ?? id,
    tools: capabilities.tools === true,
    enabled: raw.enabled !== false,
    cost: isRecord(cost)
      ? { input: asNumber(cost.input), output: asNumber(cost.output) }
      : undefined,
  }
}

export async function listModels(ctx: {
  model: { list(input?: unknown): Promise<unknown> }
}): Promise<ModelOption[]> {
  const response = (await ctx.model.list()) as unknown
  // Client responses may be wrapped as `{ data, location }`.
  const payload = isRecord(response) && "data" in response ? response.data : response
  const rows = Array.isArray(payload) ? payload : []
  const options = rows.map(toModelOption).filter((option): option is ModelOption => Boolean(option))
  // Stable, readable ordering: provider, then label.
  return options.sort(
    (a, b) => a.providerID.localeCompare(b.providerID) || a.label.localeCompare(b.label),
  )
}

/**
 * Models whose ids mark them as an experiment or a giveaway rather than the
 * provider's main line. They are deprioritised — not excluded — when building
 * an automatic roster, because in practice these are the tiers that most often
 * rate-limit, time out, or fail outright.
 */
const EXPERIMENTAL = /(^|[-_.])(free|contributor|preview|spark|beta|alpha|experimental)/i

function outputCost(model: ModelOption): number {
  return model.cost?.output ?? 0
}

function capabilityScore(model: ModelOption): number {
  // Cheap, stable ordering signals only. Cost is a weak proxy for capability,
  // and a large context window is a mild positive.
  let score = 0
  if (!EXPERIMENTAL.test(model.id)) score += 1_000
  if (model.tools) score += 100
  score += Math.min(outputCost(model), 60) * 10
  return score
}

export interface AutoRosterOptions {
  /** Models the user already runs; tried first. */
  preferred?: ModelRef[]
  /** Models that recently failed, skipped while alternatives exist. */
  avoid?: ReadonlySet<string>
  /** Models that have recently answered, strongly preferred. */
  good?: ReadonlySet<string>
}

/**
 * Builds the automatic roster.
 *
 * Model metadata carries no reliable signal about whether a model will actually
 * answer — a free-tier model can reject plugin calls outright, and a paid one
 * can have a dead API key. So this combines what little metadata implies with
 * what the plugin has actually observed:
 *
 *  1. models the user runs themselves (`preferred`), minus anything that failed
 *     recently or looks like a giveaway tier;
 *  2. then one at a time from each provider (provider spread is the diversity
 *     that correlates with different training and different blind spots);
 *  3. ordered by `good` (recently answered), then a metadata score;
 *  4. skipping `avoid` while it still leaves a usable roster;
 *  5. never taking the same model id twice from two providers.
 */
export function autoRoster(models: ModelOption[], count: number, options: AutoRosterOptions = {}): ModelOption[] {
  const { preferred = [], avoid = new Set(), good = new Set() } = options

  const usable = models.filter((model) => model.enabled)
  const pool = usable.length > 0 ? usable : models
  const withTools = pool.filter((model) => model.tools)
  const base = withTools.length > 0 ? withTools : pool
  const withoutFailures = base.filter((model) => !avoid.has(modelKey(model)))
  const source = withoutFailures.length > 0 ? withoutFailures : base

  const chosen: ModelOption[] = []
  const seenKeys = new Set<string>()
  const seenIds = new Set<string>()

  const push = (model: ModelOption | undefined): boolean => {
    if (!model) return false
    const key = modelKey(model)
    if (seenKeys.has(key) || seenIds.has(model.id)) return false
    seenKeys.add(key)
    seenIds.add(model.id)
    chosen.push(model)
    return true
  }

  // 1. The models the user actually runs come first — unless they are known to
  //    be failing or are a giveaway tier that cannot serve plugin requests.
  const byKey = new Map(models.map((model) => [modelKey(model), model]))
  for (const ref of preferred) {
    const model = byKey.get(modelKey(ref))
    if (!model) continue
    if (avoid.has(modelKey(model)) || EXPERIMENTAL.test(model.id)) continue
    push(model)
  }

  // 2. One at a time from each provider, best first.
  const score = (model: ModelOption): number =>
    capabilityScore(model) + (good.has(modelKey(model)) ? 2_000 : 0)
  const byProvider = new Map<string, ModelOption[]>()
  for (const model of source) {
    const list = byProvider.get(model.providerID) ?? []
    list.push(model)
    byProvider.set(model.providerID, list)
  }
  const ranked = [...byProvider.values()]
    .map((list) => list.slice().sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id)))
    .sort((a, b) => score(b[0] as ModelOption) - score(a[0] as ModelOption))

  for (let round = 0; chosen.length < count; round++) {
    let added = false
    for (const list of ranked) {
      if (chosen.length >= count) break
      if (push(list[round])) added = true
    }
    // Nothing left that is not already chosen.
    if (!added) break
  }

  // If the provider spread came up short, top up from everything else.
  for (const model of source) {
    if (chosen.length >= count) break
    push(model)
  }

  return chosen
}

/**
 * Resolves the configured roster against the models that actually exist.
 *
 * References are normally `providerID/modelID`, but a bare `modelID` or a wrong
 * provider prefix is resolved too — matching an id is unambiguous enough to be
 * friendlier than dropping the model. Repeats are kept as-is, so listing a model
 * more than once asks for several attempts from it. Anything that still cannot
 * be matched is reported, so a typo is visible instead of silently shrinking the
 * quorum.
 */
export function resolveRoster(
  models: ModelOption[],
  members: string[],
): { roster: ModelOption[]; unknown: string[]; substituted: string[] } {
  const byKey = new Map(models.map((model) => [modelKey(model), model]))
  const byId = new Map<string, ModelOption[]>()
  for (const model of models) {
    const list = byId.get(model.id) ?? []
    list.push(model)
    byId.set(model.id, list)
  }

  const roster: ModelOption[] = []
  const unknown: string[] = []
  const substituted: string[] = []

  for (const ref of members) {
    const trimmed = ref.trim()
    if (!trimmed) continue
    const parsed = parseModelRef(trimmed)
    let found = parsed ? byKey.get(modelKey(parsed)) : undefined

    if (!found) {
      // Fall back to matching on the bare model id.
      const bare = parsed ? parsed.id : trimmed
      const candidates = byId.get(bare) ?? []
      found = candidates.find((model) => model.tools) ?? candidates[0]
      if (found) substituted.push(`${trimmed} → ${modelKey(found)}`)
    }

    if (!found) {
      unknown.push(trimmed)
      continue
    }
    // Deliberately NOT de-duplicated: naming the same model twice is how you ask
    // for several independent attempts from it.
    roster.push(found)
  }

  return { roster, unknown, substituted }
}

/** Resolves one optional role model, falling back to the first roster entry. */
export function resolveRole(
  models: ModelOption[],
  ref: string | undefined,
  fallback?: ModelOption,
): ModelOption | undefined {
  if (ref) {
    const parsed = parseModelRef(ref)
    const key = parsed ? modelKey(parsed) : undefined
    const found = key ? models.find((model) => modelKey(model) === key) : undefined
    if (found) return found
  }
  return fallback
}
