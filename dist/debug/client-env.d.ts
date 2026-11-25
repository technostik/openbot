/**
 * DiagEnv built from an OpenCode client (the TUI's `context.client`, or the
 * generated client in tests). Every list call answers `{ location, data: [...] }`.
 */
import type { BotStore } from "../store.js";
import type { DiagEnv } from "./diagnose.js";
export { MARKER_AGENT } from "../constants.js";
export declare function clientDiagEnv(client: any, base: {
    store: BotStore;
    pluginVersion: string;
    appVersion?: string;
    location?: string;
    options?: Record<string, unknown>;
    materializeEnabled: boolean;
}): DiagEnv;
