/**
 * Translation of a BotConfig into opencode primitives (agent, permissions,
 * skills, MCP servers). Pure functions over the host's "editor" objects so
 * they can be unit-tested with plain stand-ins.
 */
import { loadLocalSkills } from "./skills.js";
import { CAPABILITY_PRESETS } from "./types.js";
export const newOwned = () => ({ agents: new Set(), mcps: new Set(), skills: new Set() });
export function parseModelRef(model) {
    const [ref, variant] = model.split("#");
    const slash = ref.indexOf("/");
    return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}) };
}
/**
 * The system prompt: a short standard preamble + the user's master prompt.
 * `systemFile` is where the master prompt lives on disk, so the bot knows it can edit it.
 */
export function composeSystem(bot, systemFile) {
    const caps = describeCapabilities(bot);
    const permissions = [
        "## Permissions",
        `Preset: ${caps.preset}`,
        caps.tools === "*" ? "Tools: all" : `Tools: ${caps.tools.join(", ")} (anything else is denied)`,
        ...(caps.denyTools.length ? [`Denied tools: ${caps.denyTools.join(", ")}`] : []),
        `MCP servers: ${caps.mcpHosts.length ? caps.mcpHosts.join(", ") : "none"}`,
        ...(caps.deniedMcps.length ? [`Denied MCP servers: ${caps.deniedMcps.join(", ")}`] : []),
        caps.skills === "*" ? "Skills: all" : caps.skills === "none" ? "Skills: none" : `Skills: ${caps.skills.join(", ")}`,
        ...(caps.unknownMcps.length ? [`Unknown MCP servers in the allowlist: ${caps.unknownMcps.join(", ")}`] : []),
    ];
    const lines = [
        `You are "${bot.name}", a persistent bot running inside opencode (openbot).`,
        ...(bot.description ? [`Purpose: ${bot.description}`] : []),
        `Your working directory is ${bot.workdir}. Keep your files and notes there.`,
        `You can read and change your own configuration with the bot_get and bot_update tools, and talk to other bots with bot_say.`,
        `Memory: your state file (state.md) is shown to you at the start of every turn. Keep it current with bot_state: your goal, what is important, your todo list, what you are waiting for. Every conversation is recorded automatically; read it back with bot_history.`,
        `Reaching the user: bot_notify alerts them without waiting; the question tool asks and waits for the answer. When your goal is fully achieved call bot_status with "finished" (never if the goal runs forever). Manage your own scheduled runs with bot_automation.`,
        ...(systemFile
            ? [`Your master prompt (the "Your instructions" section below) is the file ${systemFile}. You may edit it to change your own behavior; edits apply from your next message.`]
            : []),
        "",
        ...permissions,
        "",
        "## Your instructions",
        bot.instructions,
    ];
    return lines.join("\n");
}
/** Name used for a bot-owned MCP server in the host (namespaced to avoid clashes). */
export const mcpHostName = (bot, server) => `${bot}-${server}`;
/** Id used for a bot-owned skill in the host. */
export const skillHostId = (bot, skill) => `${bot}.${skill}`;
/**
 * Skill allowlist as permission rules (later rules win). The host matches the
 * rule's resource against the skill *id*, so the bot's own skills (id
 * "<bot>.<name>") are allowed by id as well as by name.
 */
export function skillRules(bot, localSkillNames) {
    if (bot.skills === undefined)
        return [];
    const allowed = new Set([...bot.skills, ...localSkillNames, ...localSkillNames.map((n) => skillHostId(bot.name, n))]);
    return [
        { action: "skill", resource: "*", effect: "deny" },
        ...[...allowed].map((name) => ({ action: "skill", resource: name, effect: "allow" })),
    ];
}
const PRESET_DEFAULTS = {
    none: { toolMode: "list", tools: [], skills: "none", mcps: "none" },
    minimal: { toolMode: "list", tools: ["read", "glob", "grep"], skills: "none", mcps: "none" },
    standard: { toolMode: "all", tools: [], skills: "bot", mcps: "all" },
    full: { toolMode: "all", tools: [], skills: "all", mcps: "all" },
};
/**
 * Applies a bot's preset, then its explicit `tools` / `denyTools` / `mcps`
 * lists. `denyTools` is kept separate because it is applied last, when rules
 * are emitted.
 */
