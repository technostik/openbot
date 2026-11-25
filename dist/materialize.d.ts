import type { BotConfig } from "./types.js";
export declare const MARKER = "x-openbot: managed";
export interface MaterializeEnv {
    skillsDir: (bot: string) => string;
    systemFile?: (bot: string) => string;
}
export declare const agentFilePath: (bot: Pick<BotConfig, "name" | "workdir">) => string;
export declare function renderAgentFile(bot: BotConfig, env: MaterializeEnv): string;
export interface MaterializeResult {
    status: "written" | "unchanged" | "conflict" | "error";
    path: string;
    error?: string;
}
export declare function materialize(bot: BotConfig, env: MaterializeEnv): MaterializeResult;
/** Removes the agent file, but only if openbot wrote it. */
export declare function dematerialize(bot: Pick<BotConfig, "name" | "workdir">): "removed" | "absent" | "foreign";
/** State of the file without changing it (for diagnostics). */
export declare function inspectMaterialized(bot: BotConfig, env: MaterializeEnv): "ok" | "stale" | "missing" | "foreign";
