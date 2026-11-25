import { redactBot } from "../redact.js";
import { type DiagEnv, type DiagResult } from "./diagnose.js";
export { redactBot };
export declare function buildReport(env: DiagEnv, opts?: {
    bot?: string;
    logLines?: number;
}): Promise<{
    markdown: string;
    result: DiagResult;
}>;
export declare function writeReport(root: string, markdown: string): string;
