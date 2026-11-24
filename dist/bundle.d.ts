import type { BotStore } from "./store.js";
import { type BotConfig } from "./types.js";
export declare const BUNDLE_FORMAT = "openbot.bundle";
export declare const BUNDLE_VERSION = 1;
export declare const REDACTED = "<redacted>";
export interface Bundle {
    format: typeof BUNDLE_FORMAT;
    version: number;
    exportedAt: string;
    /** The bot without machine-specific or runtime fields (workdir, timestamps). */
    bot: Omit<BotConfig, "workdir" | "createdAt" | "updatedAt" | "schema">;
    /** Text files shipped with the bot, keyed by relative path (always under `skills/`). */
    files: Record<string, string>;
    warnings: string[];
}
export declare function exportBundle(store: BotStore, name: string, opts?: {
    includeSecrets?: boolean;
}): Bundle;
export declare function exportToFile(store: BotStore, name: string, file?: string, opts?: {
    includeSecrets?: boolean;
}): {
    path: string;
    bundle: Bundle;
};
export interface ImportOptions {
    /** Import under another name. */
    rename?: string;
    /** Replace an existing bot with the same name. */
    overwrite?: boolean;
    /** Working directory on this machine (default: the bot's own workspace folder). */
    workdir?: string;
}
export declare function importBundle(store: BotStore, raw: unknown, opts?: ImportOptions): {
    bot: BotConfig;
    warnings: string[];
};
export declare function importFromFile(store: BotStore, file: string, opts?: ImportOptions): {
    bot: BotConfig;
    warnings: string[];
};
