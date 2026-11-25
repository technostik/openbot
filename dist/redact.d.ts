import type { BotConfig } from "./types.js";
/** A bot's config as safe to show or share: MCP secrets hidden, prompt omitted (it lives in system.md). */
export declare function redactBot(bot: BotConfig): unknown;
