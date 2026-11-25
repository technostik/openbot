export type DebugLog = ((event: string, data?: unknown) => void) & {
    enabled: boolean;
    file: string;
};
export declare function createDebugLog(root: string, enabled: boolean, where?: string): DebugLog;
export declare function tailLog(root: string, lines?: number): string[];
