import { ensureSession, type SessionPort } from "./session-io.js";
import type { BotStore } from "./store.js";
export interface ToolDeps {
    store: BotStore;
    session: SessionPort;
    /** Re-applies bot definitions to the host after a change. */
    reload: () => Promise<void>;
}
export interface ToolContextLike {
    agent: string;
    sessionID: string;
}
export interface ToolDef {
    name: string;
    description: string;
    input: Record<string, unknown>;
    options: {
        codemode: false;
    };
    execute: (input: any, ctx: ToolContextLike) => Promise<{
        content: string;
        metadata?: Record<string, unknown>;
    }>;
}
export declare function buildTools(deps: ToolDeps): ToolDef[];
export { ensureSession };
