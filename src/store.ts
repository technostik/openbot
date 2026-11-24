import fs from "node:fs"
import path from "node:path"
import { assertName, nameProblem } from "./names.js"
import { expandPath } from "./paths.js"
import {
  BotError,
  SCHEMA_VERSION,
  type BotConfig,
  type BotInput,
  type BotPatch,
  type BotState,
  type McpServerConfig,
} from "./types.js"

const MODEL_RE = /^[^/\s#]+\/[^\s#]+(#[^\s#]+)?$/
const MCP_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/

/* ------------------------------------------------------------------ */
/* Validation (pure, no I/O) — exported for tests and for import.      */
/* ------------------------------------------------------------------ */

export function validateModel(model: unknown): string {
  if (typeof model !== "string" || !MODEL_RE.test(model.trim())) {
    throw new BotError('model must look like "provider/model" (optionally "provider/model#variant")')
  }
  return model.trim()
}

export function validateSkills(skills: unknown): string[] {
  if (!Array.isArray(skills) || skills.some((s) => typeof s !== "string" || !s.trim())) {
    throw new BotError("skills must be an array of skill names")
  }
  return [...new Set(skills.map((s: string) => s.trim()))]
}

function stringRecord(v: unknown, label: string): Record<string, string> | undefined {
  if (v === undefined) return undefined
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.values(v).some((x) => typeof x !== "string")) {
    throw new BotError(`${label} must be an object of strings`)
  }
  return { ...(v as Record<string, string>) }
}

export function validateMcps(mcps: unknown): Record<string, McpServerConfig> {
  if (!mcps || typeof mcps !== "object" || Array.isArray(mcps)) {
    throw new BotError("mcps must be an object: { serverName: { type, ... } }")
  }
  const out: Record<string, McpServerConfig> = {}
  for (const [key, raw] of Object.entries(mcps)) {
    if (!MCP_KEY_RE.test(key)) {
      throw new BotError(`mcp server name "${key}" must be lowercase letters, digits, "-" or "_" (max 32)`)
    }
    const v = raw as Record<string, unknown>
    if (!v || typeof v !== "object") throw new BotError(`mcp "${key}" must be an object`)
    if (v.type === "local") {
      if (!Array.isArray(v.command) || !v.command.length || v.command.some((c) => typeof c !== "string")) {
        throw new BotError(`mcp "${key}": local servers need "command": ["cmd", "arg", ...]`)
      }
      const environment = stringRecord(v.environment, `mcp "${key}" environment`)
      out[key] = { ...v, type: "local", command: [...(v.command as string[])], ...(environment ? { environment } : {}) }
    } else if (v.type === "remote") {
      if (typeof v.url !== "string" || !/^https?:\/\//.test(v.url)) {
        throw new BotError(`mcp "${key}": remote servers need an http(s) "url"`)
      }
      const headers = stringRecord(v.headers, `mcp "${key}" headers`)
      out[key] = { ...v, type: "remote", url: v.url, ...(headers ? { headers } : {}) }
    } else {
      throw new BotError(`mcp "${key}": "type" must be "local" or "remote"`)
    }
  }
  return out
}

function validateCapabilities(c: unknown): Record<string, unknown> {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new BotError("capabilities must be an object")
  return { ...(c as Record<string, unknown>) }
}

function validateInstructions(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new BotError("instructions (the bot's role and goal) must be a non-empty string")
  return v.trim()
}

