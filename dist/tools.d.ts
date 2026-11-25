import { type SessionPort } from "./session-io.js";
import { type Service } from "./service.js";
import type { BotStore } from "./store.js";
export interface ToolDeps {
    store: BotStore;
    service: Service;
    session: SessionPort;
    /** Re-applies bot definitions to the host after a change. */
    reload: () => Promise<void>;
}
/** Turns host errors into something that tells the user what to do. */
export declare function explainError(message: string): string;
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
