/**
 * Checks that everything a bot needs is configured, and says how to fix what is not.
 * Pure over a DiagEnv, so the same code runs from the server plugin, the TUI and tests.
 */
import fs from "node:fs";
import path from "node:path";
import { inspectMaterialized, agentFilePath } from "../materialize.js";
import { materializeEnv } from "../service.js";
import { loadLocalSkills } from "../skills.js";
function onPath(cmd) {
    if (path.isAbsolute(cmd))
        return fs.existsSync(cmd);
    return (process.env.PATH ?? "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, cmd)));
}
function writable(dir) {
    try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
export async function diagnose(env, only) {
    const checks = [];
    const add = (c) => checks.push(c);
    const safe = async (fn) => {
        try {
            return await fn();
        }
        catch {
            return undefined;
        }
    };
    const { store } = env;
    const { bots, problems } = store.listWithProblems();
    const models = await safe(() => env.models());
    const defaultModel = await safe(() => env.defaultModel());
    /* ---------------- global ---------------- */
    if (!only) {
        add({ scope: "global", id: "versions", level: "info", title: `openbot ${env.pluginVersion}` + (env.appVersion ? ` on opencode ${env.appVersion}` : "") });
        add(fs.existsSync(store.root) && writable(store.root)
            ? { scope: "global", id: "root", level: "ok", title: `Bot storage is writable`, detail: store.root }
            : { scope: "global", id: "root", level: fs.existsSync(store.root) ? "error" : "info", title: fs.existsSync(store.root) ? "Bot storage is not writable" : "No bot storage yet (created with the first bot)", detail: store.root, fix: "Check permissions, or set the OPENBOT_HOME environment variable / the plugin option `root`." });
        for (const p of problems) {
            add({ scope: "global", id: `invalid:${p.name}`, level: "error", title: `bots/${p.name}/bot.json is invalid`, detail: p.error, fix: `Fix the file by hand (${store.botDir(p.name)}/bot.json) or delete the folder.` });
        }
        if (env.location) {
            const here = await safe(() => env.pluginLoadedAt(env.location));
            if (here === false)
                add({ scope: "global", id: "plugin-here", level: "error", title: "openbot is not loaded in the current directory", fix: 'Add "openbot" to the `plugins` of your opencode.json (global: ~/.config/opencode/opencode.json), then /reload.' });
            else if (here)
                add({ scope: "global", id: "plugin-here", level: "ok", title: "openbot is loaded in the current directory" });
        }
        add(models === undefined ? { scope: "global", id: "models", level: "info", title: "Could not list models" } : models.length ? { scope: "global", id: "models", level: "ok", title: `${models.length} models available` } : { scope: "global", id: "models", level: "error", title: "No model is available", fix: "Configure a provider in opencode (/connect or opencode.json `providers`)." });
        add(defaultModel ? { scope: "global", id: "default-model", level: "ok", title: `Default model: ${defaultModel}` } : { scope: "global", id: "default-model", level: "warn", title: "opencode has no default model", detail: "Bots without their own model have nothing to run on.", fix: "Set `model` in opencode.json, or give each bot a model." });
        add(env.materializeEnabled ? { scope: "global", id: "materialize", level: "ok", title: "Agent files are written into bot working directories" } : { scope: "global", id: "materialize", level: "warn", title: "materialize is off", detail: "Bots only work in directories where the openbot plugin itself is loaded.", fix: "Remove the `materialize: false` plugin option." });
        if (!bots.length)
            add({ scope: "global", id: "no-bots", level: "info", title: "No bots yet" });
    }
    /* ---------------- per bot ---------------- */
    for (const bot of bots.filter((b) => !only || b.name === only)) {
        await diagnoseBot(env, bot, add, { models, defaultModel });
    }
    if (only && !bots.some((b) => b.name === only))
        add({ scope: only, id: "missing", level: "error", title: `No bot named "${only}"` });
    const counts = { ok: 0, info: 0, warn: 0, error: 0 };
    for (const c of checks)
        counts[c.level]++;
    return { checks, counts, ok: counts.error === 0 };
}
async function diagnoseBot(env, bot, add, shared) {
    const { store } = env;
    const s = bot.name;
    const safe = async (fn) => {
        try {
            return await fn();
        }
        catch {
            return undefined;
        }
    };
    // master prompt
    const sys = store.systemPath(s);
    if (!fs.existsSync(sys))
        add({ scope: s, id: "system", level: "warn", title: "Master prompt is in the legacy bot.json layout", detail: sys, fix: "It is migrated to system.md automatically on the next plugin reload." });
    else
        add({ scope: s, id: "system", level: "ok", title: `Master prompt: system.md (${bot.instructions.length} characters)`, detail: sys });
    // model
    if (bot.model) {
        const bare = bot.model.split("#")[0];
        if (shared.models === undefined)
            add({ scope: s, id: "model", level: "info", title: `Model ${bot.model} (could not verify)` });
        else if (shared.models.includes(bare))
            add({ scope: s, id: "model", level: "ok", title: `Model ${bot.model} is available` });
        else
            add({ scope: s, id: "model", level: "warn", title: `Model ${bot.model} is not in opencode's model list`, detail: "Custom providers are sometimes not listed; if the bot answers, ignore this.", fix: "Check the provider/model id (bot_update model), or connect that provider." });
    }
    else if (shared.defaultModel)
        add({ scope: s, id: "model", level: "ok", title: `No own model: uses the default (${shared.defaultModel})` });
    else
        add({ scope: s, id: "model", level: "error", title: "No model: the bot has none and opencode has no default", detail: "A run would wait forever / fail.", fix: "Give the bot a model (bot_update model: \"provider/model\")." });
    // working directory
    if (!fs.existsSync(bot.workdir))
        add({ scope: s, id: "workdir", level: "error", title: "Working directory does not exist", detail: bot.workdir, fix: "Create it, or bot_update workdir." });
    else if (!writable(bot.workdir))
        add({ scope: s, id: "workdir", level: "error", title: "Working directory is not writable", detail: bot.workdir });
    else
        add({ scope: s, id: "workdir", level: "ok", title: "Working directory is ready", detail: bot.workdir });
    // native agent file
    const state = inspectMaterialized(bot, materializeEnv(store));
    const file = agentFilePath(bot);
    if (!env.materializeEnabled)
        add({ scope: s, id: "agent-file", level: "info", title: "Agent file not managed (materialize is off)" });
    else if (state === "ok")
        add({ scope: s, id: "agent-file", level: "ok", title: "Agent file is present and up to date", detail: file });
    else if (state === "foreign")
        add({ scope: s, id: "agent-file", level: "error", title: "A file with the agent's name exists and is not managed by openbot", detail: file, fix: "Rename or remove it, then reload." });
    else
        add({ scope: s, id: "agent-file", level: "warn", title: `Agent file is ${state}`, detail: file, fix: "It is rewritten on the next plugin reload (or edit anything with bot_update)." });
    // can the bot's agent be found where it will run, and where you use it?
    const inWorkdir = await safe(() => env.agentsAt(bot.workdir));
    const loadedThere = await safe(() => env.pluginLoadedAt(bot.workdir));
    if (inWorkdir === undefined)
        add(state === "ok" ? { scope: s, id: "agent-workdir", level: "ok", title: "The agent file is in place, so the bot's agent exists in its working directory", detail: "inferred from the agent file; use the TUI report or bot_diagnose ping for a live check" } : { scope: s, id: "agent-workdir", level: "info", title: "Could not check the agent in the working directory" });
    else if (inWorkdir.includes(s))
        add({ scope: s, id: "agent-workdir", level: "ok", title: "The bot's agent exists in its working directory", detail: loadedThere ? "openbot is loaded there too" : "via the native agent file (openbot is not loaded there)" });
    else
        add({ scope: s, id: "agent-workdir", level: "error", title: "The bot's agent is NOT known in its working directory", detail: "bot_say fails with: Agent not found", fix: loadedThere ? "Run /reload in opencode." : "Enable materialize (default) so the native agent file is written, or install openbot globally." });
    if (env.location) {
        const here = await safe(() => env.agentsAt(env.location));
        if (here && !here.includes(s))
            add({ scope: s, id: "agent-here", level: "warn", title: "The bot's agent is not listed in the current directory", fix: "Run /reload; check that openbot is loaded here." });
        else if (here)
            add({ scope: s, id: "agent-here", level: "ok", title: "@" + s + " is available in the current directory" });
    }
    // skills
    const known = await safe(() => env.skillsAt(bot.workdir));
    if (bot.skills !== undefined) {
        if (!bot.skills.length)
            add({ scope: s, id: "skills", level: "info", title: "Skills: none allowed" });
        else {
            const missing = known ? bot.skills.filter((n) => !known.includes(n)) : [];
            add(missing.length ? { scope: s, id: "skills", level: "warn", title: `Allowed skills not found: ${missing.join(", ")}`, detail: `allowlist: ${bot.skills.join(", ")}` } : { scope: s, id: "skills", level: "ok", title: `Skills allowlist: ${bot.skills.join(", ")}` });
        }
    }
    else
        add({ scope: s, id: "skills", level: "info", title: "Skills: unrestricted" });
    const local = loadLocalSkills(store.skillsDir(s));
    if (local.length)
        add({ scope: s, id: "local-skills", level: "ok", title: `Local skills: ${local.map((l) => l.name).join(", ")}` });
    // MCP
    const servers = Object.entries(bot.mcps ?? {});
    if (servers.length) {
        const live = await safe(() => env.mcpAt(bot.workdir));
        for (const [name, cfg] of servers) {
            const hostName = `${s}-${name}`;
            if (cfg.type === "local" && !onPath(cfg.command[0])) {
                add({ scope: s, id: `mcp:${name}`, level: "error", title: `MCP "${name}": command not found (${cfg.command[0]})`, fix: "Install it or fix the command in bot.json." });
                continue;
            }
            const st = live?.find((m) => m.name === hostName);
            if (!live)
                add({ scope: s, id: `mcp:${name}`, level: "info", title: `MCP "${name}" configured (status unknown)` });
            else if (!st)
                add({ scope: s, id: `mcp:${name}`, level: "warn", title: `MCP "${name}" is not registered in the working directory yet`, detail: "It is registered where the openbot plugin runs in the bot's workdir.", fix: "Run /reload; make sure openbot is loaded in that directory." });
            else if (st.status && !/connected|ready|ok/i.test(st.status))
                add({ scope: s, id: `mcp:${name}`, level: "error", title: `MCP "${name}" is ${st.status}`, detail: st.error });
            else
                add({ scope: s, id: `mcp:${name}`, level: "ok", title: `MCP "${name}" is connected` });
        }
    }
    // lifecycle, state, automations, inbox, history
    const status = bot.status ?? "active";
    add(status === "active" ? { scope: s, id: "status", level: "ok", title: "Status: active" } : { scope: s, id: "status", level: "info", title: `Status: ${status}${bot.statusNote ? ` (${bot.statusNote})` : ""}`, detail: "Its automations are not scheduled while it is not active." });
    add(fs.existsSync(store.stateFile(s)) ? { scope: s, id: "state", level: "ok", title: `State file: state.md (${store.readStateFile(s).length} characters)`, detail: store.stateFile(s) } : { scope: s, id: "state", level: "warn", title: "state.md is missing", fix: "It is recreated on the next plugin reload." });
    const specs = bot.automations ?? [];
    if (loadedThere === false) {
        add({ scope: s, id: "tools-in-workdir", level: specs.length ? "error" : "warn", title: "openbot is not loaded in the bot's working directory", detail: "There the bot has no bot_state, bot_notify, bot_status or bot_automation tools, and its state is not injected into its prompt.", fix: "Install openbot globally (~/.config/opencode/opencode.json), then /reload." });
    }
    if (specs.length) {
        let errors = [];
        try {
            errors = JSON.parse(fs.readFileSync(path.join(store.botDir(s), "state", "automation.json"), "utf8")).errors ?? [];
        }
        catch {
            /* not synced yet */
        }
        if (errors.length)
            add({ scope: s, id: "automations", level: "error", title: `Automation sync failed: ${errors[0].error}`, detail: errors.map((e) => `${e.name}: ${e.error}`).join("; "), fix: "Check that automations are enabled in opencode (2.4+) and that each schedule is valid." });
        else
            add({ scope: s, id: "automations", level: "ok", title: `${specs.length} automation(s) configured${status === "active" ? " and synced" : " (not scheduled: bot is " + status + ")"}`, detail: specs.map((x) => `${x.id}: ${x.every ? "every " + x.every : x.cron ? "cron " + x.cron : "at " + x.at}${x.enabled === false ? " (disabled)" : ""}`).join("; ") });
    }
    try {
        const open = JSON.parse(fs.readFileSync(path.join(store.botDir(s), "inbox.json"), "utf8")).items?.filter((i) => i.status === "open").length ?? 0;
        if (open)
            add({ scope: s, id: "inbox", level: "info", title: `${open} item(s) waiting for you in the inbox` });
    }
    catch {
        /* no inbox yet */
    }
    try {
        const rec = Object.keys(JSON.parse(fs.readFileSync(path.join(store.botDir(s), "history", "index.json"), "utf8"))).length;
        add({ scope: s, id: "history", level: "ok", title: `History: ${rec} recorded conversation(s)` });
    }
    catch {
        add({ scope: s, id: "history", level: "info", title: "History: nothing recorded yet" });
    }
    // conversations and their last outcome
    const threads = store.listThreads(s);
    if (!threads.length)
        add({ scope: s, id: "threads", level: "info", title: "No conversation yet" });
    else {
        add({ scope: s, id: "threads", level: "ok", title: `${threads.length} conversation(s), last used ${threads[0].lastAt}` });
        const ctx = await safe(() => env.sessionContext(threads[0].sessionID));
        const idle = ctx ? [...ctx].reverse().find((m) => m?.type === "idle") : undefined;
        if (idle?.outcome === "failed")
            add({ scope: s, id: "last-run", level: "error", title: "The last run failed", detail: idle.error?.message ?? "(no message)", fix: /Agent not found/.test(idle.error?.message ?? "") ? "See the 'agent' checks above: the agent is missing where the bot runs." : undefined });
        else if (idle)
            add({ scope: s, id: "last-run", level: "ok", title: "The last run succeeded" });
    }
}
const ICON = { ok: "✓", info: "·", warn: "!", error: "✗" };
/** Short text for a tool result or a dialog. */
export function renderChecks(result, opts = {}) {
    const lines = [`${result.ok ? "OK" : "PROBLEMS"}: ${result.counts.error} error(s), ${result.counts.warn} warning(s), ${result.counts.ok} ok`];
    let scope = "";
    for (const c of result.checks) {
        if (opts.onlyProblems && (c.level === "ok" || c.level === "info"))
            continue;
        if (c.scope !== scope) {
            scope = c.scope;
            lines.push("", scope === "global" ? "[global]" : `[bot ${scope}]`);
        }
        lines.push(`${ICON[c.level]} ${c.title}`);
        if (c.detail && c.level !== "ok")
            lines.push(`    ${c.detail}`);
        if (c.fix)
            lines.push(`    fix: ${c.fix}`);
    }
    return lines.join("\n");
}