function validateWorkdir(v: unknown, base?: string): string {
  if (typeof v !== "string" || !v.trim()) throw new BotError("workdir must be a path")
  const p = expandPath(v, base)
  if (p === path.parse(p).root) throw new BotError("workdir must not be the filesystem root")
  return p
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export interface ListResult {
  bots: BotConfig[]
  problems: { name: string; error: string }[]
}

export class BotStore {
  constructor(readonly root: string) {}

  get botsDir(): string {
    return path.join(this.root, "bots")
  }
  botDir(name: string): string {
    assertName(name)
    return path.join(this.botsDir, name)
  }
  private configPath(name: string): string {
    return path.join(this.botDir(name), "bot.json")
  }
  private statePath(name: string): string {
    return path.join(this.botDir(name), "state", "session.json")
  }
  skillsDir(name: string): string {
    return path.join(this.botDir(name), "skills")
  }
  defaultWorkdir(name: string): string {
    return path.join(this.botDir(name), "workspace")
  }

  exists(name: string): boolean {
    if (nameProblem(name)) return false
    return fs.existsSync(this.configPath(name))
  }

  get(name: string): BotConfig | undefined {
    if (nameProblem(name)) return undefined
    try {
      return this.parse(fs.readFileSync(this.configPath(name), "utf8"), name)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw e
    }
  }

  require(name: string): BotConfig {
    const bot = this.get(name)
    if (!bot) throw new BotError(`No bot named "${name}". Use bot_list to see existing bots.`)
    return bot
  }

  list(): BotConfig[] {
    return this.listWithProblems().bots
  }

  listWithProblems(): ListResult {
    const result: ListResult = { bots: [], problems: [] }
    let entries: string[] = []
    try {
      entries = fs.readdirSync(this.botsDir)
    } catch {
      return result
    }
    for (const name of entries.sort()) {
      if (nameProblem(name)) continue
      try {
        const raw = fs.readFileSync(this.configPath(name), "utf8")
        result.bots.push(this.parse(raw, name))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue
        result.problems.push({ name, error: (e as Error).message })
      }
    }
    return result
  }

  /** Cheap change detector (names + mtimes + sizes of every bot.json). */
  signature(): string {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(this.botsDir)
    } catch {
      return ""
    }
    const parts: string[] = []
    for (const name of entries.sort()) {
      try {
        const st = fs.statSync(path.join(this.botsDir, name, "bot.json"))
        parts.push(`${name}:${st.mtimeMs}:${st.size}`)
      } catch {
        /* not a bot directory */
      }
    }
    return parts.join("|")
  }

  create(input: BotInput): BotConfig {
    assertName(input.name)
    if (this.exists(input.name)) throw new BotError(`A bot named "${input.name}" already exists.`)
    const now = new Date().toISOString()
    const bot: BotConfig = {
      schema: SCHEMA_VERSION,
      name: input.name,
      instructions: validateInstructions(input.instructions),
      workdir: input.workdir ? validateWorkdir(input.workdir) : this.defaultWorkdir(input.name),
      createdAt: now,
      updatedAt: now,
    }
    if (input.description?.trim()) bot.description = input.description.trim()
    if (input.model !== undefined) bot.model = validateModel(input.model)
    if (input.skills !== undefined) bot.skills = validateSkills(input.skills)
    if (input.mcps !== undefined) bot.mcps = validateMcps(input.mcps)
    if (input.capabilities !== undefined) bot.capabilities = validateCapabilities(input.capabilities)
    fs.mkdirSync(path.join(this.botDir(bot.name), "state"), { recursive: true })
    fs.mkdirSync(this.skillsDir(bot.name), { recursive: true })
    fs.mkdirSync(bot.workdir, { recursive: true })
    this.write(bot)
    return bot
  }

  update(name: string, patch: BotPatch): BotConfig {
    const bot = this.require(name)
    const next: BotConfig = { ...bot }
    if (patch.instructions !== undefined) next.instructions = validateInstructions(patch.instructions)
    if (patch.workdir !== undefined) next.workdir = validateWorkdir(patch.workdir)
    if (patch.description !== undefined) {
      if (patch.description === null || !patch.description.trim()) delete next.description
      else next.description = patch.description.trim()
    }
    if (patch.model !== undefined) {
      if (patch.model === null) delete next.model
      else next.model = validateModel(patch.model)
    }
    if (patch.skills !== undefined) {
      if (patch.skills === null) delete next.skills
      else next.skills = validateSkills(patch.skills)
    }
    if (patch.mcps !== undefined) {
      if (patch.mcps === null) delete next.mcps
      else next.mcps = validateMcps(patch.mcps)
    }
    if (patch.capabilities !== undefined) {
      if (patch.capabilities === null) delete next.capabilities
      else next.capabilities = validateCapabilities(patch.capabilities)
    }
    next.updatedAt = new Date().toISOString()
    fs.mkdirSync(next.workdir, { recursive: true })
    this.write(next)
    return next
  }

  /** Removes the bot's directory (config, state, local skills, default workspace). A custom workdir is never touched. */
  delete(name: string): BotConfig {
    const bot = this.require(name)
    fs.rmSync(this.botDir(name), { recursive: true, force: true })
    return bot
  }

  /** Writes a fully-formed config (used by create/update/import). */
  write(bot: BotConfig): void {
    const file = this.configPath(bot.name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(bot, null, 2) + "\n", "utf8")
    fs.renameSync(tmp, file)
  }

  /* ---- runtime state ---- */

  readState(name: string): BotState {
    try {
      return JSON.parse(fs.readFileSync(this.statePath(name), "utf8")) as BotState
    } catch {
      return {}
    }
  }

  writeState(name: string, patch: Partial<BotState> | null): BotState {
    const next = patch === null ? {} : { ...this.readState(name), ...patch }
    const file = this.statePath(name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8")
    return next
  }

  /* ---- parsing a hand-edited bot.json ---- */

  parse(raw: string, expectedName: string): BotConfig {
    let j: Record<string, unknown>
    try {
      j = JSON.parse(raw)
    } catch (e) {
      throw new BotError(`bot.json is not valid JSON: ${(e as Error).message}`)
    }
    if (!j || typeof j !== "object") throw new BotError("bot.json must be an object")
    if (j.name !== expectedName) throw new BotError(`bot.json "name" ("${String(j.name)}") must match its folder ("${expectedName}")`)
    if (typeof j.schema === "number" && j.schema > SCHEMA_VERSION) {
      throw new BotError(`bot.json uses schema ${j.schema}, newer than this openbot (${SCHEMA_VERSION}). Update openbot.`)
    }
    const now = new Date().toISOString()
    const bot: BotConfig = {
      schema: SCHEMA_VERSION,
      name: expectedName,
      instructions: validateInstructions(j.instructions),
      workdir: j.workdir !== undefined ? validateWorkdir(j.workdir) : this.defaultWorkdir(expectedName),
      createdAt: typeof j.createdAt === "string" ? j.createdAt : now,
      updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : now,
    }
    if (typeof j.description === "string" && j.description.trim()) bot.description = j.description.trim()
    if (j.model !== undefined) bot.model = validateModel(j.model)
    if (j.skills !== undefined) bot.skills = validateSkills(j.skills)
    if (j.mcps !== undefined) bot.mcps = validateMcps(j.mcps)
    if (j.capabilities !== undefined) bot.capabilities = validateCapabilities(j.capabilities)
    return bot
  }
}
