import type { BotStore } from "./store.js";
export type InboxLevel = "info" | "attention";
export type InboxStatus = "open" | "read" | "dismissed" | "answered";
export interface InboxItem {
    id: string;
    at: string;
    level: InboxLevel;
    title?: string;
    message: string;
    /** The conversation where the bot raised it (open it to see context, reply there). */
    sessionID?: string;
    status: InboxStatus;
    answer?: string;
    answeredAt?: string;
}
export declare function readInbox(store: BotStore, bot: string): InboxItem[];
export declare function addInboxItem(store: BotStore, bot: string, input: {
    level: InboxLevel;
    message: string;
    title?: string;
    sessionID?: string;
}): InboxItem;
export declare function updateInboxItem(store: BotStore, bot: string, id: string, patch: Partial<Pick<InboxItem, "status" | "answer">>): InboxItem | undefined;
export declare const openItems: (store: BotStore, bot: string) => InboxItem[];
