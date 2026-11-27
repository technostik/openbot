/**
 * Every conversation with a bot is recorded, append-only, in the bot's own
 * folder: history/<sessionID>.jsonl plus history/index.json. It does not depend
 * on opencode's database (sessions can be deleted or compacted; this record stays).
 */
import fs from "node:fs"
import path from "node:path"
import type { SessionPort } from "./session-io.js"
import type { BotStore } from "./store.js"

export interface HistoryMeta {
  thread?: string
  parentID?: string
  startedAt: string
  lastAt: string
  /** Id of the last recorded message: where the next sync resumes. */
  cursor?: string
  count: number
}

const MAX_STRING = 20_000
const dir = (store: BotStore, bot: string) => path.join(store.botDir(bot), "history")
const indexFile = (store: BotStore, bot: string) => path.join(dir(store, bot), "index.json")
export const historyFile = (store: BotStore, bot: string, sessionID: string) => path.join(dir(store, bot), `${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`)

function clip(v: unknown): unknown {
  if (typeof v === "string") return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + `… [clipped ${v.length - MAX_STRING} chars]` : v
  if (Array.isArray(v)) return v.map(clip)
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]))
  return v
}

export function readIndex(store: BotStore, bot: string): Record<string, HistoryMeta> {
  try {
    return JSON.parse(fs.readFileSync(indexFile(store, bot), "utf8")) as Record<string, HistoryMeta>
  } catch {
    return {}
  }
}

function writeIndex(store: BotStore, bot: string, idx: Record<string, HistoryMeta>): void {
  fs.mkdirSync(dir(store, bot), { recursive: true })
  const f = indexFile(store, bot)
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2) + "\n", "utf8")
  fs.renameSync(tmp, f)
}

/** Appends the messages of `sessionID` that were not recorded yet. Returns how many were added. */
export async function syncHistory(port: Pick<SessionPort, "context">, store: BotStore, bot: string, sessionID: string, meta: { thread?: string; parentID?: string } = {}): Promise<number> {
  const messages = await port.context({ sessionID })
  if (!Array.isArray(messages) || !messages.length) return 0
  const idx = readIndex(store, bot)
  const cur = idx[sessionID]
  let fresh = messages
  if (cur?.cursor) {
    const at = messages.findIndex((m) => m?.id === cur.cursor)
    fresh = at >= 0 ? messages.slice(at + 1) : messages.filter((m) => typeof m?.id === "string" && m.id > cur.cursor!)
  }
  if (!fresh.length) return 0
  fs.mkdirSync(dir(store, bot), { recursive: true })
  fs.appendFileSync(historyFile(store, bot, sessionID), fresh.map((m) => JSON.stringify(clip(m))).join("\n") + "\n", "utf8")
  const now = new Date().toISOString()
  const last = [...fresh].reverse().find((m) => typeof m?.id === "string")
  idx[sessionID] = {
    thread: meta.thread ?? cur?.thread,
    parentID: meta.parentID ?? cur?.parentID,
    startedAt: cur?.startedAt ?? now,
    lastAt: now,
    cursor: last?.id ?? cur?.cursor,
    count: (cur?.count ?? 0) + fresh.length,
  }
  writeIndex(store, bot, idx)
  return fresh.length
}

export function readRecorded(store: BotStore, bot: string, sessionID: string): any[] {
  try {
    return fs.readFileSync(historyFile(store, bot, sessionID), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** Recorded conversations, most recently active first. */
export function listRecorded(store: BotStore, bot: string): Array<HistoryMeta & { sessionID: string }> {
  return Object.entries(readIndex(store, bot))
    .map(([sessionID, m]) => ({ sessionID, ...m }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

const when = (t: unknown) => (typeof t === "number" ? new Date(t).toISOString().replace("T", " ").slice(0, 19) : typeof t === "string" ? t.replace("T", " ").slice(0, 19) : "")
const short = (v: unknown, n = 300) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "")
  return s.length > n ? s.slice(0, n) + "…" : s
}

/** Plain-text transcript of recorded messages, for reading in the TUI or a file. */
export function renderTranscript(messages: any[]): string {
  const out: string[] = []
  for (const m of messages) {
    const t = when(m?.time?.created)
    if (m?.type === "user") out.push(`── ${t} · you / caller`, String(m.text ?? ""), "")
    else if (m?.type === "assistant") {
      out.push(`── ${t} · bot`)
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p?.type === "text") out.push(String(p.text ?? ""))
        else if (p?.type === "reasoning") continue
        else out.push(`  [${p?.name ?? p?.tool ?? p?.type}] ${short(p?.input ?? p?.args ?? "")}${p?.output !== undefined || p?.result !== undefined ? " → " + short(p.output ?? p.result, 200) : ""}`)
      }
      out.push("")
    } else if (m?.type === "idle") out.push(`── run ${m.outcome ?? "ended"}${m.error?.message ? ": " + m.error.message : ""}`, "")
    else if (m?.type) out.push(`── ${m.type}`, "")
  }
  return out.join("\n").trimEnd()
}
