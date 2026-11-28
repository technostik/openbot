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
import { isAuditableTool, recordAudit } from "./audit.js"
import { MARKER_AGENT } from "./constants.js"
import { reconcile, type NativeAutomations } from "./automation.js"
import { createDebugLog } from "./debug/log.js"
import { debugEnabled } from "./debug/enabled.js"
import { applyAgents, applyWorkdirMcp, applyWorkdirSkills, newOwned } from "./host.js"
import { syncHistory } from "./history.js"
import { buildStateContext } from "./memory.js"
import { delegationText, findMention } from "./mention.js"
import { resolveRoot } from "./paths.js"
import { ensureSession } from "./session-io.js"
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

    // Native opencode automations (2.4+), kept in step with bot.json and each bot's status.
    const nativeApi = (ctx as any).experimental?.automation
    const unwrap = (o: any): any[] => (Array.isArray(o) ? o : Array.isArray(o?.data) ? o.data : [])
    const native: NativeAutomations | undefined =
      nativeApi && options?.automations !== false
        ? {
            list: async () => unwrap(await nativeApi.list()),
            create: (input) => nativeApi.create(input),
            remove: async (id) => void (await nativeApi.delete({ automationID: id })),
          }
        : undefined
    const reconcileAutomations = async () => {
      if (!native) return { created: [], removed: [], kept: [], errors: [] }
      return reconcile({ store, native, log, ensureAutoSession: async (bot) => (await ensureSession(ctx.session as any, store, bot, { key: "auto" })).sessionID })
    }
    if (native) void reconcileAutomations().catch((e) => log("automation-error", String(e)))

    // Optional debug tools live in their own module and are only loaded when switched on.
    let tools: ToolDef[] = buildTools({ store, service, session: ctx.session as any, reload, automation: native ? { native, reconcile: reconcileAutomations } : undefined })
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

    // Audit the sensitive tools a bot uses: MCP servers and third-party plugin
    // tools. bot_say records itself (it is a bot_* tool, excluded here).
    disposers.push(
      await ctx.tool.hook("execute.after", async (e) => {
        if (!store.exists(e.agent) || !isAuditableTool(e.tool)) return
        await recordAudit(store, e.agent, {
          tool: e.tool,
          sessionID: e.sessionID,
          ...(e.codemode ? { codemode: true } : {}),
          ...(e.status === "error" ? { detail: e.error?.message ? `failed: ${e.error.message}` : "failed" } : {}),
        })
      }),
    )

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

    // The bot always sees its own state: injected into its system prompt on every turn.
    disposers.push(
      await ctx.session.hook("context", (c: any) => {
        if (!store.exists(c.agent)) return
        const block = buildStateContext(store, c.agent)
        if (block) c.system.push({ type: "text", text: block })
      }),
    )

    // Every conversation with a bot is recorded in its folder when its run ends.
    const botOfSession = new Map<string, string | null>()
    const whoseSession = async (sessionID: string): Promise<string | undefined> => {
      for (const b of store.list()) if (store.isBotSession(b.name, sessionID)) return b.name
      if (!botOfSession.has(sessionID)) {
        try {
          const s: any = await ctx.session.get({ sessionID })
          botOfSession.set(sessionID, s?.agent && store.exists(s.agent) ? s.agent : null)
        } catch {
          botOfSession.set(sessionID, null)
        }
      }
      return botOfSession.get(sessionID) ?? undefined
    }
    disposers.push(
      await ctx.session.hook("experimental.idle", async (p: any) => {
        try {
          const name = await whoseSession(p.sessionID)
          if (!name) return
          const thread = store.listThreads(name).find((t) => t.sessionID === p.sessionID)
          const n = await syncHistory(ctx.session as any, store, name, p.sessionID, { thread: thread?.key, parentID: thread?.parentID })
          if (n) log("history", { bot: name, session: p.sessionID, added: n })
        } catch (e) {
          log("history-error", String(e))
        }
      }),
    )

    // Hand edits of bot.json / system.md (or edits from another process) are picked up here.
    let signature = store.signature()
    const timer = setInterval(() => {
      const now = store.signature()
      if (now === signature) return
      signature = now
      log("change-detected")
      void reload()
        .then(() => reconcileAutomations())
        .catch((e) => log("reload-error", String(e)))
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
