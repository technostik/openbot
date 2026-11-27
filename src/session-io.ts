/**
 * Talking to a bot = prompting the bot's own persistent session, which lives
 * in the bot's working directory and uses the bot's agent. Everything here is
 * written against a narrow SessionPort so it can be tested without a host.
 */
import { syncHistory } from "./history.js"
import type { BotStore } from "./store.js"
import type { BotConfig } from "./types.js"

export interface SessionPort {
  list?(input?: any): Promise<any>
  create(input: any): Promise<any>
  /** Relocates a session to another directory (applies from its next run). */
  move?(input: { sessionID: string; directory: string }): Promise<unknown>
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

/** The thread key for a caller: its own conversation, or "main" when there is none. */
export const threadKey = (callerSessionID?: string): string => callerSessionID || "main"

/**
 * Returns the id of the bot's conversation for this caller, creating it in the
 * bot's workdir if needed. The conversation is created as a child of the
 * calling session so it appears under it in the UI.
 */
export async function ensureSession(
  port: SessionPort,
  store: BotStore,
  bot: BotConfig,
  opts: { fresh?: boolean; callerSessionID?: string; key?: string } = {},
): Promise<{ sessionID: string; key: string; created: boolean; parented: boolean }> {
  const key = opts.key ?? threadKey(opts.callerSessionID)
  const existing = store.readThreads(bot.name)[key]
  if (existing && !opts.fresh) {
    try {
      const s = await port.get({ sessionID: existing.sessionID })
      // A child session reports its old location until it next runs, so trust what we recorded at creation.
      const dir = existing.workdir ?? s?.location?.directory
      if (!dir || dir === bot.workdir) return { sessionID: existing.sessionID, key, created: false, parented: Boolean(s?.parentID) }
    } catch {
      /* session was deleted: fall through and create a new one */
    }
  }
  const base = {
    agent: bot.name,
    title: `bot:${bot.name}`,
    location: { directory: bot.workdir },
    metadata: { openbot: { bot: bot.name, thread: key, ...(opts.callerSessionID ? { parent: opts.callerSessionID } : {}) } },
  }
  let s: any
  let parented = false
  if (opts.callerSessionID) {
    try {
      // The host puts a child session in its parent's directory, so move it to the bot's workdir
      // before its first run: it then appears under the caller AND works in the bot's own directory.
      s = await port.create({ ...base, parentID: opts.callerSessionID })
      parented = true
      await port.move?.({ sessionID: s.id, directory: bot.workdir })
    } catch {
      if (!parented) s = undefined // the host refused the parent: fall back to a standalone session
    }
  }
  if (!s) s = await port.create(base)
  const now = new Date().toISOString()
  store.setThread(bot.name, key, { sessionID: s.id, ...(opts.callerSessionID ? { parentID: opts.callerSessionID } : {}), workdir: bot.workdir, createdAt: now, lastAt: now })
  return { sessionID: s.id as string, key, created: true, parented }
}

export interface SayOptions {
  /** Wait for the bot to finish and return its answer (default true). */
  wait?: boolean
  timeoutMs?: number
  /** Start a new conversation instead of continuing the existing one. */
  fresh?: boolean
  /** The conversation that is calling the bot (the bot's thread becomes its child). */
  callerSessionID?: string
  /** Use this thread key instead of the caller's (e.g. "diagnose"). */
  key?: string
  /** Aborting interrupts the bot's current run. */
  signal?: AbortSignal
  pollMs?: number
}

export interface SayResult {
  sessionID: string
  thread: string
  status: "started" | "done" | "failed" | "timeout" | "interrupted"
  text: string
  error?: string
  steps?: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function say(port: SessionPort, store: BotStore, bot: BotConfig, message: string, opts: SayOptions = {}): Promise<SayResult> {
  const { sessionID, key } = await ensureSession(port, store, bot, { fresh: opts.fresh, callerSessionID: opts.callerSessionID, key: opts.key })
  const sent = await port.prompt({ sessionID, text: message, delivery: "queue" })
  store.touchThread(bot.name, key)
  if (opts.wait === false) return { sessionID, thread: key, status: "started", text: "" }

  const deadline = Date.now() + (opts.timeoutMs ?? 300_000)
  const pollMs = opts.pollMs ?? 400
  const record = () => syncHistory(port, store, bot.name, sessionID, { thread: key, parentID: opts.callerSessionID }).catch(() => 0)
  let aborted = false
  const onAbort = () => {
    aborted = true
    void port.interrupt({ sessionID }).catch(() => {})
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    while (Date.now() < deadline) {
      if (aborted) return { sessionID, thread: key, status: "interrupted", text: "" }
      const left = deadline - Date.now()
      await Promise.race([port.wait({ sessionID }).catch(() => {}), sleep(Math.min(left, 5_000))])
      const reply = extractReply(await port.context({ sessionID }), sent.id)
      if (reply.done) {
        await record()
        const failed = reply.outcome === "failed"
        return {
          sessionID,
          thread: key,
          status: failed ? "failed" : "done",
          text: reply.text,
          steps: reply.steps,
          ...(failed ? { error: reply.error ?? "the run failed" } : {}),
        }
      }
      await sleep(pollMs)
    }
    await record()
    return { sessionID, thread: key, status: "timeout", text: "" }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort)
  }
}
