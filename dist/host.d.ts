import { type BotConfig, type CapabilityPreset } from "./types.js";
export interface Permission {
    action: string;
    resource: string;
    effect: "allow" | "deny" | "ask";
}
export interface AgentLike {
    name: string;
    description?: string;
    system?: string;
    mode: string;
    hidden: boolean;
    model?: unknown;
    permissions: Permission[];
}
export interface AgentEditorLike {
    list(): readonly {
        id: string;
    }[];
    get(id: string): unknown;
    update(id: string, fn: (a: any) => void): void;
    remove(id: string): void;
}
export interface McpEditorLike {
    set(name: string, config: any): void;
    remove(name: string): void;
}
export interface SkillEditorLike {
    add(skill: any): void;
    remove(id: string): void;
}
/** What this plugin instance has registered, so a reload can retract it. */
export interface Owned {
    agents: Set<string>;
    mcps: Set<string>;
    skills: Set<string>;
}
export declare const newOwned: () => Owned;
export declare function parseModelRef(model: string): {
    providerID: string;
    id: string;
    variant?: string;
};
/**
 * The system prompt: a short standard preamble + the user's master prompt.
 * `systemFile` is where the master prompt lives on disk, so the bot knows it can edit it.
 */
export declare function composeSystem(bot: BotConfig, systemFile?: string): string;
/** Name used for a bot-owned MCP server in the host (namespaced to avoid clashes). */
export declare const mcpHostName: (bot: string, server: string) => string;
/** Id used for a bot-owned skill in the host. */
export declare const skillHostId: (bot: string, skill: string) => string;
/**
 * Skill allowlist as permission rules (later rules win). The host matches the
 * rule's resource against the skill *id*, so the bot's own skills (id
 * "<bot>.<name>") are allowed by id as well as by name.
 */
export declare function skillRules(bot: BotConfig, localSkillNames: string[]): Permission[];
export type ToolMode = "all" | "list";
export type SkillMode = "all" | "bot" | "none";
/** The effective permissions of a bot, after the preset and the explicit lists. */
export interface ResolvedCapabilities {
    preset: CapabilityPreset;
    /** "all" = no blanket deny; "list" = deny everything then allow `tools`. */
    toolMode: ToolMode;
    /** Explicitly allowed tool actions (empty when toolMode is "all"). */
    tools: string[];
    denyTools: string[];
    /** Allowed MCP server keys (keys of bot.mcps). */
    mcps: string[];
    /** Configured MCP servers that the permissions do not allow. */
    deniedMcps: string[];
    /** Allowlist entries that match no configured MCP server. */
    unknownMcps: string[];
    skills: SkillMode;
}
/**
 * Applies a bot's preset, then its explicit `tools` / `denyTools` / `mcps`
 * lists. `denyTools` is kept separate because it is applied last, when rules
 * are emitted.
 */
export declare function resolveCapabilities(bot: BotConfig, _localSkillNames?: string[]): ResolvedCapabilities;
/** A compact, human-readable view of the effective permissions. */
export interface CapabilitySummary {
    preset: CapabilityPreset;
    /** "*" = all tools, otherwise the allowed actions (including `bot_*`). */
    tools: "*" | string[];
    denyTools: string[];
    mcps: string[];
    mcpHosts: string[];
    deniedMcps: string[];
    unknownMcps: string[];
    /** "*" = all skills, "none" = no skills, otherwise the allowed names. */
    skills: "*" | "none" | string[];
}
export declare function describeCapabilities(bot: BotConfig, localSkillNames?: string[]): CapabilitySummary;
/**
 * Every permission rule a bot's capabilities imply: tools, MCP servers and
 * skills, in evaluation order (later rules win). A bot without `capabilities`
 * gets exactly the old skill allowlist and no tool rules, so its behavior is
 * unchanged.
 */
export declare function capabilityRules(bot: BotConfig, localSkillNames?: string[]): Permission[];
export interface ApplyEnv {
    /** Where a bot's own skills live on disk. */
    skillsDir: (bot: string) => string;
    /** Where a bot's master prompt (system.md) lives on disk. */
    systemFile?: (bot: string) => string;
    log?: (message: string) => void;
}
/** Registers one agent per bot; retracts agents of bots that no longer exist. */
export declare function applyAgents(editor: AgentEditorLike, bots: BotConfig[], owned: Owned, env: ApplyEnv): void;
/**
 * Bot-owned MCP servers are registered only in the opencode instance whose
 * directory is the bot's workdir: that is where the bot's sessions run, and
 * it avoids spawning every bot's servers in every instance.
 */
export declare function applyWorkdirMcp(location: string, bots: BotConfig[], mcp: McpEditorLike, owned: Owned): void;
/** Same scoping for the skills that ship inside a bot (`<botdir>/skills`). */
export declare function applyWorkdirSkills(location: string, bots: BotConfig[], skills: SkillEditorLike, owned: Owned, env: ApplyEnv): void;
