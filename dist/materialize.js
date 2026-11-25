/**
 * A bot works in its own directory, which opencode treats as a separate
 * instance. That instance only knows the bot's agent if the plugin is loaded
 * there too, which depends on how the plugin was installed. To make bots work
 * regardless, every bot writes its agent as a plain native agent file into its
 * working directory: <workdir>/.opencode/agents/<bot>.md
 *
 * The file is generated from bot.json + system.md (never edit it by hand) and
 * carries a marker so openbot never touches a file it did not write.
 */
import fs from "node:fs";
import path from "node:path";
import { composeSystem, skillRules } from "./host.js";
import { loadLocalSkills } from "./skills.js";
export const MARKER = "x-openbot: managed";
export const agentFilePath = (bot) => path.join(bot.workdir, ".opencode", "agents", `${bot.name}.md`);
const q = (v) => JSON.stringify(v);
export function renderAgentFile(bot, env) {
    const local = loadLocalSkills(env.skillsDir(bot.name)).map((s) => s.name);
    const rules = skillRules(bot, local);
    const front = [
        "---",
        ...(bot.description ? [`description: ${q(bot.description)}`] : []),
        "mode: all",
        ...(bot.model ? [`model: ${q(bot.model)}`] : []),
        MARKER,
        ...(rules.length ? ["permissions:", ...rules.map((r) => `  - {action: ${q(r.action)}, resource: ${q(r.resource)}, effect: ${q(r.effect)}}`)] : []),
        "---",
    ];
    return front.join("\n") + "\n" + composeSystem(bot, env.systemFile?.(bot.name)) + "\n";
}
export function materialize(bot, env) {
    const file = agentFilePath(bot);
    try {
        const content = renderAgentFile(bot, env);
        let existing;
        try {
            existing = fs.readFileSync(file, "utf8");
        }
        catch {
            /* not there yet */
        }
        if (existing !== undefined && !existing.includes(MARKER)) {
            return { status: "conflict", path: file, error: "a file with this name exists and is not managed by openbot" };
        }
        if (existing === content)
            return { status: "unchanged", path: file };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, content, "utf8");
        fs.renameSync(tmp, file);
        return { status: "written", path: file };
    }
    catch (e) {
        return { status: "error", path: file, error: e.message };
    }
}
/** Removes the agent file, but only if openbot wrote it. */
export function dematerialize(bot) {
    const file = agentFilePath(bot);
    let existing;
    try {
        existing = fs.readFileSync(file, "utf8");
    }
    catch {
        return "absent";
    }
    if (!existing.includes(MARKER))
        return "foreign";
    fs.rmSync(file, { force: true });
    // tidy up empty folders we created
    for (const dir of [path.dirname(file), path.dirname(path.dirname(file))]) {
        try {
            fs.rmdirSync(dir);
        }
        catch {
            break;
        }
    }
    return "removed";
}
/** State of the file without changing it (for diagnostics). */
export function inspectMaterialized(bot, env) {
    const file = agentFilePath(bot);
    let existing;
    try {
        existing = fs.readFileSync(file, "utf8");
    }
    catch {
        return "missing";
    }
    if (!existing.includes(MARKER))
        return "foreign";
    return existing === renderAgentFile(bot, env) ? "ok" : "stale";
}
