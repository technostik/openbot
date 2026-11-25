/** Optional debug log: JSON lines in <openbot home>/logs/openbot.log, size-capped. */
import fs from "node:fs"
import path from "node:path"

export type DebugLog = ((event: string, data?: unknown) => void) & { enabled: boolean; file: string }

const MAX_BYTES = 1_000_000

export function createDebugLog(root: string, enabled: boolean, where = ""): DebugLog {
  const file = path.join(root, "logs", "openbot.log")
  const fn = ((event: string, data?: unknown) => {
    if (!enabled) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + ".1")
      } catch {
        /* no log yet */
      }
      fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, where, event, data }) + "\n")
    } catch {
      /* logging must never break the plugin */
    }
  }) as DebugLog
  fn.enabled = enabled
  fn.file = file
  return fn
}

export function tailLog(root: string, lines = 80): string[] {
  try {
    return fs.readFileSync(path.join(root, "logs", "openbot.log"), "utf8").trimEnd().split("\n").slice(-lines)
  } catch {
    return []
  }
}
