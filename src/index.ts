/**
 * openbot — named, configurable bots for opencode.
 *
 * A bot is a directory on disk (bot.json + system.md + local skills + state)
 * that this plugin projects into opencode as an agent (model + master prompt),
 * a native agent file in the bot's working directory, persistent conversations
 * that appear as child sessions of where the bot was used, optional MCP
 * servers and skills, and bot_* tools to create, configure, inspect and talk to bots.
 */
import type { Plugin } from "@opencode/plugin"
import { MARKER_AGENT } from "./constants.js"
import { createDebugLog } from "./debug/log.js"
import { debugEnabled } from "./debug/enabled.js"
import { applyAgents, applyWorkdirMcp, applyWorkdirSkills, newOwned } from "./host.js"
import { delegationText, findMention } from "./mention.js"
import { resolveRoot } from "./paths.js"
import { makeService, syncAll } from "./service.js"
import { BotStore } from "./store.js"
import { buildTools, type ToolDef } from "./tools.js"
import { VERSION } from "./version.js"

const POLL_MS = 2000

const openbot: Plugin.Plugin = {
  id: "openbot",
  setup: async (ctx) => {
    const options = ctx.options as Record<string, unknown> | undefined
    const root = resolveRoot(options)
    const location = ctx.location.directory as string
    const debug = debugEnabled(options)
    const log = createDebugLog(root, debug, location)
    const store = new BotStore(root)
    const service = makeService(store, { materialize: options?.materialize !== false, log })
    const owned = newOwned()
    const env = { skillsDir: (name: string) => store.skillsDir(name), systemFile: (name: string) => store.systemPath(name), log: (m: string) => log("agents", m) }
    const disposers: Array<{ dispose: () => unknown }> = []
    log("setup", { version: VERSION, location, root, debug, materialize: service.materialize })

    const synced = syncAll(service)
    if (synced.migrated.length) log("migrated", synced.migrated)

    disposers.push(
      await ctx.agent.transform((ed: any) => {
        ed.update(MARKER_AGENT, (a: any) => {
          a.name = MARKER_AGENT
          a.description = "openbot is loaded in this directory (internal marker)"
          a.mode = "subagent"
          a.hidden = true
        })
        applyAgents(ed, store.list(), owned, env)
      }),
    )
    disposers.push(await ctx.mcp.transform((ed: any) => applyWorkdirMcp(location, store.list(), ed, owned)))
    disposers.push(await ctx.skill.transform((ed: any) => applyWorkdirSkills(location, store.list(), ed, owned, env)))

    const reload = async () => {
      syncAll(service)
      await ctx.agent.reload()
      await ctx.mcp.reload()
      await ctx.skill.reload()
      log("reload", { bots: store.list().map((b) => b.name) })
    }

    // Optional debug tools live in their own module and are only loaded when switched on.
    let tools: ToolDef[] = buildTools({ store, service, session: ctx.session as any, reload })
    if (debug) {
      const { buildDebugTools } = await import("./debug/tools.js")
      tools = [...tools, ...buildDebugTools({ ctx, store, version: VERSION, options, materializeEnabled: service.materialize })]
    }
    if (debug) {
      tools = tools.map((t) => ({
        ...t,
        execute: async (input: any, tctx: any) => {
          const t0 = Date.now()
          const r = await t.execute(input, tctx)
          log("tool", { tool: t.name, agent: tctx.agent, session: tctx.sessionID, ms: Date.now() - t0, error: Boolean(r.metadata?.error), input: JSON.stringify(input ?? {}).slice(0, 300), result: r.content.slice(0, 200) })
          return r
        },
      }))
    }
    disposers.push(await ctx.tool.transform((ed: any) => { for (const tool of tools) ed.add(tool) }))

    // `@bot ...` in the user's prompt becomes an instruction to hand the message to the bot.
    disposers.push(
      await ctx.session.hook("prompt", (p: any) => {
        const mention = findMention(p.prompt, (n) => store.exists(n))
        if (!mention) return
        if (store.isBotSession(mention.bot, p.sessionID)) return // already inside the bot's own conversation
        p.prompt.text = delegationText(mention)
        p.metadata = { ...(p.metadata ?? {}), openbot: { mention: mention.bot } }
        log("mention", { bot: mention.bot, session: p.sessionID })
      }),
    )

    // Hand edits of bot.json / system.md (or edits from another process) are picked up here.
    let signature = store.signature()
    const timer = setInterval(() => {
      const now = store.signature()
      if (now === signature) return
      signature = now
      log("change-detected")
      void reload().catch((e) => log("reload-error", String(e)))
    }, POLL_MS)
    timer.unref?.()

    return async () => {
      clearInterval(timer)
      for (const d of disposers) await d.dispose()
      log("cleanup")
    }
  },
}

export default openbot