export function resolveCapabilities(bot, _localSkillNames = []) {
    const caps = bot.capabilities ?? {};
    const preset = CAPABILITY_PRESETS.includes(caps.preset) ? caps.preset : "standard";
    const base = PRESET_DEFAULTS[preset];
    const toolMode = caps.tools === undefined ? base.toolMode : caps.tools.includes("*") ? "all" : "list";
    const tools = toolMode === "all" ? [] : [...(caps.tools ?? base.tools)];
    const botServers = Object.keys(bot.mcps ?? {});
    const allowed = new Set();
    const unknownMcps = [];
    if (caps.mcps === undefined) {
        if (base.mcps === "all")
            for (const server of botServers)
                allowed.add(server);
    }
    else if (caps.mcps.includes("*")) {
        for (const server of botServers)
            allowed.add(server);
    }
    else {
        for (const raw of caps.mcps) {
            const local = botServers.includes(raw)
                ? raw
                : raw.startsWith(`${bot.name}-`) && botServers.includes(raw.slice(bot.name.length + 1))
                    ? raw.slice(bot.name.length + 1)
                    : undefined;
            if (local)
                allowed.add(local);
            else
                unknownMcps.push(raw);
        }
    }
    const mcps = botServers.filter((server) => allowed.has(server));
    return {
        preset,
        toolMode,
        tools,
        denyTools: [...(caps.denyTools ?? [])],
        mcps,
        deniedMcps: botServers.filter((server) => !allowed.has(server)),
        unknownMcps,
        skills: base.skills,
    };
}
export function describeCapabilities(bot, localSkillNames = []) {
    const caps = resolveCapabilities(bot, localSkillNames);
    const tools = caps.toolMode === "all" ? "*" : [...new Set([...caps.tools, "bot_*"])];
    let skills;
    if (caps.skills === "all")
        skills = "*";
    else if (caps.skills === "none")
        skills = "none";
    else if (bot.skills === undefined)
        skills = "*";
    else if (!bot.skills.length && !localSkillNames.length)
        skills = "none";
    else
        skills = [...new Set([...bot.skills, ...localSkillNames])];
    return {
        preset: caps.preset,
        tools,
        denyTools: caps.denyTools,
        mcps: caps.mcps,
        mcpHosts: caps.mcps.map((server) => mcpHostName(bot.name, server)),
        deniedMcps: caps.deniedMcps,
        unknownMcps: caps.unknownMcps,
        skills,
    };
}
function skillRulesFor(bot, localSkillNames, mode) {
    if (mode === "all")
        return [];
    if (mode === "none")
        return [{ action: "skill", resource: "*", effect: "deny" }];
    return skillRules(bot, localSkillNames);
}
/**
 * Every permission rule a bot's capabilities imply: tools, MCP servers and
 * skills, in evaluation order (later rules win). A bot without `capabilities`
 * gets exactly the old skill allowlist and no tool rules, so its behavior is
 * unchanged.
 */
