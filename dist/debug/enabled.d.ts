/**
 * The single switch for everything under src/debug.
 * On when the plugin option `debug` is true, else when $OPENBOT_DEBUG is 1/true.
 * A release build can simply default this to false (it already does).
 */
export declare function debugEnabled(options: Record<string, unknown> | undefined, env?: NodeJS.ProcessEnv): boolean;
