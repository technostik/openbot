/** Debug-only tools. Loaded lazily by index.ts, only when the debug switch is on. */
import { say } from "../session-io.js"
import type { BotStore } from "../store.js"
import type { ToolDef } from "../tools.js"
import { BotError } from "../types.js"
import { diagnose, renderChecks } from "./diagnose.js"
import { buildReport, writeReport } from "./report.js"
import { serverDiagEnv } from "./server-env.js"

export interface DebugToolDeps {
  ctx: any
  store: BotStore
  version: string
  options?: Record<string, unknown>
  materializeEnabled: boolean
}

export function buildDebugTools(deps: DebugToolDeps): ToolDef[] {
  const { ctx, store } = deps
  const env = () => serverDiagEnv(ctx, { store, pluginVersion: deps.version, options: deps.options, materializeEnabled: deps.materializeEnabled })
  return [
    {
      name: "bot_diagnose",
      description:
        "Check that everything bots need is configured (model, master prompt, working directory, agent, permissions, skills, MCP, audit, last run) and explain how to fix what is not. With ping:true it also sends a real test message to the bot. With report:true it writes a full markdown report and returns its path.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "Only this bot (omit for everything)" },
          ping: { type: "boolean", description: "Send a real test message to the bot (uses its model once)" },
          report: { type: "boolean", description: "Also write a full report file" },
        },
      },
      options: { codemode: false },
      execute: async (input) => {
        try {
          const only = typeof input?.name === "string" ? input.name : undefined
          const result = await diagnose(env(), only)
          const parts = [renderChecks(result)]
          if (input?.ping) {
            if (!only) throw new BotError("ping needs a bot name")
            const bot = store.require(only)
            const r = await say(ctx.session, store, bot, "Diagnostic ping from openbot. Reply with the single word OK.", { key: "diagnose", fresh: true, timeoutMs: 90_000 })
            parts.push("", `[ping] ${r.status}${r.text ? ": " + r.text.slice(0, 200) : ""}${r.error ? " — " + r.error : ""} (conversation ${r.sessionID})`)
          }
          if (input?.report) {
            const { markdown } = await buildReport(env(), { bot: only })
            parts.push("", `Report written: ${writeReport(store.root, markdown)}`)
          }
          return { content: parts.join("\n"), metadata: { ok: result.ok } }
        } catch (e) {
          return { content: `Error: ${(e as Error).message}`, metadata: { error: true } }
        }
      },
    },
  ]
}
