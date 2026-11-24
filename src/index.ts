/**
 * openbot — named, configurable bots for opencode.
 *
 * A bot is a directory on disk (bot.json + local skills + state) that this
 * plugin projects into opencode as an agent (so it has a model and a master
 * prompt), a persistent session in the bot's working directory, optional MCP
 * servers and skills, and a set of bot_* tools to create, configure, inspect
 * and talk to bots.
 *
 * Every opencode "location" (directory) runs its own copy of this plugin, so
 * install it globally: that way a bot's working directory also knows the bot.
 */
import type { Plugin } from "@opencode/plugin"
import { applyAgents, applyWorkdirMcp, applyWorkdirSkills, newOwned } from "./host.js"
import { delegationText, findMention } from "./mention.js"
import { resolveRoot } from "./paths.js"
import { BotStore } from "./store.js"
import { buildTools } from "./tools.js"

const POLL_MS = 2000

const openbot: Plugin.Plugin = {
  id: "openbot",
  setup: async (ctx) => {
    const store = new BotStore(resolveRoot(ctx.options as Record<string, unknown> | undefined))
    const location = ctx.location.directory as string
    const owned = newOwned()
    const env = { skillsDir: (name: string) => store.skillsDir(name) }
    const disposers: Array<{ dispose: () => unknown }> = []

    disposers.push(await ctx.agent.transform((ed: any) => applyAgents(ed, store.list(), owned, env)))
    disposers.push(await ctx.mcp.transform((ed: any) => applyWorkdirMcp(location, store.list(), ed, owned)))
    disposers.push(await ctx.skill.transform((ed: any) => applyWorkdirSkills(location, store.list(), ed, owned, env)))

    const reload = async () => {
      await ctx.agent.reload()
      await ctx.mcp.reload()
      await ctx.skill.reload()
    }

    disposers.push(
      await ctx.tool.transform((ed: any) => {
        for (const tool of buildTools({ store, session: ctx.session as any, reload })) ed.add(tool)
      }),
    )

    // `@bot ...` in the user's prompt becomes an instruction to hand the message to the bot.
    disposers.push(
      await ctx.session.hook("prompt", (p: any) => {
        const mention = findMention(p.prompt, (n) => store.exists(n))
        if (!mention) return
        if (store.readState(mention.bot).sessionID === p.sessionID) return // already inside the bot's own conversation
        p.prompt.text = delegationText(mention)
        p.metadata = { ...(p.metadata ?? {}), openbot: { mention: mention.bot } }
      }),
    )

    // Hand edits of bot.json (or edits from another instance) are picked up here.
    let signature = store.signature()
    const timer = setInterval(() => {
      const now = store.signature()
      if (now === signature) return
      signature = now
      void reload().catch(() => {})
    }, POLL_MS)
    timer.unref?.()

    return async () => {
      clearInterval(timer)
      for (const d of disposers) await d.dispose()
    }
  },
}

export default openbot
