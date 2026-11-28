import type { BotStore } from "./store.js";
export interface AuditEvent {
    /** Tool action as opencode sees it (e.g. "scout-github_create_issue"). */
    tool: string;
    sessionID?: string;
    /** For bot_say: the bot that received the message. */
    target?: string;
    /** True when the tool ran through Code Mode. */
    codemode?: boolean;
    /** Free-form note (failure, human caller, ...). */
    detail?: string;
}
export interface AuditRecord extends AuditEvent {
    bot: string;
    at: string;
}
/** Keep at most this many lines when a file is rotated. */
export declare const MAX_AUDIT_LINES = 1000;
/** Rotate once the file grows past this size (a cheap, no-read-on-every-write guard). */
export declare const AUDIT_ROTATE_BYTES: number;
export declare const auditFile: (store: BotStore, bot: string) => string;
/** Appends one event. Never throws: auditing must not break a tool call. */
export declare function recordAudit(store: BotStore, bot: string, event: AuditEvent): Promise<void>;
/** Keeps the newest `keep` lines. Exported so tests can exercise rotation directly. */
export declare function rotateAudit(file: string, keep?: number): Promise<void>;
/** Newest first, at most `limit` records. */
export declare function readAudit(store: BotStore, bot: string, limit?: number): AuditRecord[];
export declare function countAudit(store: BotStore, bot: string): number;
export declare function isAuditableTool(tool: string): boolean;
