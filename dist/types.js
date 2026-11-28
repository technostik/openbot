/**
 * Data model of a bot. This is the contract that every later feature
 * (automations, budget, Telegram, bot-to-bot) hangs off, so it is versioned
 * and only ever extended with optional fields.
 */
export const SCHEMA_VERSION = 1;
export const BOT_STATUSES = ["active", "stopped", "finished"];
export const CAPABILITY_PRESETS = ["none", "minimal", "standard", "full"];
export class BotError extends Error {
    constructor(message) {
        super(message);
        this.name = "BotError";
    }
}
