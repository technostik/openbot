/**
 * Talking to a bot = prompting the bot's own persistent session, which lives
 * in the bot's working directory and uses the bot's agent. Everything here is
 * written against a narrow SessionPort so it can be tested without a host.
 */
import type { BotStore } from "./store.js";
import type { BotConfig } from "./types.js";
export interface SessionPort {
    create(input: any): Promise<any>;
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
/** Returns the id of the bot's live session, creating one in its workdir if needed. */
export declare function ensureSession(port: SessionPort, store: BotStore, bot: BotConfig, opts?: {
    fresh?: boolean;
}): Promise<string>;
export interface SayOptions {
    /** Wait for the bot to finish and return its answer (default true). */
    wait?: boolean;
    timeoutMs?: number;
    /** Start a new conversation instead of continuing the existing one. */
    fresh?: boolean;
    /** Aborting interrupts the bot's current run. */
    signal?: AbortSignal;
    pollMs?: number;
}
export interface SayResult {
    sessionID: string;
    status: "started" | "done" | "failed" | "timeout" | "interrupted";
    text: string;
    error?: string;
    steps?: number;
}
export declare function say(port: SessionPort, store: BotStore, bot: BotConfig, message: string, opts?: SayOptions): Promise<SayResult>;
