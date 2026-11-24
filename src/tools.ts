/**
 * The bot_* tools: how users (through any agent) and bots themselves create,
 * configure, inspect and talk to bots. All are native tools (not Code Mode),
 * so any model can call them directly.
 */
import { exportToFile, importFromFile } from "./bundle.js"
import { ensureSession, say, summarizeMessages, type SessionPort } from "./session-io.js"
import type { BotStore } from "./store.js"
import { BotError, type BotConfig, type BotPatch } from "./types.js"
import { expandPath } from "./paths.js"

export interface ToolDeps {
  store: BotStore
  session: SessionPort
  /** Re-applies bot definitions to the host after a change. */
  reload: () => Promise<void>
}

export interface ToolContextLike {
  agent: string
  sessionID: string
}

export interface ToolDef {
  name: string
  description: string
  input: Record<string, unknown>
  options: { codemode: false }
  execute: (input: any, ctx: ToolContextLike) => Promise<{ content: string; metadata?: Record<string, unknown> }>
}

/** Bots currently blocked waiting on another bot: used to refuse call cycles. */
const waiting = new Set<string>()

const MCP_SCHEMA = {
  type: "object",
  description:
    'MCP servers owned by this bot: { "<name>": { "type": "local", "command": ["cmd","arg"], "environment": {"K":"V"} } | { "type": "remote", "url": "https://…", "headers": {…} } }',
  additionalProperties: true,
}

const str = (description: string) => ({ type: "string", description })

function publicView(bot: BotConfig, store: BotStore) {
  return {
    ...bot,
    dir: store.botDir(bot.name),
    mcps: bot.mcps
      ? Object.fromEntries(Object.entries(bot.mcps).map(([k, v]) => [k, v.type === "local" ? { type: "local", command: v.command } : { type: "remote", url: v.url }]))
      : undefined,
  }
}

const text = (content: string, metadata?: Record<string, unknown>) => ({ content, ...(metadata ? { metadata } : {}) })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))

