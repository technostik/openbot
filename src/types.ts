/**
 * Data model of a bot. This is the contract that every later feature
 * (automations, budget, Telegram, bot-to-bot) hangs off, so it is versioned
 * and only ever extended with optional fields.
 */

export const SCHEMA_VERSION = 1

export interface McpLocal {
  type: "local"
  command: string[]
  environment?: Record<string, string>
  [extra: string]: unknown
}

export interface McpRemote {
  type: "remote"
  url: string
  headers?: Record<string, string>
  [extra: string]: unknown
}

export type McpServerConfig = McpLocal | McpRemote

export interface BotConfig {
  schema: typeof SCHEMA_VERSION
  /** Unique, lowercase, used as `@name` and as the agent id. */
  name: string
  description?: string
  /** `provider/model[#variant]`. Omitted = opencode's default model. */
  model?: string
  /** The master prompt: the bot's role and goal. */
  instructions: string
  /** Absolute path where the bot works. Its sessions run here. */
  workdir: string
  /**
   * Allowlist of skill names the bot may use (host skills + its own).
   * `undefined` = unrestricted, `[]` = no skills.
   */
  skills?: string[]
  /** MCP servers owned by this bot, keyed by a short local name. */
  mcps?: Record<string, McpServerConfig>
  /** Reserved: access to other plugins / bots / budgets. Not enforced yet. */
  capabilities?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/** Fields a caller may provide when creating a bot. */
export interface BotInput {
  name: string
  instructions: string
  description?: string
  model?: string
  workdir?: string
  skills?: string[]
  mcps?: Record<string, McpServerConfig>
  capabilities?: Record<string, unknown>
}

/** Fields a caller may change. `null` clears an optional field. */
export interface BotPatch {
  description?: string | null
  instructions?: string
  model?: string | null
  workdir?: string
  skills?: string[] | null
  mcps?: Record<string, McpServerConfig> | null
  capabilities?: Record<string, unknown> | null
}

/** Mutable per-bot runtime state, kept out of bot.json so config stays clean. */
export interface BotState {
  /** The bot's persistent conversation. */
  sessionID?: string
  sessionCreatedAt?: string
}

export class BotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BotError"
  }
}
