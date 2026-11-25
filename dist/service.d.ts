/**
 * Bot operations shared by the server tools and the TUI. Every change goes
 * through here so that the on-disk bot and its materialized agent file never
 * drift apart.
 */
import { type MaterializeEnv, type MaterializeResult } from "./materialize.js";
import { type ImportOptions } from "./bundle.js";
import type { BotStore } from "./store.js";
import type { BotConfig, BotInput, BotPatch } from "./types.js";
export interface Service {
    store: BotStore;
    /** Write native agent files into bot workdirs (default true). */
    materialize: boolean;
    log: (event: string, data?: unknown) => void;
}
export declare const makeService: (store: BotStore, opts?: {
    materialize?: boolean;
    log?: Service["log"];
}) => Service;
export declare const materializeEnv: (store: BotStore) => MaterializeEnv;
export declare function syncAgentFile(svc: Service, bot: BotConfig): MaterializeResult | undefined;
export declare function createBot(svc: Service, input: BotInput): BotConfig;
export declare function updateBot(svc: Service, name: string, patch: BotPatch): {
    bot: BotConfig;
    before: BotConfig;
};
export declare function deleteBot(svc: Service, name: string): BotConfig;
export declare function importBot(svc: Service, source: {
    file: string;
} | {
    bundle: unknown;
}, opts?: ImportOptions): {
    bot: BotConfig;
    warnings: string[];
};
/** At startup / after an external change: migrate legacy bots and refresh every agent file. */
export declare function syncAll(svc: Service): {
    migrated: string[];
    results: MaterializeResult[];
};
