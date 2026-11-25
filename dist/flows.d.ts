/**
 * The TUI's interactions (dialogs and commands), as plain functions over the
 * TUI plugin context. Kept out of the JSX file so they compile with the rest
 * and can be tested with a fake context.
 */
import type { Plugin } from "@opencode/plugin/tui";
import { type Service } from "./service.js";
import type { BotStore } from "./store.js";
type Context = Plugin.Context;
export interface FlowDeps {
    ctx: Context;
    store: BotStore;
    service: Service;
    /** Debug tools (diagnose, report) are only offered when this is true. */
    debug: boolean;
    options: Record<string, unknown>;
}
/** Model picker. Resolves to "" for opencode's default, a "provider/model" id, or undefined when cancelled. */
export declare function pickModel(d: FlowDeps, title: string, current?: string): Promise<string | undefined>;
export declare function createBotFlow(d: FlowDeps): Promise<void>;
/** Pick one of the bots, then open its menu. */
export declare function botsFlow(d: FlowDeps): Promise<void>;
export declare function botMenuFlow(d: FlowDeps, name: string): Promise<void>;
/** Lists a bot's conversations; picking one opens it. Returns true when it navigated away. */
export declare function conversationsFlow(d: FlowDeps, name: string): Promise<boolean>;
/** Debug: diagnose one bot (or everything) from the TUI, optionally writing a report. */
export declare function diagnoseFlow(d: FlowDeps, name: string | undefined, report: boolean): Promise<void>;
export {};
