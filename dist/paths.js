import os from "node:os";
import path from "node:path";
/** Expands a leading `~` and resolves to an absolute path. */
export function expandPath(input, base) {
    let p = input.trim();
    if (p === "~" || p.startsWith("~/"))
        p = path.join(os.homedir(), p.slice(1));
    return path.isAbsolute(p) ? path.normalize(p) : path.resolve(base ?? process.cwd(), p);
}
/**
 * Where bots live on disk.
 * Priority: plugin option `root` > $OPENBOT_HOME > $XDG_DATA_HOME/openbot > ~/.local/share/openbot
 */
export function resolveRoot(options, env = process.env) {
    const opt = options?.root;
    if (typeof opt === "string" && opt.trim())
        return expandPath(opt);
    if (env.OPENBOT_HOME?.trim())
        return expandPath(env.OPENBOT_HOME);
    const data = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
    return path.join(data, "openbot");
}
