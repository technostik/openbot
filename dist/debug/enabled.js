/**
 * The single switch for everything under src/debug.
 * On when the plugin option `debug` is true, else when $OPENBOT_DEBUG is 1/true.
 * A release build can simply default this to false (it already does).
 */
export function debugEnabled(options, env = process.env) {
    if (typeof options?.debug === "boolean")
        return options.debug;
    const v = env.OPENBOT_DEBUG?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
}