export function buildTools(deps: ToolDeps): ToolDef[] {
  const { store, session } = deps
  const isBot = (agent: string) => store.exists(agent)

  /** Resolves whom a call targets: explicit name, or the calling bot itself. */
  function target(input: { name?: string }, ctx: ToolContextLike): string {
    const name = input.name ?? (isBot(ctx.agent) ? ctx.agent : undefined)
    if (!name) throw new BotError('Provide "name": which bot?')
    return name
  }

  /** A bot may only touch itself; the user's own agents may touch any bot. */
  function authorizeWrite(name: string, ctx: ToolContextLike): void {
    if (isBot(ctx.agent) && ctx.agent !== name) {
      throw new BotError(`Bot "${ctx.agent}" is not allowed to modify bot "${name}". A bot can only change its own configuration.`)
    }
  }
  function requireHuman(ctx: ToolContextLike, what: string): void {
    if (isBot(ctx.agent)) throw new BotError(`Bots cannot ${what} yet. Ask the user to do it.`)
  }

  const wrap =
    (fn: ToolDef["execute"]): ToolDef["execute"] =>
    async (input, ctx) => {
      try {
        return await fn(input ?? {}, ctx)
      } catch (e) {
        if (e instanceof BotError) return text(`Error: ${e.message}`, { error: true })
        return text(`Error: ${(e as Error).message ?? String(e)}`, { error: true })
      }
    }

  const tools: ToolDef[] = [
    {
      name: "bot_list",
      description: "List all bots with their name, description, model and working directory.",
      input: { type: "object", properties: {} },
      options: { codemode: false },
      execute: wrap(async () => {
        const { bots, problems } = store.listWithProblems()
        return json({
          bots: bots.map((b) => ({ name: b.name, description: b.description, model: b.model ?? "(default)", workdir: b.workdir })),
          ...(problems.length ? { invalid: problems } : {}),
        })
      }),
    },
    {
      name: "bot_get",
      description:
        "Show a bot's full configuration (instructions, model, workdir, skills, MCP servers) and its conversation stats. Without a name, shows the calling bot itself.",
      input: { type: "object", properties: { name: str("Bot name (optional when called by a bot: defaults to itself)") } },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const bot = store.require(target(input, ctx))
        const state = store.readState(bot.name)
        let conversation: unknown = { sessionID: null }
        if (state.sessionID) {
          try {
            const s = await session.get({ sessionID: state.sessionID })
            conversation = { sessionID: s.id, title: s.title, directory: s.location?.directory, tokens: s.tokens, cost: s.cost, updated: s.time?.updated }
          } catch {
            conversation = { sessionID: state.sessionID, note: "session no longer exists; a new one is created on next message" }
          }
        }
        return json({ ...publicView(bot, store), conversation })
      }),
    },
    {
      name: "bot_create",
      description:
        "Create a bot: a named agent with a role (instructions), a model, a working directory, optional skills allowlist and MCP servers. Afterwards it can be addressed with @name or bot_say.",
      input: {
        type: "object",
        properties: {
          name: str('Lowercase id, e.g. "scout" or "crm-bot" (2-32 chars: a-z, 0-9, dashes)'),
          instructions: str("The bot's master prompt: its role, goal and rules"),
          description: str("One line: what the bot is for"),
          model: str('Model as "provider/model" (omit to use the default model)'),
          workdir: str("Directory where the bot works (default: a private workspace inside the bot folder)"),
          skills: { type: "array", items: { type: "string" }, description: "Allowlist of skill names the bot may use. Omit for no restriction; [] for none." },
          mcps: MCP_SCHEMA,
        },
        required: ["name", "instructions"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        requireHuman(ctx, "create other bots")
        const bot = store.create({ ...input, ...(input.workdir ? { workdir: expandPath(input.workdir) } : {}) })
        await deps.reload()
        return text(
          `Bot "${bot.name}" created.\nworkdir: ${bot.workdir}\nmodel: ${bot.model ?? "(default)"}\nTalk to it with @${bot.name} or the bot_say tool; change it with bot_update.`,
          { bot: bot.name },
        )
      }),
    },
    {
      name: "bot_update",
      description:
        "Change a bot's configuration. Only the fields you pass are changed; pass null to clear an optional field. A bot can call this on itself (omit name) to reconfigure itself; it cannot modify other bots.",
      input: {
        type: "object",
        properties: {
          name: str("Bot to change (omit to change yourself)"),
          instructions: str("New master prompt (replaces the old one entirely)"),
          description: { type: ["string", "null"], description: "New description, or null to clear" },
          model: { type: ["string", "null"], description: 'New model "provider/model", or null for the default' },
          workdir: str("New working directory (a new conversation is started there)"),
          skills: { type: ["array", "null"], items: { type: "string" }, description: "New skills allowlist, [] for none, null for unrestricted" },
          mcps: { ...MCP_SCHEMA, type: ["object", "null"] },
        },
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const name = target(input, ctx)
        authorizeWrite(name, ctx)
        const { name: _n, ...rest } = input
        const patch = rest as BotPatch
        if (!Object.keys(patch).length) throw new BotError("Nothing to change: pass at least one field.")
        if (patch.workdir) patch.workdir = expandPath(patch.workdir)
        const before = store.require(name)
        const bot = store.update(name, patch)
        await deps.reload()
        const changed = Object.keys(patch)
        const note = patch.workdir && patch.workdir !== before.workdir ? " Its working directory changed, so its next message starts a new conversation." : ""
        return text(`Bot "${bot.name}" updated (${changed.join(", ")}). The change applies to its next message.${note}`)
      }),
    },
    {
      name: "bot_delete",
      description: "Delete a bot: its configuration, state and local skills. Its working directory is kept if you chose a custom one. Requires confirm: true.",
      input: {
        type: "object",
        properties: { name: str("Bot to delete"), confirm: { type: "boolean", description: "Must be true" } },
        required: ["name", "confirm"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        requireHuman(ctx, "delete bots")
        if (input.confirm !== true) throw new BotError("Refusing to delete without confirm: true.")
        const bot = store.delete(input.name)
        await deps.reload()
        return text(`Bot "${bot.name}" deleted. Its working directory ${bot.workdir} was not touched.`)
      }),
    },
    {
      name: "bot_say",
      description:
        "Send a message to a bot and get its answer. The bot works in its own working directory, in its own persistent conversation (it remembers earlier messages). Use wait:false to let it work in the background.",
      input: {
        type: "object",
        properties: {
          name: str("Bot to talk to"),
          message: str("What to tell the bot"),
          wait: { type: "boolean", description: "Wait for the answer (default true). false = fire and forget." },
          timeout_seconds: { type: "number", description: "Max seconds to wait (default 300)" },
          new_conversation: { type: "boolean", description: "Start a fresh conversation instead of continuing" },
        },
        required: ["name", "message"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const bot = store.require(input.name)
        if (typeof input.message !== "string" || !input.message.trim()) throw new BotError("message must not be empty")
        const caller = isBot(ctx.agent) ? ctx.agent : undefined
        if (caller === bot.name) throw new BotError("A bot cannot send messages to itself.")
        if (waiting.has(bot.name)) throw new BotError(`"${bot.name}" is waiting on another bot: refusing a call cycle.`)
        const wait = input.wait !== false
        if (caller && wait) waiting.add(caller)
        try {
          const r = await say(session, store, bot, input.message, {
            wait,
            fresh: input.new_conversation === true,
            timeoutMs: (typeof input.timeout_seconds === "number" ? input.timeout_seconds : 300) * 1000,
          })
          const meta = { bot: bot.name, sessionID: r.sessionID, status: r.status }
          if (r.status === "started") return text(`Message sent to ${bot.name}; it is working in the background (conversation ${r.sessionID}).`, meta)
          if (r.status === "timeout") return text(`${bot.name} is still working after the timeout. Check later with bot_history.`, meta)
          if (r.status === "failed") return text(`${bot.name} failed: ${r.error}`, { ...meta, error: true })
          return text(r.text || `(${bot.name} finished without a text answer; see bot_history)`, meta)
        } finally {
          if (caller && wait) waiting.delete(caller)
        }
      }),
    },
    {
      name: "bot_history",
      description: "Inspect a bot's recent conversation: what it was asked, what it answered, which tools it used.",
      input: {
        type: "object",
        properties: { name: str("Bot (omit for yourself)"), limit: { type: "number", description: "How many recent messages (default 12, max 50)" } },
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const bot = store.require(target(input, ctx))
        const sessionID = store.readState(bot.name).sessionID
        if (!sessionID) return text(`${bot.name} has no conversation yet.`)
        const limit = Math.min(Math.max(Number(input.limit) || 12, 1), 50)
        const items = summarizeMessages(await session.context({ sessionID }), limit)
        return json({ bot: bot.name, sessionID, messages: items })
      }),
    },
    {
      name: "bot_export",
      description: "Export a bot (config + local skills) to a portable JSON bundle file. MCP secrets are redacted unless include_secrets is true.",
      input: {
        type: "object",
        properties: { name: str("Bot to export"), path: str("Target file (default: <openbot home>/exports/<name>.openbot.json)"), include_secrets: { type: "boolean" } },
        required: ["name"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        requireHuman(ctx, "export bots")
        const r = exportToFile(store, input.name, input.path ? expandPath(input.path) : undefined, { includeSecrets: input.include_secrets === true })
        return text(`Exported "${input.name}" to ${r.path}${r.bundle.warnings.length ? "\nWarnings:\n- " + r.bundle.warnings.join("\n- ") : ""}`)
      }),
    },
    {
      name: "bot_import",
      description: "Import a bot from a bundle file made by bot_export. Use rename to import under another name, overwrite to replace an existing bot.",
      input: {
        type: "object",
        properties: {
          path: str("Bundle file to import"),
          rename: str("Import under this name"),
          overwrite: { type: "boolean" },
          workdir: str("Working directory on this machine"),
        },
        required: ["path"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        requireHuman(ctx, "import bots")
        const { bot, warnings } = importFromFile(store, expandPath(input.path), {
          rename: input.rename,
          overwrite: input.overwrite === true,
          workdir: input.workdir ? expandPath(input.workdir) : undefined,
        })
        await deps.reload()
        return text(`Imported bot "${bot.name}" (workdir ${bot.workdir}).${warnings.length ? "\nWarnings:\n- " + warnings.join("\n- ") : ""}`, { bot: bot.name })
      }),
    },
  ]
  return tools
}

export { ensureSession }
