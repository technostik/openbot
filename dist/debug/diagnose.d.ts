import type { BotStore } from "../store.js";
export type Level = "ok" | "info" | "warn" | "error";
export interface Check {
    /** "global" or a bot name. */
    scope: string;
    id: string;
    level: Level;
    title: string;
    detail?: string;
    fix?: string;
}
export interface DiagEnv {
    pluginVersion: string;
    appVersion?: string;
    /** The directory this runs from. */
    location?: string;
    options?: Record<string, unknown>;
    store: BotStore;
    materializeEnabled: boolean;
    /** Each of these returns undefined when the host cannot tell. */
    /** Is the openbot plugin itself running in that directory? (marker agent present) */
    pluginLoadedAt(directory: string): Promise<boolean | undefined>;
    agentsAt(directory: string): Promise<string[] | undefined>;
    models(): Promise<string[] | undefined>;
    defaultModel(): Promise<string | undefined>;
    skillsAt(directory: string): Promise<string[] | undefined>;
    mcpAt(directory: string): Promise<Array<{
        name: string;
        status?: string;
        error?: string;
    }> | undefined>;
    sessionContext(sessionID: string): Promise<any[] | undefined>;
}
export interface DiagResult {
    checks: Check[];
    counts: Record<Level, number>;
    ok: boolean;
}
export declare function diagnose(env: DiagEnv, only?: string): Promise<DiagResult>;
/** Short text for a tool result or a dialog. */
export declare function renderChecks(result: DiagResult, opts?: {
    onlyProblems?: boolean;
}): string;
