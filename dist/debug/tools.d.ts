import type { BotStore } from "../store.js";
import type { ToolDef } from "../tools.js";
export interface DebugToolDeps {
    ctx: any;
    store: BotStore;
    version: string;
    options?: Record<string, unknown>;
    materializeEnabled: boolean;
}
export declare function buildDebugTools(deps: DebugToolDeps): ToolDef[];
