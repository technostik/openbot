import type { BotStore } from "./store.js";
import type { AutomationSpec, BotConfig } from "./types.js";
export declare const AUTO_PREFIX = "openbot:";
export declare const nativeName: (bot: string, id: string) => string;
export declare const isScheduled: (bot: BotConfig, spec: AutomationSpec) => boolean;
/** The prompt each scheduled run starts with. */
export declare function standardPrompt(bot: Pick<BotConfig, "name">, spec: AutomationSpec): string;
export declare function toNativeInput(bot: BotConfig, spec: AutomationSpec, sessionID: string): {
    expires?: string | undefined;
    sessionID: string;
    name: string;
    trigger: {
        tz?: string | undefined;
        type: string;
        every: string;
        cron?: undefined;
        at?: undefined;
    } | {
        tz?: string | undefined;
        type: string;
        cron: string;
        every?: undefined;
        at?: undefined;
    } | {
        tz?: string | undefined;
        type: string;
        at: string;
        every?: undefined;
        cron?: undefined;
    };
    action: {
        type: string;
        prompt: string;
    };
};
/** Is an existing native automation the same as what we would create? */
export declare function sameAutomation(info: any, input: ReturnType<typeof toNativeInput>): boolean;
export interface NativeAutomations {
    list(): Promise<any[]>;
    create(input: any): Promise<any>;
    remove(id: string): Promise<void>;
}
export interface ReconcileDeps {
    store: BotStore;
    native: NativeAutomations;
    /** The bot's automation conversation (created in its workdir when missing). */
    ensureAutoSession(bot: BotConfig): Promise<string>;
    log?: (event: string, data?: unknown) => void;
}
export interface ReconcileReport {
    created: string[];
    removed: string[];
    kept: string[];
    errors: Array<{
        name: string;
        error: string;
    }>;
    skipped?: "locked";
}
/** Cross-instance lock (every opencode directory runs its own copy of the plugin). */
export declare function withLock<T>(store: BotStore, fn: () => Promise<T>): Promise<T | undefined>;
export declare function reconcile(deps: ReconcileDeps): Promise<ReconcileReport>;
/** Native automations of one bot, for display (next run, run count, last outcome). */
export declare function describeAutomations(native: Pick<NativeAutomations, "list">, bot: BotConfig): Promise<{
    scheduled: boolean;
    native: {
        status: any;
        nextDueAt: any;
        runCount: any;
        lastRunAt: any;
        lastOutcome: any;
    } | null;
    id: string;
    every?: string;
    cron?: string;
    at?: string;
    tz?: string;
    prompt?: string;
    enabled?: boolean;
    expires?: string;
}[]>;
