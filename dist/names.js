import { BotError } from "./types.js";
/** Agent ids that already exist in opencode; a bot must never shadow them. */
export const RESERVED_NAMES = new Set([
    "build", "plan", "general", "explore", "compaction", "title", "summary", "default", "all", "bot", "bots",
]);
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
/** Returns an error message, or undefined when the name is acceptable. */
export function nameProblem(name) {
    if (typeof name !== "string")
        return "name must be a string";
    if (!NAME_RE.test(name)) {
        return "name must be 2-32 characters: lowercase letters, digits and dashes, starting with a letter (e.g. \"scout\", \"crm-bot\")";
    }
    if (name.endsWith("-"))
        return "name must not end with a dash";
    if (RESERVED_NAMES.has(name))
        return `"${name}" is reserved by opencode`;
    return undefined;
}
export function assertName(name) {
    const p = nameProblem(name);
    if (p)
        throw new BotError(p);
}