export function capabilityRules(bot, localSkillNames = []) {
    const caps = resolveCapabilities(bot, localSkillNames);
    const rules = [];
    const add = (action, resource, effect) => rules.push({ action, resource, effect });
    if (caps.toolMode === "list")
        add("*", "*", "deny");
    // A configured MCP server the bot may not use is denied explicitly, so an
    // "allow all" preset can still narrow the list. Tool allows come after, so a
    // single MCP action can be re-allowed through `tools`.
    for (const server of caps.deniedMcps) {
        const host = mcpHostName(bot.name, server);
        add(`${host}_*`, "*", "deny");
        add("opencode_list_mcp_resources", host, "deny");
        add("opencode_read_mcp_resource", `${host}:*`, "deny");
    }
    if (caps.toolMode === "list")
        for (const tool of caps.tools)
            add(tool, "*", "allow");
    // In "allow all" mode the base policy already allows MCP tools, so these
    // rules are only needed to re-allow an allowed server after a deny.
    if (caps.toolMode === "list" || caps.deniedMcps.length > 0) {
        for (const server of caps.mcps) {
            const host = mcpHostName(bot.name, server);
            add(`${host}_*`, "*", "allow");
            add("opencode_list_mcp_resources", host, "allow");
            add("opencode_read_mcp_resource", `${host}:*`, "allow");
        }
    }
    if (caps.toolMode === "list" && !caps.tools.includes("bot_*"))
        add("bot_*", "*", "allow");
    rules.push(...skillRulesFor(bot, localSkillNames, caps.skills));
    for (const tool of caps.denyTools)
        add(tool, "*", "deny");
    return rules;
}
/** Registers one agent per bot; retracts agents of bots that no longer exist. */
export function applyAgents(editor, bots, owned, env) {
    const log = env.log ?? (() => { });
    const wanted = new Set(bots.map((b) => b.name));
    for (const id of [...owned.agents]) {
        if (!wanted.has(id)) {
            editor.remove(id);
            owned.agents.delete(id);
        }
    }
    for (const bot of bots) {
        if (!owned.agents.has(bot.name) && editor.get(bot.name)) {
            log(`skipping bot "${bot.name}": an agent with that id already exists`);
            continue;
        }
        const local = loadLocalSkills(env.skillsDir(bot.name)).map((s) => s.name);
        editor.update(bot.name, (a) => {
            a.name = bot.name;
            if (bot.description)
                a.description = bot.description;
            else
                delete a.description;
            a.system = composeSystem(bot, env.systemFile?.(bot.name));
            a.mode = "all";
            a.hidden = false;
            if (bot.model)
                a.model = parseModelRef(bot.model);
            else
                delete a.model;
            a.permissions = [...(a.permissions ?? []), ...capabilityRules(bot, local)];
        });
        owned.agents.add(bot.name);
    }
}
const quiet = (fn) => {
    try {
        fn();
    }
    catch {
        /* removing something absent is fine */
    }
};
const botsHere = (location, bots) => bots.filter((b) => b.workdir === location);
/**
 * Bot-owned MCP servers are registered only in the opencode instance whose
 * directory is the bot's workdir: that is where the bot's sessions run, and
 * it avoids spawning every bot's servers in every instance.
 */
export function applyWorkdirMcp(location, bots, mcp, owned) {
    const want = new Map();
    for (const bot of botsHere(location, bots)) {
        const allowed = new Set(resolveCapabilities(bot).mcps);
        for (const [server, cfg] of Object.entries(bot.mcps ?? {})) {
            if (allowed.has(server))
                want.set(mcpHostName(bot.name, server), cfg);
        }
    }
    for (const name of [...owned.mcps])
        if (!want.has(name)) {
            quiet(() => mcp.remove(name));
            owned.mcps.delete(name);
        }
    for (const [name, cfg] of want) {
        mcp.set(name, cfg);
        owned.mcps.add(name);
    }
}
/** Same scoping for the skills that ship inside a bot (`<botdir>/skills`). */
export function applyWorkdirSkills(location, bots, skills, owned, env) {
    const want = new Map();
    for (const bot of botsHere(location, bots)) {
        for (const s of loadLocalSkills(env.skillsDir(bot.name))) {
            const id = skillHostId(bot.name, s.name);
            want.set(id, { id, name: s.name, description: s.description, path: s.path, content: s.content });
        }
    }
    for (const id of [...owned.skills])
        if (!want.has(id)) {
            quiet(() => skills.remove(id));
            owned.skills.delete(id);
        }
    for (const [id, s] of want) {
        quiet(() => skills.remove(id));
        skills.add(s);
        owned.skills.add(id);
    }
}
