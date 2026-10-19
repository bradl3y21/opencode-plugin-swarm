/**
 * Prompt templates for every role in the quorum.
 *
 * They are deliberately short and firm about output shape: the aggregator and
 * the planner both parse worker output, so a chatty answer costs the run.
 */

export function proposePrompt(task: string, role: string): string {
  return [
    `You are "${role}", one specialist in a panel of AI models answering the same request.`,
    "Answer the request directly and completely. Do not mention that other models are answering.",
    "Prefer concrete, verifiable specifics over hedging. If you are unsure, say which part is uncertain.",
    "",
    "REQUEST",
    task,
  ].join("\n")
}

export function critiquePrompt(task: string, ownAnswer: string, others: Array<{ role: string; text: string }>): string {
  const peers = others
    .map((entry) => `--- ${entry.role} answered ---\n${entry.text}`)
    .join("\n\n")
  return [
    'You are revising your own answer as part of a panel of AI models (a "debate" round).',
    "Read the other answers, take anything they got right, and drop anything of yours they proved wrong.",
    "Return your improved FINAL answer only. Do not narrate the changes, do not address the other models, do not add a preamble.",
    "",
    "REQUEST",
    task,
    "",
    "YOUR PREVIOUS ANSWER",
    ownAnswer,
    "",
    "OTHER ANSWERS",
    peers,
  ].join("\n")
}

export function aggregatePrompt(task: string, answers: Array<{ role: string; text: string; error?: string }>): string {
  const body = answers
    .map((entry) => {
      const header = entry.error ? `--- ${entry.role} (FAILED: ${entry.error}) ---` : `--- ${entry.role} ---`
      return `${header}\n${entry.text || "(no content)"}`
    })
    .join("\n\n")
  return [
    "You are the aggregator for a panel of AI models that each answered the same request.",
    "Synthesize ONE final answer that is better than any single contribution:",
    "- Merge complementary detail. Where the panel agrees, that is high-confidence; state it plainly.",
    "- Where the panel disagrees, decide which is right and say why in one clause.",
    "- Discard confident-sounding errors. Never invent facts that no member provided.",
    "- Write the answer itself, not a report about the panel. No preamble, no meta-commentary.",
    "",
    "REQUEST",
    task,
    "",
    "PANEL ANSWERS",
    body,
  ].join("\n")
}

export function planPrompt(task: string, maxParts: number): string {
  return [
    "You are the planner for a quorum of AI models. Split the request into independent subtasks.",
    `Return between 2 and ${maxParts} subtasks. Each must be doable on its own, without seeing the others' work.`,
    "Reply with JSON only, in exactly this shape and nothing else:",
    '{"subtasks":[{"title":"short label","instruction":"what to produce"}]}',
    "",
    "REQUEST",
    task,
  ].join("\n")
}

export function subtaskPrompt(task: string, title: string, instruction: string): string {
  return [
    `You are one worker in a quorum of AI models handling a larger request. Your assigned subtask: ${title}`,
    "",
    "Produce the complete output for your subtask. Assume the other subtasks are handled elsewhere.",
    "No preamble, no meta-commentary about the quorum.",
    "",
    "YOUR SUBTASK",
    instruction,
    "",
    "THE ORIGINAL REQUEST (for context only)",
    task,
  ].join("\n")
}

export function mergePrompt(task: string, parts: Array<{ title: string; text: string; error?: string }>): string {
  const body = parts
    .map((part) => {
      const header = part.error ? `--- ${part.title} (FAILED: ${part.error}) ---` : `--- ${part.title} ---`
      return `${header}\n${part.text || "(no content)"}`
    })
    .join("\n\n")
  return [
    "You are the aggregator for a quorum of AI models that each completed one subtask of a larger request.",
    "Combine their work into ONE coherent, complete answer to the original request.",
    "Remove duplication, order it sensibly, and keep every concrete detail. Do not report on the process.",
    "",
    "ORIGINAL REQUEST",
    task,
    "",
    "SUBTASK RESULTS",
    body,
  ].join("\n")
}

export function refinePrompt(task: string, previous: string, role: string): string {
  return [
    `You are "${role}", a stage in a relay of AI models improving one answer to a request.`,
    "Take the current draft and improve it: fix errors, fill gaps, tighten the prose.",
    "Return the improved answer only. No preamble, no notes about what you changed.",
    "",
    "REQUEST",
    task,
    "",
    "CURRENT DRAFT",
    previous,
  ].join("\n")
}

export function judgePrompt(task: string, answers: Array<{ role: string; text: string }>): string {
  const body = answers
    .map((entry, index) => `--- candidate ${index + 1} (${entry.role}) ---\n${entry.text}`)
    .join("\n\n")
  return [
    "You are the judge for a panel of AI models that each answered the same request.",
    "Pick the strongest answer, or merge the best parts if several are complementary.",
    'Reply with JSON only: {"winner": <candidate number or 0 if merged>, "confidence": <0-100>, "rationale": "one sentence", "answer": "the final answer text"}',
    "",
    "REQUEST",
    task,
    "",
    "CANDIDATES",
    body,
  ].join("\n")
}

/** Pulls the first JSON object out of a model response that may be wrapped in prose or fences. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], trimmed].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

export function trim(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated, ${text.length - max} more characters]`
}
