import type { Plugin } from "@opencode/plugin/tui";
import { addInboxItem, readInbox } from "./inbox.js";
import { type Service } from "./service.js";
import { type SessionPort } from "./session-io.js";
import type { BotStore } from "./store.js";
type Context = Plugin.Context;
export interface FlowDeps {
    ctx: Context;
    store: BotStore;
    service: Service;
    /** Debug tools (diagnose, report) are only offered when this is true. */
    debug: boolean;
    options: Record<string, unknown>;
    /** Scrollable full-text viewer (TSX). Falls back to the stock alert, which shows only the first lines. */
    viewer?: (title: string, text: string) => Promise<void>;
}
/** The TUI's client, shaped like the session API the server side uses. */
export declare const clientPort: (client: any) => SessionPort;
/** Model picker. Resolves to "" for opencode's default, a "provider/model" id, or undefined when cancelled. */
export declare function pickModel(d: FlowDeps, title: string, current?: string): Promise<string | undefined>;
export declare function createBotFlow(d: FlowDeps): Promise<void>;
/** Pick one of the bots, then open its menu. */
export declare function botsFlow(d: FlowDeps): Promise<void>;
export declare function botMenuFlow(d: FlowDeps, name: string): Promise<void>;
export declare function browseFlow(d: FlowDeps, title: string, root: string): Promise<void>;
export interface PendingQuestion {
    bot: string;
    sessionID: string;
    formID: string;
    title: string;
    fields: any[];
}
/** Forms (e.g. the question tool) waiting for an answer in a bot's conversations. */
export declare function pendingQuestions(d: FlowDeps): Promise<PendingQuestion[]>;
/** The host puts the question text in `description` and a short header in `title`. */
export declare const fieldText: (f: any) => string;
/** Everything waiting for you (one bot, or all). Returns true when it navigated away. */
export declare function inboxFlow(d: FlowDeps, only?: string): Promise<boolean>;
/** Used by the TUI to turn bot-originated alerts into notifications. */
export { addInboxItem, readInbox };
/** A bot's conversations: open one live, or read its recorded history (which outlives opencode's own sessions). Returns true when it navigated away. */
export declare function conversationsFlow(d: FlowDeps, name: string): Promise<boolean>;
/** Debug: diagnose one bot (or everything) from the TUI, optionally writing a report. */
export declare function diagnoseFlow(d: FlowDeps, name: string | undefined, report: boolean): Promise<void>;
