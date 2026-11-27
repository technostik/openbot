/** What a bot sees of its own state at the start of every turn. */
import type { BotStore } from "./store.js";
export declare function buildStateContext(store: BotStore, name: string): string | undefined;
/** Adds `line` at the end of the `## <heading>` section of a markdown state file (creating the section if needed). */
export declare function addToSection(md: string, heading: string, line: string): string;
