/**
 * Talking to a bot = prompting the bot's own persistent session, which lives
 * in the bot's working directory and uses the bot's agent. Everything here is
 * written against a narrow SessionPort so it can be tested without a host.
 */
import type { BotStore } from "./store.js"
import type { BotConfig } from "./types.js"

export interface SessionPort {
  create(input: any): Promise<any>
  get(input: { sessionID: string }): Promise<any>
  prompt(input: any): Promise<any>
  wait(input: { sessionID: string }): Promise<unknown>
  context(input: { sessionID: string }): Promise<any[]>
  interrupt(input: { sessionID: string }): Promise<unknown>
}

export interface Reply {
  /** True once the session went idle after our message. */
  done: boolean
  outcome?: string
  error?: string
  /** The last assistant text produced since our message. */
  text: string
  /** Number of assistant messages produced (model steps). */
  steps: number
}

const textOf = (m: any): string =>
  Array.isArray(m?.content)
    ? m.content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("")
    : typeof m?.text === "string"
      ? m.text
      : ""

/** Reads what happened in `messages` after the message `afterId`. */
export function extractReply(messages: any[], afterId: string): Reply {
  const i = messages.findIndex((m) => m?.id === afterId)
  const tail = i >= 0 ? messages.slice(i + 1) : messages.filter((m) => typeof m?.id === "string" && m.id > afterId)
  const idle = tail.find((m) => m?.type === "idle")
  const assistants = tail.filter((m) => m?.type === "assistant")
  const withText = [...assistants].reverse().find((m) => textOf(m).trim())
  return {
    done: Boolean(idle),
    outcome: idle?.outcome,
    error: idle?.error?.message,
    text: withText ? textOf(withText).trim() : "",
    steps: assistants.length,
  }
}

export interface HistoryItem {
  type: string
  text?: string
  tools?: string[]
  outcome?: string
  error?: string
  at?: number
}

/** Compact, model-friendly view of the last `limit` messages. */
export function summarizeMessages(messages: any[], limit: number, maxChars = 400): HistoryItem[] {
  const clip = (s: string) => (s.length > maxChars ? s.slice(0, maxChars) + "…" : s)
  return messages.slice(-limit).map((m): HistoryItem => {
    const at = m?.time?.created
    if (m?.type === "user") return { type: "user", text: clip(String(m.text ?? "")), at }
    if (m?.type === "idle") return { type: "idle", outcome: m.outcome, ...(m.error?.message ? { error: m.error.message } : {}), at }
    if (m?.type === "assistant") {
      const tools = Array.isArray(m.content)
        ? m.content.filter((p: any) => p?.type && p.type !== "text" && p.type !== "reasoning").map((p: any) => String(p.name ?? p.tool ?? p.type))
        : []
      const text = textOf(m)
      return { type: "assistant", ...(text ? { text: clip(text) } : {}), ...(tools.length ? { tools } : {}), at }
    }
    return { type: String(m?.type ?? "unknown"), at }
  })
}

/** Returns the id of the bot's live session, creating one in its workdir if needed. */
export async function ensureSession(
  port: SessionPort,
  store: BotStore,
  bot: BotConfig,
  opts: { fresh?: boolean } = {},
): Promise<string> {
  const state = store.readState(bot.name)
  if (state.sessionID && !opts.fresh) {
    try {
      const s = await port.get({ sessionID: state.sessionID })
      const dir = s?.location?.directory
      if (!dir || dir === bot.workdir) return state.sessionID
    } catch {
      /* session was deleted: fall through and create a new one */
    }
  }
  const s = await port.create({
    agent: bot.name,
    title: `bot:${bot.name}`,
    location: { directory: bot.workdir },
    metadata: { openbot: { bot: bot.name } },
  })
  store.writeState(bot.name, { sessionID: s.id, sessionCreatedAt: new Date().toISOString() })
  return s.id as string
}

export interface SayOptions {
  /** Wait for the bot to finish and return its answer (default true). */
  wait?: boolean
  timeoutMs?: number
  /** Start a new conversation instead of continuing the existing one. */
  fresh?: boolean
  /** Aborting interrupts the bot's current run. */
  signal?: AbortSignal
  pollMs?: number
}

export interface SayResult {
  sessionID: string
  status: "started" | "done" | "failed" | "timeout" | "interrupted"
  text: string
  error?: string
  steps?: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function say(port: SessionPort, store: BotStore, bot: BotConfig, message: string, opts: SayOptions = {}): Promise<SayResult> {
  const sessionID = await ensureSession(port, store, bot, { fresh: opts.fresh })
  const sent = await port.prompt({ sessionID, text: message, delivery: "queue" })
  if (opts.wait === false) return { sessionID, status: "started", text: "" }

  const deadline = Date.now() + (opts.timeoutMs ?? 300_000)
  const pollMs = opts.pollMs ?? 400
  let aborted = false
  const onAbort = () => {
    aborted = true
    void port.interrupt({ sessionID }).catch(() => {})
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    while (Date.now() < deadline) {
      if (aborted) return { sessionID, status: "interrupted", text: "" }
      const left = deadline - Date.now()
      await Promise.race([port.wait({ sessionID }).catch(() => {}), sleep(Math.min(left, 5_000))])
      const reply = extractReply(await port.context({ sessionID }), sent.id)
      if (reply.done) {
        const failed = reply.outcome === "failed"
        return {
          sessionID,
          status: failed ? "failed" : "done",
          text: reply.text,
          steps: reply.steps,
          ...(failed ? { error: reply.error ?? "the run failed" } : {}),
        }
      }
      await sleep(pollMs)
    }
    return { sessionID, status: "timeout", text: "" }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort)
  }
}
