import type { BotStore } from "./store.js";
import type { BotConfig } from "./types.js";
export interface SessionPort {
    list?(input?: any): Promise<any>;
    create(input: any): Promise<any>;
    /** Relocates a session to another directory (applies from its next run). */
    move?(input: {
        sessionID: string;
        directory: string;
    }): Promise<unknown>;
    get(input: {
        sessionID: string;
    }): Promise<any>;
    prompt(input: any): Promise<any>;
    wait(input: {
        sessionID: string;
    }): Promise<unknown>;
    context(input: {
        sessionID: string;
    }): Promise<any[]>;
    interrupt(input: {
        sessionID: string;
    }): Promise<unknown>;
}
export interface Reply {
    /** True once the session went idle after our message. */
    done: boolean;
    outcome?: string;
    error?: string;
    /** The last assistant text produced since our message. */
    text: string;
    /** Number of assistant messages produced (model steps). */
    steps: number;
}
/** Reads what happened in `messages` after the message `afterId`. */
export declare function extractReply(messages: any[], afterId: string): Reply;
export interface HistoryItem {
    type: string;
    text?: string;
    tools?: string[];
    outcome?: string;
    error?: string;
    at?: number;
}
/** Compact, model-friendly view of the last `limit` messages. */
export declare function summarizeMessages(messages: any[], limit: number, maxChars?: number): HistoryItem[];
/** The thread key for a caller: its own conversation, or "main" when there is none. */
export declare const threadKey: (callerSessionID?: string) => string;
/**
 * Returns the id of the bot's conversation for this caller, creating it in the
 * bot's workdir if needed. The conversation is created as a child of the
 * calling session so it appears under it in the UI.
 */
export declare function ensureSession(port: SessionPort, store: BotStore, bot: BotConfig, opts?: {
    fresh?: boolean;
    callerSessionID?: string;
    key?: string;
}): Promise<{
    sessionID: string;
    key: string;
    created: boolean;
    parented: boolean;
}>;
export interface SayOptions {
    /** Wait for the bot to finish and return its answer (default true). */
    wait?: boolean;
    timeoutMs?: number;
    /** Start a new conversation instead of continuing the existing one. */
    fresh?: boolean;
    /** The conversation that is calling the bot (the bot's thread becomes its child). */
    callerSessionID?: string;
    /** Use this thread key instead of the caller's (e.g. "diagnose"). */
    key?: string;
    /** Aborting interrupts the bot's current run. */
    signal?: AbortSignal;
    pollMs?: number;
}
export interface SayResult {
    sessionID: string;
    thread: string;
    status: "started" | "done" | "failed" | "timeout" | "interrupted";
    text: string;
    error?: string;
    steps?: number;
}
export declare function say(port: SessionPort, store: BotStore, bot: BotConfig, message: string, opts?: SayOptions): Promise<SayResult>;
