import { type AutomationSpec, type BotCapabilities, type BotStatus, type BotConfig, type BotInput, type BotPatch, type BotState, type McpServerConfig, type ThreadInfo, type Threads } from "./types.js";
export declare function validateModel(model: unknown): string;
export declare function validateSkills(skills: unknown): string[];
export declare function validateMcps(mcps: unknown): Record<string, McpServerConfig>;
/**
 * Resolve a relative `at` ("in 10 minutes") once, when the spec is written.
 * The native host stores the absolute date it resolved to, so keeping the
 * relative string would make sameAutomation() see a difference on every
 * reconcile and re-arm the schedule (a one-shot `at` would fire again and again).
 */
export declare function resolveAt(at: string, now?: number): string;
export declare function validateAutomations(list: unknown): AutomationSpec[];
/**
 * Validates the reserved `capabilities` field. Unknown keys are kept: bots
 * created before v4 may have a free-form object there, and dropping it would
 * silently rewrite their bot.json.
 */
export declare function validateCapabilities(c: unknown): BotCapabilities;
export interface ListResult {
    bots: BotConfig[];
    problems: {
        name: string;
        error: string;
    }[];
}
export declare class BotStore {
    readonly root: string;
    constructor(root: string);
    get botsDir(): string;
    botDir(name: string): string;
    private configPath;
    private statePath;
    private threadsPath;
    /** The master prompt, as a plain markdown file anyone (user or bot) can edit. */
    systemPath(name: string): string;
    skillsDir(name: string): string;
    defaultWorkdir(name: string): string;
    exists(name: string): boolean;
    get(name: string): BotConfig | undefined;
    require(name: string): BotConfig;
    list(): BotConfig[];
    listWithProblems(): ListResult;
    /** Cheap change detector (names + mtimes + sizes of every bot.json). */
    signature(): string;
    create(input: BotInput): BotConfig;
    update(name: string, patch: BotPatch): BotConfig;
    /** Removes the bot's directory (config, state, local skills, default workspace). A custom workdir is never touched. */
    delete(name: string): BotConfig;
    /**
     * Writes a fully-formed bot: the master prompt goes to system.md, everything
     * else to bot.json (so each file is pleasant to edit by hand).
     */
    write(bot: BotConfig): void;
    private atomicWrite;
    /** Moves v0.1 bots (instructions inside bot.json) to the system.md layout. */
    migrate(): string[];
    readThreads(name: string): Threads;
    setThread(name: string, key: string, info: ThreadInfo): void;
    touchThread(name: string, key: string): void;
    /** Is this session one of the bot's own conversations? */
    isBotSession(name: string, sessionID: string): boolean;
    /** Threads, most recently used first. */
    listThreads(name: string): Array<ThreadInfo & {
        key: string;
    }>;
    readState(name: string): BotState;
    writeState(name: string, patch: Partial<BotState> | null): BotState;
    parse(raw: string, expectedName: string): BotConfig;
    /** Changes the bot's lifecycle status (the only writer of status). */
    setStatus(name: string, status: BotStatus, note?: string): BotConfig;
    stateFile(name: string): string;
    /** Creates state.md from the template when missing. */
    ensureStateFile(bot: Pick<BotConfig, "name" | "description">): boolean;
    readStateFile(name: string): string;
    writeStateFile(name: string, content: string): void;
}
export declare const MAX_STATE_BYTES: number;
export declare function stateTemplate(bot: Pick<BotConfig, "name" | "description">): string;
