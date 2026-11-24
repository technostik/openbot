import { type BotConfig, type BotInput, type BotPatch, type BotState, type McpServerConfig } from "./types.js";
export declare function validateModel(model: unknown): string;
export declare function validateSkills(skills: unknown): string[];
export declare function validateMcps(mcps: unknown): Record<string, McpServerConfig>;
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
    /** Writes a fully-formed config (used by create/update/import). */
    write(bot: BotConfig): void;
    readState(name: string): BotState;
    writeState(name: string, patch: Partial<BotState> | null): BotState;
    parse(raw: string, expectedName: string): BotConfig;
}
