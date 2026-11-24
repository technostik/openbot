/** Expands a leading `~` and resolves to an absolute path. */
export declare function expandPath(input: string, base?: string): string;
/**
 * Where bots live on disk.
 * Priority: plugin option `root` > $OPENBOT_HOME > $XDG_DATA_HOME/openbot > ~/.local/share/openbot
 */
export declare function resolveRoot(options: Record<string, unknown> | undefined, env?: NodeJS.ProcessEnv): string;
