/** Agent ids that already exist in opencode; a bot must never shadow them. */
export declare const RESERVED_NAMES: ReadonlySet<string>;
/** Returns an error message, or undefined when the name is acceptable. */
export declare function nameProblem(name: unknown): string | undefined;
export declare function assertName(name: unknown): asserts name is string;
