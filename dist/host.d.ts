import type { BotConfig } from "./types.js";
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
/** The system prompt: a short standard preamble + the user's master prompt. */
export declare function composeSystem(bot: BotConfig): string;
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
export interface ApplyEnv {
    /** Where a bot's own skills live on disk. */
    skillsDir: (bot: string) => string;
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
