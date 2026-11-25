import type { BotConfig } from "./types.js"

/** A bot's config as safe to show or share: MCP secrets hidden, prompt omitted (it lives in system.md). */
export function redactBot(bot: BotConfig): unknown {
  const copy: any = JSON.parse(JSON.stringify(bot))
  for (const m of Object.values<any>(copy.mcps ?? {})) {
    for (const f of ["environment", "headers"]) if (m[f]) m[f] = Object.fromEntries(Object.keys(m[f]).map((k) => [k, "<redacted>"]))
  }
  delete copy.instructions
  return copy
}
