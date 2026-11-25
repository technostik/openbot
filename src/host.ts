/**
 * Translation of a BotConfig into opencode primitives (agent, permissions,
 * skills, MCP servers). Pure functions over the host's "editor" objects so
 * they can be unit-tested with plain stand-ins.
 */
import { loadLocalSkills } from "./skills.js"
import type { BotConfig, McpServerConfig } from "./types.js"

export interface Permission {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface AgentLike {
  name: string
  description?: string
  system?: string
  mode: string
  hidden: boolean
  model?: unknown
  permissions: Permission[]
}

export interface AgentEditorLike {
  list(): readonly { id: string }[]
  get(id: string): unknown
  update(id: string, fn: (a: any) => void): void
  remove(id: string): void
}

export interface McpEditorLike {
  set(name: string, config: any): void
  remove(name: string): void
}

export interface SkillEditorLike {
  add(skill: any): void
  remove(id: string): void
}

/** What this plugin instance has registered, so a reload can retract it. */
export interface Owned {
  agents: Set<string>
  mcps: Set<string>
  skills: Set<string>
}
export const newOwned = (): Owned => ({ agents: new Set(), mcps: new Set(), skills: new Set() })

export function parseModelRef(model: string): { providerID: string; id: string; variant?: string } {
  const [ref, variant] = model.split("#")
  const slash = ref!.indexOf("/")
  return { providerID: ref!.slice(0, slash), id: ref!.slice(slash + 1), ...(variant ? { variant } : {}) }
}

/**
 * The system prompt: a short standard preamble + the user's master prompt.
 * `systemFile` is where the master prompt lives on disk, so the bot knows it can edit it.
 */
export function composeSystem(bot: BotConfig, systemFile?: string): string {
  const lines = [
    `You are "${bot.name}", a persistent bot running inside opencode (openbot).`,
    ...(bot.description ? [`Purpose: ${bot.description}`] : []),
    `Your working directory is ${bot.workdir}. Keep your files and notes there.`,
    `You can read and change your own configuration with the bot_get and bot_update tools, and talk to other bots with bot_say.`,
    ...(systemFile
      ? [`Your master prompt (the "Your instructions" section below) is the file ${systemFile}. You may edit it to change your own behavior; edits apply from your next message.`]
      : []),
    "",
    "## Your instructions",
    bot.instructions,
  ]
  return lines.join("\n")
}

/** Name used for a bot-owned MCP server in the host (namespaced to avoid clashes). */
export const mcpHostName = (bot: string, server: string): string => `${bot}-${server}`
/** Id used for a bot-owned skill in the host. */
export const skillHostId = (bot: string, skill: string): string => `${bot}.${skill}`

/**
 * Skill allowlist as permission rules (later rules win). The host matches the
 * rule's resource against the skill *id*, so the bot's own skills (id
 * "<bot>.<name>") are allowed by id as well as by name.
 */
export function skillRules(bot: BotConfig, localSkillNames: string[]): Permission[] {
  if (bot.skills === undefined) return []
  const allowed = new Set([...bot.skills, ...localSkillNames, ...localSkillNames.map((n) => skillHostId(bot.name, n))])
  return [
    { action: "skill", resource: "*", effect: "deny" },
    ...[...allowed].map((name): Permission => ({ action: "skill", resource: name, effect: "allow" })),
  ]
}

export interface ApplyEnv {
  /** Where a bot's own skills live on disk. */
  skillsDir: (bot: string) => string
  /** Where a bot's master prompt (system.md) lives on disk. */
  systemFile?: (bot: string) => string
  log?: (message: string) => void
}

/** Registers one agent per bot; retracts agents of bots that no longer exist. */
export function applyAgents(editor: AgentEditorLike, bots: BotConfig[], owned: Owned, env: ApplyEnv): void {
  const log = env.log ?? (() => {})
  const wanted = new Set(bots.map((b) => b.name))
  for (const id of [...owned.agents]) {
    if (!wanted.has(id)) {
      editor.remove(id)
      owned.agents.delete(id)
    }
  }
  for (const bot of bots) {
    if (!owned.agents.has(bot.name) && editor.get(bot.name)) {
      log(`skipping bot "${bot.name}": an agent with that id already exists`)
      continue
    }
    const local = loadLocalSkills(env.skillsDir(bot.name)).map((s) => s.name)
    editor.update(bot.name, (a: AgentLike) => {
      a.name = bot.name
      if (bot.description) a.description = bot.description
      else delete a.description
      a.system = composeSystem(bot, env.systemFile?.(bot.name))
      a.mode = "all"
      a.hidden = false
      if (bot.model) a.model = parseModelRef(bot.model)
      else delete a.model
      a.permissions = [...(a.permissions ?? []), ...skillRules(bot, local)]
    })
    owned.agents.add(bot.name)
  }
}

const quiet = (fn: () => void) => {
  try {
    fn()
  } catch {
    /* removing something absent is fine */
  }
}

const botsHere = (location: string, bots: BotConfig[]) => bots.filter((b) => b.workdir === location)

/**
 * Bot-owned MCP servers are registered only in the opencode instance whose
 * directory is the bot's workdir: that is where the bot's sessions run, and
 * it avoids spawning every bot's servers in every instance.
 */
export function applyWorkdirMcp(location: string, bots: BotConfig[], mcp: McpEditorLike, owned: Owned): void {
  const want = new Map<string, McpServerConfig>()
  for (const bot of botsHere(location, bots)) {
    for (const [server, cfg] of Object.entries(bot.mcps ?? {})) want.set(mcpHostName(bot.name, server), cfg)
  }
  for (const name of [...owned.mcps]) if (!want.has(name)) { quiet(() => mcp.remove(name)); owned.mcps.delete(name) }
  for (const [name, cfg] of want) { mcp.set(name, cfg); owned.mcps.add(name) }
}

/** Same scoping for the skills that ship inside a bot (`<botdir>/skills`). */
export function applyWorkdirSkills(location: string, bots: BotConfig[], skills: SkillEditorLike, owned: Owned, env: ApplyEnv): void {
  const want = new Map<string, any>()
  for (const bot of botsHere(location, bots)) {
    for (const s of loadLocalSkills(env.skillsDir(bot.name))) {
      const id = skillHostId(bot.name, s.name)
      want.set(id, { id, name: s.name, description: s.description, path: s.path, content: s.content })
    }
  }
  for (const id of [...owned.skills]) if (!want.has(id)) { quiet(() => skills.remove(id)); owned.skills.delete(id) }
  for (const [id, s] of want) { quiet(() => skills.remove(id)); skills.add(s); owned.skills.add(id) }
}
