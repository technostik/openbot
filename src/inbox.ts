/**
 * The bot's outbox to the user: alerts and notes the bot wants you to see.
 * One small JSON file per bot (inbox.json). Delivery channels (TUI toast and
 * notification now, Telegram later) all read this same file.
 */
import fs from "node:fs"
import path from "node:path"
import type { BotStore } from "./store.js"

export type InboxLevel = "info" | "attention"
export type InboxStatus = "open" | "read" | "dismissed" | "answered"

export interface InboxItem {
  id: string
  at: string
  level: InboxLevel
  title?: string
  message: string
  /** The conversation where the bot raised it (open it to see context, reply there). */
  sessionID?: string
  status: InboxStatus
  answer?: string
  answeredAt?: string
}

const MAX_ITEMS = 200
const file = (store: BotStore, bot: string) => path.join(store.botDir(bot), "inbox.json")

export function readInbox(store: BotStore, bot: string): InboxItem[] {
  try {
    const j = JSON.parse(fs.readFileSync(file(store, bot), "utf8")) as { items?: InboxItem[] }
    return Array.isArray(j.items) ? j.items : []
  } catch {
    return []
  }
}

function write(store: BotStore, bot: string, items: InboxItem[]): void {
  const f = file(store, bot)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify({ items: items.slice(-MAX_ITEMS) }, null, 2) + "\n", "utf8")
  fs.renameSync(tmp, f)
}

export function addInboxItem(store: BotStore, bot: string, input: { level: InboxLevel; message: string; title?: string; sessionID?: string }): InboxItem {
  store.require(bot)
  const item: InboxItem = {
    id: `ibx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    level: input.level,
    message: input.message.trim(),
    status: "open",
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
  }
  write(store, bot, [...readInbox(store, bot), item])
  return item
}

export function updateInboxItem(store: BotStore, bot: string, id: string, patch: Partial<Pick<InboxItem, "status" | "answer">>): InboxItem | undefined {
  const items = readInbox(store, bot)
  const i = items.findIndex((x) => x.id === id)
  if (i < 0) return undefined
  items[i] = { ...items[i]!, ...patch, ...(patch.answer !== undefined ? { answeredAt: new Date().toISOString() } : {}) }
  write(store, bot, items)
  return items[i]
}

export const openItems = (store: BotStore, bot: string): InboxItem[] => readInbox(store, bot).filter((x) => x.status === "open")
