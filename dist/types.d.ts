/**
 * Data model of a bot. This is the contract that every later feature
 * (automations, budget, Telegram, bot-to-bot) hangs off, so it is versioned
 * and only ever extended with optional fields.
 */
export declare const SCHEMA_VERSION = 1;
export interface McpLocal {
    type: "local";
    command: string[];
    environment?: Record<string, string>;
    [extra: string]: unknown;
}
export interface McpRemote {
    type: "remote";
    url: string;
    headers?: Record<string, string>;
    [extra: string]: unknown;
}
export type McpServerConfig = McpLocal | McpRemote;
/** Lifecycle. `stopped` = paused by a human, `finished` = the bot declared its goal achieved. Both silence automations. */
export type BotStatus = "active" | "stopped" | "finished";
export declare const BOT_STATUSES: readonly BotStatus[];
/** Permission baselines. Explicit lists in BotCapabilities are applied after the preset. */
export type CapabilityPreset = "none" | "minimal" | "standard" | "full";
export declare const CAPABILITY_PRESETS: readonly CapabilityPreset[];
/**
 * Per-bot permissions. A preset gives the base; the lists override it.
 * `tools` and `denyTools` hold opencode permission actions (read, edit, shell,
 * `<mcp-server>_<tool>`, `bot_*`, ...), not human tool labels. `mcps` holds
 * the bot's own MCP server names (keys of BotConfig.mcps) or their host names
 * (`<bot>-<server>`). Unknown keys are kept so a legacy free-form
 * `capabilities` object still round-trips.
 */
export interface BotCapabilities {
    /** Base applied before the lists. Default: "standard". */
    preset?: CapabilityPreset;
    /** Allowed tool actions. "*" = all. undefined = the preset's list. */
    tools?: string[];
    /** Denied tool actions. Always wins over the allowlist. */
    denyTools?: string[];
    /** Allowed MCP servers (keys of BotConfig.mcps, or "<bot>-<server>"). "*" = all. */
    mcps?: string[];
    [extra: string]: unknown;
}
/**
 * A scheduled run. Exactly one of every / cron / at.
 *   every: "30 minutes" | "6 hours" | "1 day"   (at least 1 minute)
 *   cron:  "0 9 * * 1-5"   (with optional tz, e.g. "Europe/Paris")
 *   at:    "in 10 minutes" | "2026-12-01T09:00"  (once)
 */
export interface AutomationSpec {
    id: string;
    every?: string;
    cron?: string;
    at?: string;
    tz?: string;
    /** Extra instructions for this run, added to the standard routine prompt. */
    prompt?: string;
    /** false = kept in bot.json but not scheduled. */
    enabled?: boolean;
    expires?: string;
}
export interface BotConfig {
    schema: typeof SCHEMA_VERSION;
    /** Unique, lowercase, used as `@name` and as the agent id. */
    name: string;
    description?: string;
    /** `provider/model[#variant]`. Omitted = opencode's default model. */
    model?: string;
    /** The master prompt: the bot's role and goal. */
    instructions: string;
    /** Absolute path where the bot works. Its sessions run here. */
    workdir: string;
    /**
     * Allowlist of skill names the bot may use (host skills + its own).
     * `undefined` = unrestricted, `[]` = no skills.
     */
    skills?: string[];
    /** MCP servers owned by this bot, keyed by a short local name. */
    mcps?: Record<string, McpServerConfig>;
    /** Per-bot permissions: preset + explicit tool / MCP lists. */
    capabilities?: BotCapabilities;
    /** Scheduled runs (synced to native opencode automations while the bot is active). */
    automations?: AutomationSpec[];
    /** Default active. */
    status?: BotStatus;
    statusNote?: string;
    statusAt?: string;
    createdAt: string;
    updatedAt: string;
}
/** Fields a caller may provide when creating a bot. */
export interface BotInput {
    name: string;
    instructions: string;
    description?: string;
    model?: string;
    workdir?: string;
    skills?: string[];
    mcps?: Record<string, McpServerConfig>;
    capabilities?: BotCapabilities;
    automations?: AutomationSpec[];
}
/** Fields a caller may change. `null` clears an optional field. */
export interface BotPatch {
    description?: string | null;
    instructions?: string;
    model?: string | null;
    workdir?: string;
    skills?: string[] | null;
    mcps?: Record<string, McpServerConfig> | null;
    capabilities?: BotCapabilities | null;
    automations?: AutomationSpec[] | null;
}
/** Legacy single-session state (v0.1). Still read, migrated into threads. */
export interface BotState {
    sessionID?: string;
    sessionCreatedAt?: string;
}
/**
 * One conversation of a bot. A bot talks in one thread per calling conversation
 * (so it shows up as a child session of where it is used) plus "main" for
 * callers that have no conversation (automations, Telegram, ...).
 */
export interface ThreadInfo {
    sessionID: string;
    /** The conversation that called the bot, when there was one. */
    parentID?: string;
    /** The working directory this conversation was created for. */
    workdir?: string;
    createdAt: string;
    lastAt: string;
}
export type Threads = Record<string, ThreadInfo>;
export declare class BotError extends Error {
    constructor(message: string);
}
