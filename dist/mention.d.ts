/** `@botname` handling: detection in a prompt, and the delegation text that replaces it. */
export interface PromptLike {
    text: string;
    agents?: readonly {
        name: string;
        mention?: {
            start: number;
            end: number;
            text: string;
        };
    }[];
}
export interface Mention {
    bot: string;
    /** The user's message with the mention removed. */
    message: string;
}
export declare function findMention(prompt: PromptLike, isBot: (name: string) => boolean): Mention | undefined;
/**
 * What the user's own agent receives instead of the raw `@bot ...` text.
 * The agent hands the message to the bot with bot_say and relays the answer.
 */
export declare function delegationText(mention: Mention): string;
