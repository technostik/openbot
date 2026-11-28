/**
 * The bot_* tools: how users (through any agent) and bots themselves create,
 * configure, inspect and talk to bots. All are native tools (not Code Mode),
 * so any model can call them directly.
 */
import { recordAudit } from "./audit.js"
import { describeAutomations, isScheduled, standardPrompt, type NativeAutomations, type ReconcileReport } from "./automation.js"
import { exportToFile } from "./bundle.js"
import { describeCapabilities } from "./host.js"
import { readRecorded, renderTranscript, listRecorded, syncHistory } from "./history.js"
import { addInboxItem, openItems } from "./inbox.js"
import { listTree, readInside, renderTree } from "./files.js"
import { inspectMaterialized, agentFilePath } from "./materialize.js"
import { say, summarizeMessages, type SessionPort } from "./session-io.js"
import { createBot, deleteBot, importBot, materializeEnv, updateBot, type Service } from "./service.js"
import type { BotStore } from "./store.js"
import { BotError, BOT_STATUSES, CAPABILITY_PRESETS, type BotConfig, type BotPatch, type BotStatus } from "./types.js"
import { validateAutomations } from "./store.js"
import { expandPath } from "./paths.js"

export interface ToolDeps {
  store: BotStore
  service: Service
  session: SessionPort
  /** Re-applies bot definitions to the host after a change. */
  reload: () => Promise<void>
  /** Native opencode automations (absent when the host has none). */
  automation?: { native: NativeAutomations; reconcile: () => Promise<ReconcileReport> }
}

