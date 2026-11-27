import type { SessionPort } from "./session-io.js";
import type { BotStore } from "./store.js";
export interface HistoryMeta {
    thread?: string;
    parentID?: string;
    startedAt: string;
    lastAt: string;
    /** Id of the last recorded message: where the next sync resumes. */
    cursor?: string;
    count: number;
}
export declare const historyFile: (store: BotStore, bot: string, sessionID: string) => string;
export declare function readIndex(store: BotStore, bot: string): Record<string, HistoryMeta>;
/** Appends the messages of `sessionID` that were not recorded yet. Returns how many were added. */
export declare function syncHistory(port: Pick<SessionPort, "context">, store: BotStore, bot: string, sessionID: string, meta?: {
    thread?: string;
    parentID?: string;
}): Promise<number>;
export declare function readRecorded(store: BotStore, bot: string, sessionID: string): any[];
/** Recorded conversations, most recently active first. */
export declare function listRecorded(store: BotStore, bot: string): Array<HistoryMeta & {
    sessionID: string;
}>;
/** Plain-text transcript of recorded messages, for reading in the TUI or a file. */
export declare function renderTranscript(messages: any[]): string;
