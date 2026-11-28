/**
 * A best-effort audit trail of the sensitive tools a bot uses: MCP servers,
 * third-party plugin tools and bot-to-bot messages. One JSON object per line,
 * kept in the bot's own state folder.
 */
import fs from "node:fs"
import path from "node:path"
import type { BotStore } from "./store.js"

export interface AuditEvent {
  /** Tool action as opencode sees it (e.g. "scout-github_create_issue"). */
  tool: string
  sessionID?: string
  /** For bot_say: the bot that received the message. */
  target?: string
  /** True when the tool ran through Code Mode. */
  codemode?: boolean
  /** Free-form note (failure, human caller, ...). */
  detail?: string
}

export interface AuditRecord extends AuditEvent {
  bot: string
  at: string
}

/** Keep at most this many lines when a file is rotated. */
export const MAX_AUDIT_LINES = 1000
/** Rotate once the file grows past this size (a cheap, no-read-on-every-write guard). */
export const AUDIT_ROTATE_BYTES = 256 * 1024

export const auditFile = (store: BotStore, bot: string): string => path.join(store.botDir(bot), "state", "audit.jsonl")

/** Appends one event. Never throws: auditing must not break a tool call. */
export async function recordAudit(store: BotStore, bot: string, event: AuditEvent): Promise<void> {
  try {
    const file = auditFile(store, bot)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const record: AuditRecord = { bot, at: new Date().toISOString(), ...event }
    await fs.promises.appendFile(file, JSON.stringify(record) + "\n", "utf8")
    const st = await fs.promises.stat(file)
    if (st.size > AUDIT_ROTATE_BYTES) await rotateAudit(file)
  } catch {
    /* auditing is best effort */
  }
}

/** Keeps the newest `keep` lines. Exported so tests can exercise rotation directly. */
export async function rotateAudit(file: string, keep = Math.floor(MAX_AUDIT_LINES / 2)): Promise<void> {
  try {
    const lines = (await fs.promises.readFile(file, "utf8")).split("\n").filter(Boolean)
    await fs.promises.writeFile(file, lines.slice(-keep).join("\n") + "\n", "utf8")
  } catch {
    /* best effort */
  }
}

/** Newest first, at most `limit` records. */
export function readAudit(store: BotStore, bot: string, limit = 100): AuditRecord[] {
  try {
    const lines = fs.readFileSync(auditFile(store, bot), "utf8").split("\n").filter(Boolean)
    return lines
      .slice(-limit)
      .reverse()
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as AuditRecord
          return record && typeof record.tool === "string" ? [record] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export function countAudit(store: BotStore, bot: string): number {
  try {
    return fs.readFileSync(auditFile(store, bot), "utf8").split("\n").filter(Boolean).length
  } catch {
    return 0
  }
}

/** Native opencode and openbot tools are not audited; MCP and third-party tools are. */
const NATIVE_TOOLS = new Set([
  "read",
  "edit",
  "write",
  "patch",
  "glob",
  "grep",
  "list",
  "shell",
  "bash",
  "webfetch",
  "websearch",
  "question",
  "subagent",
  "task",
  "skill",
  "generate_image",
  "execute",
  "external_directory",
])

export function isAuditableTool(tool: string): boolean {
  if (!tool) return false
  if (tool.startsWith("bot_")) return false // bot_say is recorded by the tool itself
  if (tool.startsWith("automation_")) return false
  if (tool.startsWith("opencode_")) return false
  return !NATIVE_TOOLS.has(tool)
}