/** Turns host errors into something that tells the user what to do. */
export function explainError(message: string): string {
  if (/Agent not found/i.test(message)) {
    return `${message}\nThe bot's agent is unknown in its working directory. openbot normally writes <workdir>/.opencode/agents/<bot>.md there; make sure the plugin option materialize is not false, then /reload. (Enable the debug option and run bot_diagnose for details.)`
  }
  return message
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

const AUTOMATIONS_SCHEMA = {
  type: "array",
  description:
    'Scheduled runs: [{ "id": "daily-scan", "every": "6 hours" | "cron": "0 9 * * 1-5" | "at": "in 10 minutes", "prompt": "extra instructions", "enabled": true }]. Exactly one of every/cron/at.',
  items: { type: "object", additionalProperties: true },
}

const CAPABILITIES_SCHEMA = {
  type: "object",
  description:
    'Per-bot permissions. preset: "none" | "minimal" | "standard" | "full" (default "standard"). tools and denyTools hold opencode permission actions (read, edit, shell, glob, grep, webfetch, "bot_*", "<mcp-server>_<tool>", ...; "*" = all). mcps lists the bot\'s MCP server names (keys of mcps, or host names "<bot>-<server>"; "*" = all). Explicit lists override the preset; denyTools always wins.',
  properties: {
    preset: { type: "string", enum: [...CAPABILITY_PRESETS] },
    tools: { type: "array", items: { type: "string" }, description: 'Allowed tool actions; ["*"] = all.' },
    denyTools: { type: "array", items: { type: "string" }, description: "Denied tool actions; wins over tools and the preset." },
    mcps: { type: "array", items: { type: "string" }, description: 'Allowed MCP server names; ["*"] = all.' },
  },
  additionalProperties: true,
}

const str = (description: string) => ({ type: "string", description })

function publicView(bot: BotConfig, store: BotStore) {
  return {
    ...bot,
    dir: store.botDir(bot.name),
    systemPromptFile: store.systemPath(bot.name),
    agentFile: agentFilePath(bot),
    agentFileState: inspectMaterialized(bot, materializeEnv(store)),
    permissions: describeCapabilities(bot),
    mcps: bot.mcps
      ? Object.fromEntries(Object.entries(bot.mcps).map(([k, v]) => [k, v.type === "local" ? { type: "local", command: v.command } : { type: "remote", url: v.url }]))
      : undefined,
  }
}

const text = (content: string, metadata?: Record<string, unknown>) => ({ content, ...(metadata ? { metadata } : {}) })
const json = (v: unknown) => text(JSON.stringify(v, null, 2))

export function buildTools(deps: ToolDeps): ToolDef[] {
  const { store, session, service } = deps
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
        return text(`Error: ${explainError((e as Error).message ?? String(e))}`, { error: true })
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
        "Show a bot's full configuration (instructions, model, workdir, skills, MCP servers, effective permissions) and its conversation stats. Without a name, shows the calling bot itself.",
      input: { type: "object", properties: { name: str("Bot name (optional when called by a bot: defaults to itself)") } },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const bot = store.require(target(input, ctx))
        const threads = store.listThreads(bot.name)
        let tokens: unknown, cost: unknown
        if (threads[0]) {
          try {
            const sess = await session.get({ sessionID: threads[0].sessionID })
            tokens = sess.tokens
            cost = sess.cost
          } catch {
            /* last session no longer exists */
          }
        }
        const recorded = listRecorded(store, bot.name)
        return json({
          ...publicView(bot, store),
          status: bot.status ?? "active",
          stateFile: store.stateFile(bot.name),
          inbox: { open: openItems(store, bot.name).length },
          automations: deps.automation ? await describeAutomations(deps.automation.native, bot) : bot.automations ?? [],
          conversations: { count: threads.length, latest: threads[0]?.sessionID ?? null, latestTokens: tokens, latestCost: cost },
          recordedHistory: { conversations: recorded.length, messages: recorded.reduce((n, r) => n + r.count, 0), dir: `${store.botDir(bot.name)}/history` },
        })
      }),
    },
    {
      name: "bot_create",
      description:
        "Create a bot: a named agent with a role (instructions), a model, a working directory, optional skills allowlist, MCP servers and per-bot permissions. Afterwards it can be addressed with @name or bot_say.",
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
          capabilities: CAPABILITIES_SCHEMA,
          automations: AUTOMATIONS_SCHEMA,
        },
        required: ["name", "instructions"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        requireHuman(ctx, "create other bots")
        const bot = createBot(service, { ...input, ...(input.workdir ? { workdir: expandPath(input.workdir) } : {}) })
        await deps.reload()
        return text(
          `Bot "${bot.name}" created.\nworkdir: ${bot.workdir}\nmodel: ${bot.model ?? "(default)"}\nmaster prompt (editable): ${store.systemPath(bot.name)}\nTalk to it with @${bot.name} or the bot_say tool; change it with bot_update.`,
          { bot: bot.name },
        )
      }),
    },
    {
      name: "bot_update",
      description:
        "Change a bot's configuration (instructions, model, workdir, skills, MCP servers, permissions, automations). Only the fields you pass are changed; pass null to clear an optional field. A bot can call this on itself (omit name) to reconfigure itself, but it cannot modify other bots or change permissions.",
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
          capabilities: { ...CAPABILITIES_SCHEMA, type: ["object", "null"], description: `${CAPABILITIES_SCHEMA.description} Pass null to remove all overrides (standard preset).` },
          automations: { ...AUTOMATIONS_SCHEMA, type: ["array", "null"] },
        },
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const name = target(input, ctx)
        authorizeWrite(name, ctx)
        const { name: _n, ...rest } = input
        const patch = rest as BotPatch
        if (isBot(ctx.agent) && patch.capabilities !== undefined) throw new BotError("A bot cannot change permissions (capabilities): ask the user.")
        if (!Object.keys(patch).length) throw new BotError("Nothing to change: pass at least one field.")
        if (patch.workdir) patch.workdir = expandPath(patch.workdir)
        const { bot, before } = updateBot(service, name, patch)
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
        const bot = deleteBot(service, input.name)
        await deps.reload()
        return text(`Bot "${bot.name}" deleted. Its working directory ${bot.workdir} was not touched.`)
      }),
    },
    {
      name: "bot_say",
      description:
        "Send a message to a bot. The bot works in its own working directory, in its own conversation (shown as a child session of this one; it remembers earlier messages) and with its own model. By default it works in the background and its answer arrives later as a background result; tell the user it was handed over. Use wait:true only if you must have the answer before continuing.",
      input: {
        type: "object",
        properties: {
          name: str("Bot to talk to"),
          message: str("What to tell the bot"),
          wait: { type: "boolean", description: "true = block until the bot answers. Default false: the bot works in the background and its answer is delivered to you automatically as a background result when it finishes." },
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
        // From a conversation the bot's session is a child of it, and opencode delivers its result back to the
        // caller as a background result (like a native subagent): so do not block unless asked to.
        const wait = input.wait === undefined ? !ctx.sessionID : input.wait === true
        if (caller && wait) waiting.add(caller)
        try {
          const r = await say(session, store, bot, input.message, {
            wait,
            fresh: input.new_conversation === true,
            callerSessionID: ctx.sessionID || undefined,
            timeoutMs: (typeof input.timeout_seconds === "number" ? input.timeout_seconds : 300) * 1000,
          })
          // bot_say is the sensitive bot-to-bot path: audit it even though it is a bot_* tool.
          await recordAudit(store, caller ?? bot.name, {
            tool: "bot_say",
            sessionID: r.sessionID,
            target: bot.name,
            ...(caller ? {} : { detail: "called by a human agent" }),
          })
          const meta = { bot: bot.name, sessionID: r.sessionID, thread: r.thread, status: r.status }
          if (r.status === "started") return text(`Message handed to ${bot.name}. It is working in the background in conversation ${r.sessionID}; its answer will arrive here automatically as a background result when it finishes. Tell the user it is in progress and continue; do not wait or poll.`, meta)
          if (r.status === "timeout") return text(`${bot.name} is still working after the timeout (conversation ${r.sessionID}). Check later with bot_history.`, meta)
          if (r.status === "failed") return text(`${bot.name} failed: ${explainError(r.error ?? "the run failed")}`, { ...meta, error: true })
          return text(r.text || `(${bot.name} finished without a text answer; see bot_history)`, meta)
        } finally {
          if (caller && wait) waiting.delete(caller)
        }
      }),
    },
    {
      name: "bot_history",
      description: "Read a bot's recorded history: every conversation it had is saved in its folder, even if the session was deleted. By default the conversation of the current session, else the most recent. With transcript:true you get readable text instead of a compact summary.",
      input: {
        type: "object",
        properties: {
          name: str("Bot (omit for yourself)"),
          thread: str('Which conversation: a session id, "last" (most recent), or omit for the one linked to this session'),
          limit: { type: "number", description: "How many recent messages (default 12, max 50)" },
          transcript: { type: "boolean", description: "Return a readable transcript (clipped to the most recent 20000 characters)" },
        },
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const bot = store.require(target(input, ctx))
        const threads = store.listThreads(bot.name)
        const recorded = listRecorded(store, bot.name)
        let sessionID: string | undefined
        if (typeof input.thread === "string" && input.thread.startsWith("ses_")) sessionID = input.thread
        else if (input.thread === "last") sessionID = recorded[0]?.sessionID ?? threads[0]?.sessionID
        else sessionID = store.readThreads(bot.name)[ctx.sessionID]?.sessionID ?? recorded[0]?.sessionID ?? threads[0]?.sessionID
        if (!sessionID) return text(`${bot.name} has no conversation yet.`)
        try {
          await syncHistory(session, store, bot.name, sessionID) // bring the record up to date when the session still exists
        } catch {
          /* session gone: the record is all there is */
        }
        let messages = readRecorded(store, bot.name, sessionID)
        if (!messages.length) messages = await session.context({ sessionID }).catch(() => [])
        if (!messages.length) return text(`${bot.name}: nothing recorded for ${sessionID}.`)
        if (input.transcript === true) {
          const t = renderTranscript(messages)
          return text(t.length > 20000 ? "… (earlier part omitted)\n" + t.slice(-20000) : t)
        }
        const limit = Math.min(Math.max(Number(input.limit) || 12, 1), 50)
        return json({ bot: bot.name, sessionID, recordedMessages: messages.length, messages: summarizeMessages(messages, limit) })
      }),
    },
    {
      name: "bot_conversations",
      description: "List a bot's conversations (one per place it was used, shown as child sessions), with their session ids, where they were started, and usage. Use bot_history with a session id to read one.",
      input: { type: "object", properties: { name: str("Bot (omit for yourself)") } },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const bot = store.require(target(input, ctx))
        const known = store.listThreads(bot.name)
        const rows = await Promise.all(
          known.map(async (t) => {
            let live: any
            try {
              live = await session.get({ sessionID: t.sessionID })
            } catch {
              /* deleted */
            }
            const rec = listRecorded(store, bot.name).find((r) => r.sessionID === t.sessionID)
            return { thread: t.key, sessionID: t.sessionID, startedFrom: t.parentID ?? null, lastUsed: t.lastAt, exists: Boolean(live), recordedMessages: rec?.count ?? 0, tokens: live?.tokens, cost: live?.cost }
          }),
        )
        const others: unknown[] = []
        if (session.list) {
          try {
            const r = await session.list({ directory: bot.workdir })
            const arr: any[] = Array.isArray(r) ? r : (r?.data ?? [])
            for (const s of arr) if (s.agent === bot.name && !known.some((k) => k.sessionID === s.id)) others.push({ sessionID: s.id, title: s.title, parent: s.parentID ?? null })
          } catch {
            /* listing is best effort */
          }
        }
        return json({ bot: bot.name, conversations: rows, otherSessionsUsingThisBot: others })
      }),
    },
    {
      name: "bot_files",
      description: "Inspect a bot's working directory: list its files, or read one text file (path relative to the working directory).",
      input: {
        type: "object",
        properties: { name: str("Bot (omit for yourself)"), path: str("File to read, relative to the working directory (omit to list files)"), depth: { type: "number", description: "Listing depth (default 3)" } },
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const bot = store.require(target(input, ctx))
        if (typeof input.path === "string" && input.path) {
          const r = readInside(bot.workdir, input.path)
          if (!r.ok) throw new BotError(r.error)
          return text(r.content + (r.truncated ? "\n… (truncated)" : ""))
        }
        const depth = Math.min(Math.max(Number(input.depth) || 3, 1), 6)
        const { entries } = listTree(bot.workdir, { depth })
        return text(`${bot.workdir}\n${renderTree(bot.workdir, { depth })}\n(${entries.length} entries)`)
      }),
    },
    {
      name: "bot_state",
      description:
        "Read or update a bot's state file (state.md): its working memory. It holds the goal, what is important, the todo list and what is waiting for the user. It is shown to the bot at every turn; keep it short and current. ops: read | write (replace everything) | append (add text at the end) | replace (swap an exact text for another).",
      input: {
        type: "object",
        properties: {
          name: str("Bot (omit for yourself)"),
          op: { type: "string", enum: ["read", "write", "append", "replace"] },
          content: str("op=write: the full new state.md"),
          text: str("op=append: text to add"),
          old: str("op=replace: exact text to find"),
          new: str("op=replace: its replacement"),
        },
        required: ["op"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const name = target(input, ctx)
        authorizeWrite(name, ctx)
        const cur = store.readStateFile(name)
        const op = input.op
        if (op === "read") return text(cur || "(state.md is empty)")
        if (op === "write") {
          if (typeof input.content !== "string") throw new BotError("write needs content")
          store.writeStateFile(name, input.content)
        } else if (op === "append") {
          if (typeof input.text !== "string" || !input.text.trim()) throw new BotError("append needs text")
          store.writeStateFile(name, cur.replace(/\s*$/, "\n") + input.text.replace(/^\n+/, "\n"))
        } else if (op === "replace") {
          if (typeof input.old !== "string" || typeof input.new !== "string" || !input.old) throw new BotError("replace needs old and new")
          const n = cur.split(input.old).length - 1
          if (n !== 1) throw new BotError(n === 0 ? "old text not found in state.md" : `old text appears ${n} times; make it unique`)
          store.writeStateFile(name, cur.replace(input.old, () => input.new))
        } else throw new BotError("op must be read, write, append or replace")
        return text(`state.md updated (${Buffer.byteLength(store.readStateFile(name))} bytes).`)
      }),
    },
    {
      name: "bot_status",
      description:
        'Change a bot\'s lifecycle status. "active": runs (automations schedule). "stopped": paused by the user; automations are removed. "finished": the goal is achieved; automations are removed. A bot may only set itself to "finished" (use it when the goal is fully achieved; never for goals that run forever). The user can set any status.',
      input: {
        type: "object",
        properties: { name: str("Bot (omit for yourself)"), status: { type: "string", enum: [...BOT_STATUSES] }, note: str("Why (shown to the user)") },
        required: ["status"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const name = target(input, ctx)
        authorizeWrite(name, ctx)
        if (!BOT_STATUSES.includes(input.status)) throw new BotError(`status must be one of ${BOT_STATUSES.join(", ")}`)
        if (isBot(ctx.agent) && input.status !== "finished") throw new BotError('A bot may only set itself to "finished". Stopping and restarting are the user\'s decisions.')
        const before = store.require(name)
        const bot = store.setStatus(name, input.status as BotStatus, input.note)
        if (input.status !== "active" && (before.status ?? "active") === "active") {
          for (const t of store.listThreads(name)) if (t.sessionID !== ctx.sessionID) await session.interrupt({ sessionID: t.sessionID }).catch(() => {})
        }
        await deps.automation?.reconcile().catch(() => {})
        const n = (bot.automations ?? []).length
        return text(`${name} is now ${bot.status}.${n ? (bot.status === "active" ? ` ${n} automation(s) scheduled.` : ` Its ${n} automation(s) are not scheduled while it is ${bot.status}.`) : ""}`)
      }),
    },
    {
      name: "bot_notify",
      description:
        'Alert the user without waiting: it lands in their inbox and, in the terminal UI, as a toast (level "attention" also raises a desktop notification and sound). Use "attention" only for things that need a human soon; "info" for progress worth knowing. To ask a question and wait for the answer, use the question tool instead.',
      input: {
        type: "object",
        properties: { message: str("What the user should know or decide"), title: str("Short title"), level: { type: "string", enum: ["info", "attention"] }, name: str("Bot (omit for yourself)") },
        required: ["message"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const name = target(input, ctx)
        authorizeWrite(name, ctx)
        if (typeof input.message !== "string" || !input.message.trim()) throw new BotError("message must not be empty")
        const item = addInboxItem(store, name, { level: input.level === "attention" ? "attention" : "info", message: input.message, title: input.title, sessionID: ctx.sessionID || undefined })
        return text(`Delivered to the user's inbox (${item.level}). Continue your work; if you need an answer to proceed, use the question tool.`, { id: item.id })
      }),
    },
    {
      name: "bot_automation",
      description:
        'Manage a bot\'s scheduled runs. ops: list | add | update | remove | enable | disable | run (now). A schedule is exactly one of: every ("30 minutes", "6 hours", "1 day"; at least 1 minute), cron ("0 9 * * 1-5", optional tz), at ("in 10 minutes" or "2026-12-01T09:00", runs once). Each run prompts the bot in its automation conversation and starts from its state.md. Runs only while the bot is "active". A bot manages its own automations only.',
      input: {
        type: "object",
        properties: {
          name: str("Bot (omit for yourself)"),
          op: { type: "string", enum: ["list", "add", "update", "remove", "enable", "disable", "run"] },
          id: str('Automation id, e.g. "daily-scan"'),
          every: str('e.g. "6 hours"'),
          cron: str('e.g. "0 9 * * 1-5"'),
          at: str('e.g. "in 10 minutes"'),
          tz: str('e.g. "Europe/Paris"'),
          prompt: str("Extra instructions for this run"),
        },
        required: ["op"],
      },
      options: { codemode: false },
      execute: wrap(async (input, ctx) => {
        const name = target(input, ctx)
        const bot = store.require(name)
        const op = input.op
        if (op === "list") return json({ bot: name, status: bot.status ?? "active", automations: deps.automation ? await describeAutomations(deps.automation.native, bot) : bot.automations ?? [] })
        authorizeWrite(name, ctx)
        const specs = [...(bot.automations ?? [])]
        const i = specs.findIndex((x) => x.id === input.id)
        const sched = (({ every, cron, at, tz, prompt }) => ({ every, cron, at, tz, prompt }))(input)
        const defined = Object.fromEntries(Object.entries(sched).filter(([, v]) => v !== undefined))
        let msg = ""
        if (op === "run") {
          const spec = i >= 0 ? specs[i]! : { id: String(input.id ?? "manual") }
          if ((bot.status ?? "active") !== "active") throw new BotError(`${name} is ${bot.status}: set it active first.`)
          const r = await say(session, store, bot, standardPrompt(bot, spec), { wait: false, key: "auto" })
          return text(`Run started in ${name}'s automation conversation (${r.sessionID}).`, { sessionID: r.sessionID })
        }
        if (typeof input.id !== "string" || !input.id) throw new BotError("id is required")
        if (op === "add") {
          if (i >= 0) throw new BotError(`automation "${input.id}" already exists; use update`)
          specs.push({ id: input.id, ...defined } as any)
          msg = `added "${input.id}"`
        } else if (i < 0) throw new BotError(`no automation "${input.id}"`)
        else if (op === "update") {
          const next: any = { ...specs[i], ...defined }
          if (defined.every !== undefined || defined.cron !== undefined || defined.at !== undefined) for (const k of ["every", "cron", "at"]) if (defined[k] === undefined) delete next[k]
          specs[i] = next
          msg = `updated "${input.id}"`
        } else if (op === "remove") {
          specs.splice(i, 1)
          msg = `removed "${input.id}"`
        } else if (op === "enable" || op === "disable") {
          specs[i] = { ...specs[i]!, enabled: op === "enable" }
          msg = `${op}d "${input.id}"`
        } else throw new BotError("op must be list, add, update, remove, enable, disable or run")
        const updated = updateBot(service, name, { automations: validateAutomations(specs) })
        const rep = await deps.automation?.reconcile().catch((e) => ({ errors: [{ name: "reconcile", error: (e as Error).message }] }) as any)
        const err = rep?.errors?.[0]
        return text(`${name}: ${msg}. ${(updated.bot.status ?? "active") === "active" ? "" : `Note: the bot is ${updated.bot.status}, so nothing is scheduled. `}${err ? `Scheduling problem: ${err.error}` : deps.automation ? "Schedule synced." : "(this opencode has no automations: saved in bot.json only)"}`)
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
        const { bot, warnings } = importBot(service, { file: expandPath(input.path) }, {
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

