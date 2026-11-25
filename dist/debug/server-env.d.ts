/** DiagEnv for the server plugin: only the current directory is visible from here. */
import type { BotStore } from "../store.js";
import type { DiagEnv } from "./diagnose.js";
export declare function serverDiagEnv(ctx: any, base: {
    store: BotStore;
    pluginVersion: string;
    options?: Record<string, unknown>;
    materializeEnabled: boolean;
}): DiagEnv;
