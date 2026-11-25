/**
 * The bot_* tools: how users (through any agent) and bots themselves create,
 * configure, inspect and talk to bots. All are native tools (not Code Mode),
 * so any model can call them directly.
 */
import { exportToFile } from "./bundle.js";
import { listTree, readInside, renderTree } from "./files.js";
import { inspectMaterialized, agentFilePath } from "./materialize.js";
import { say, summarizeMessages } from "./session-io.js";
import { createBot, deleteBot, importBot, materializeEnv, updateBot } from "./service.js";
import { BotError } from "./types.js";
import { expandPath } from "./paths.js";
/** Turns host errors into something that tells the user what to do. */
export function explainError(message) {
    if (/Agent not found/i.test(message)) {
        return `${message}\nThe bot's agent is unknown in its working directory. openbot normally writes <workdir>/.opencode/agents/<bot>.md there; make sure the plugin option materialize is not false, then /reload. (Enable the debug option and run bot_diagnose for details.)`;
    }
    return message;
}
/** Bots currently blocked waiting on another bot: used to refuse call cycles. */
const waiting = new Set();
const MCP_SCHEMA = {
    type: "object",
    description: 'MCP servers owned by this bot: { "<name>": { "type": "local", "command": ["cmd","arg"], "environment": {"K":"V"} } | { "type": "remote", "url": "https://…", "headers": {…} } }',
    additionalProperties: true,
};
const str = (description) => ({ type: "string", description });
function publicView(bot, store) {
    return {
        ...bot,
        dir: store.botDir(bot.name),
        systemPromptFile: store.systemPath(bot.name),
        agentFile: agentFilePath(bot),
        agentFileState: inspectMaterialized(bot, materializeEnv(store)),
        mcps: bot.mcps
            ? Object.fromEntries(Object.entries(bot.mcps).map(([k, v]) => [k, v.type === "local" ? { type: "local", command: v.command } : { type: "remote", url: v.url }]))
            : undefined,
    };
}
const text = (content, metadata) => ({ content, ...(metadata ? { metadata } : {}) });
const json = (v) => text(JSON.stringify(v, null, 2));
export function buildTools(deps) {
    const { store, session, service } = deps;
    const isBot = (agent) => store.exists(agent);
    /** Resolves whom a call targets: explicit name, or the calling bot itself. */
    function target(input, ctx) {
        const name = input.name ?? (isBot(ctx.agent) ? ctx.agent : undefined);
        if (!name)
            throw new BotError('Provide "name": which bot?');
        return name;
    }
    /** A bot may only touch itself; the user's own agents may touch any bot. */
    function authorizeWrite(name, ctx) {
        if (isBot(ctx.agent) && ctx.agent !== name) {
            throw new BotError(`Bot "${ctx.agent}" is not allowed to modify bot "${name}". A bot can only change its own configuration.`);
        }
    }
    function requireHuman(ctx, what) {
        if (isBot(ctx.agent))
            throw new BotError(`Bots cannot ${what} yet. Ask the user to do it.`);
    }
    const wrap = (fn) => async (input, ctx) => {
        try {
            return await fn(input ?? {}, ctx);
        }
        catch (e) {
            if (e instanceof BotError)
                return text(`Error: ${e.message}`, { error: true });
            return text(`Error: ${explainError(e.message ?? String(e))}`, { error: true });
        }
    };
    const tools = [
        {
            name: "bot_list",
            description: "List all bots with their name, description, model and working directory.",
            input: { type: "object", properties: {} },
            options: { codemode: false },
            execute: wrap(async () => {
                const { bots, problems } = store.listWithProblems();
                return json({
                    bots: bots.map((b) => ({ name: b.name, description: b.description, model: b.model ?? "(default)", workdir: b.workdir })),
                    ...(problems.length ? { invalid: problems } : {}),
                });
            }),
        },
        {
            name: "bot_get",
            description: "Show a bot's full configuration (instructions, model, workdir, skills, MCP servers) and its conversation stats. Without a name, shows the calling bot itself.",
            input: { type: "object", properties: { name: str("Bot name (optional when called by a bot: defaults to itself)") } },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                const bot = store.require(target(input, ctx));
                const threads = store.listThreads(bot.name);
                let tokens, cost;
                if (threads[0]) {
                    try {
                        const sess = await session.get({ sessionID: threads[0].sessionID });
                        tokens = sess.tokens;
                        cost = sess.cost;
                    }
                    catch {
                        /* last session no longer exists */
                    }
                }
                return json({ ...publicView(bot, store), conversations: { count: threads.length, latest: threads[0]?.sessionID ?? null, latestTokens: tokens, latestCost: cost } });
            }),
        },
        {
            name: "bot_create",
            description: "Create a bot: a named agent with a role (instructions), a model, a working directory, optional skills allowlist and MCP servers. Afterwards it can be addressed with @name or bot_say.",
            input: {
                type: "object",
                properties: {
                    name: str('Lowercase id, e.g. "scout" or "crm-bot" (2-32 chars: a-z, 0-9, dashes)'),
                    instructions: str("The bot's master prompt: its role, goal and rules"),
                    description: str("One line: what the bot is for"),
                    model: str('Model as "provider/model" (omit to use the default model)'),
                    workdir: str("Directory where the bot works (default: a private workspace inside the bot folder)"),
                    skills: { type: "array", items: { type: "string" }, description: "Allowlist of skill names the bot may use. Omit for no restriction; [] for none." },
                    mcps: MCP_SCHEMA,
                },
                required: ["name", "instructions"],
            },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                requireHuman(ctx, "create other bots");
                const bot = createBot(service, { ...input, ...(input.workdir ? { workdir: expandPath(input.workdir) } : {}) });
                await deps.reload();
                return text(`Bot "${bot.name}" created.\nworkdir: ${bot.workdir}\nmodel: ${bot.model ?? "(default)"}\nmaster prompt (editable): ${store.systemPath(bot.name)}\nTalk to it with @${bot.name} or the bot_say tool; change it with bot_update.`, { bot: bot.name });
            }),
        },
        {
            name: "bot_update",
            description: "Change a bot's configuration. Only the fields you pass are changed; pass null to clear an optional field. A bot can call this on itself (omit name) to reconfigure itself; it cannot modify other bots.",
            input: {
                type: "object",
                properties: {
                    name: str("Bot to change (omit to change yourself)"),
                    instructions: str("New master prompt (replaces the old one entirely)"),
                    description: { type: ["string", "null"], description: "New description, or null to clear" },
                    model: { type: ["string", "null"], description: 'New model "provider/model", or null for the default' },
                    workdir: str("New working directory (a new conversation is started there)"),
                    skills: { type: ["array", "null"], items: { type: "string" }, description: "New skills allowlist, [] for none, null for unrestricted" },
                    mcps: { ...MCP_SCHEMA, type: ["object", "null"] },
                },
            },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                const name = target(input, ctx);
                authorizeWrite(name, ctx);
                const { name: _n, ...rest } = input;
                const patch = rest;
                if (!Object.keys(patch).length)
                    throw new BotError("Nothing to change: pass at least one field.");
                if (patch.workdir)
                    patch.workdir = expandPath(patch.workdir);
                const { bot, before } = updateBot(service, name, patch);
                await deps.reload();
                const changed = Object.keys(patch);
                const note = patch.workdir && patch.workdir !== before.workdir ? " Its working directory changed, so its next message starts a new conversation." : "";
                return text(`Bot "${bot.name}" updated (${changed.join(", ")}). The change applies to its next message.${note}`);
            }),
        },
        {
            name: "bot_delete",
            description: "Delete a bot: its configuration, state and local skills. Its working directory is kept if you chose a custom one. Requires confirm: true.",
            input: {
                type: "object",
                properties: { name: str("Bot to delete"), confirm: { type: "boolean", description: "Must be true" } },
                required: ["name", "confirm"],
            },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                requireHuman(ctx, "delete bots");
                if (input.confirm !== true)
                    throw new BotError("Refusing to delete without confirm: true.");
                const bot = deleteBot(service, input.name);
                await deps.reload();
                return text(`Bot "${bot.name}" deleted. Its working directory ${bot.workdir} was not touched.`);
            }),
        },
        {
            name: "bot_say",
            description: "Send a message to a bot. The bot works in its own working directory, in its own conversation (shown as a child session of this one; it remembers earlier messages) and with its own model. By default it works in the background and its answer arrives later as a background result; tell the user it was handed over. Use wait:true only if you must have the answer before continuing.",
            input: {
                type: "object",
                properties: {
                    name: str("Bot to talk to"),
                    message: str("What to tell the bot"),
                    wait: { type: "boolean", description: "true = block until the bot answers. Default false: the bot works in the background and its answer is delivered to you automatically as a background result when it finishes." },
                    timeout_seconds: { type: "number", description: "Max seconds to wait (default 300)" },
                    new_conversation: { type: "boolean", description: "Start a fresh conversation instead of continuing" },
                },
                required: ["name", "message"],
            },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                const bot = store.require(input.name);
                if (typeof input.message !== "string" || !input.message.trim())
                    throw new BotError("message must not be empty");
                const caller = isBot(ctx.agent) ? ctx.agent : undefined;
                if (caller === bot.name)
                    throw new BotError("A bot cannot send messages to itself.");
                if (waiting.has(bot.name))
                    throw new BotError(`"${bot.name}" is waiting on another bot: refusing a call cycle.`);
                // From a conversation the bot's session is a child of it, and opencode delivers its result back to the
                // caller as a background result (like a native subagent): so do not block unless asked to.
                const wait = input.wait === undefined ? !ctx.sessionID : input.wait === true;
                if (caller && wait)
                    waiting.add(caller);
                try {
                    const r = await say(session, store, bot, input.message, {
                        wait,
                        fresh: input.new_conversation === true,
                        callerSessionID: ctx.sessionID || undefined,
                        timeoutMs: (typeof input.timeout_seconds === "number" ? input.timeout_seconds : 300) * 1000,
                    });
                    const meta = { bot: bot.name, sessionID: r.sessionID, thread: r.thread, status: r.status };
                    if (r.status === "started")
                        return text(`Message handed to ${bot.name}. It is working in the background in conversation ${r.sessionID}; its answer will arrive here automatically as a background result when it finishes. Tell the user it is in progress and continue; do not wait or poll.`, meta);
                    if (r.status === "timeout")
                        return text(`${bot.name} is still working after the timeout (conversation ${r.sessionID}). Check later with bot_history.`, meta);
                    if (r.status === "failed")
                        return text(`${bot.name} failed: ${explainError(r.error ?? "the run failed")}`, { ...meta, error: true });
                    return text(r.text || `(${bot.name} finished without a text answer; see bot_history)`, meta);
                }
                finally {
                    if (caller && wait)
                        waiting.delete(caller);
                }
            }),
        },
        {
            name: "bot_history",
            description: "Inspect a bot's recent conversation: what it was asked, what it answered, which tools it used. By default the conversation of the current session, else the most recent one.",
            input: {
                type: "object",
                properties: {
                    name: str("Bot (omit for yourself)"),
                    thread: str('Which conversation: a session id, "last" (most recent), or omit for the one linked to this session'),
                    limit: { type: "number", description: "How many recent messages (default 12, max 50)" },
                },
            },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                const bot = store.require(target(input, ctx));
                const threads = store.listThreads(bot.name);
                let sessionID;
                if (typeof input.thread === "string" && input.thread.startsWith("ses_"))
                    sessionID = input.thread;
                else if (input.thread === "last")
                    sessionID = threads[0]?.sessionID;
                else
                    sessionID = store.readThreads(bot.name)[ctx.sessionID]?.sessionID ?? threads[0]?.sessionID;
                if (!sessionID)
                    return text(`${bot.name} has no conversation yet.`);
                const limit = Math.min(Math.max(Number(input.limit) || 12, 1), 50);
                const items = summarizeMessages(await session.context({ sessionID }), limit);
                return json({ bot: bot.name, sessionID, messages: items });
            }),
        },
        {
            name: "bot_conversations",
            description: "List a bot's conversations (one per place it was used, shown as child sessions), with their session ids, where they were started, and usage. Use bot_history with a session id to read one.",
            input: { type: "object", properties: { name: str("Bot (omit for yourself)") } },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                const bot = store.require(target(input, ctx));
                const known = store.listThreads(bot.name);
                const rows = await Promise.all(known.map(async (t) => {
                    let live;
                    try {
                        live = await session.get({ sessionID: t.sessionID });
                    }
                    catch {
                        /* deleted */
                    }
                    return { thread: t.key, sessionID: t.sessionID, startedFrom: t.parentID ?? null, lastUsed: t.lastAt, exists: Boolean(live), tokens: live?.tokens, cost: live?.cost };
                }));
                const others = [];
                if (session.list) {
                    try {
                        const r = await session.list({ directory: bot.workdir });
                        const arr = Array.isArray(r) ? r : (r?.data ?? []);
                        for (const s of arr)
                            if (s.agent === bot.name && !known.some((k) => k.sessionID === s.id))
                                others.push({ sessionID: s.id, title: s.title, parent: s.parentID ?? null });
                    }
                    catch {
                        /* listing is best effort */
                    }
                }
                return json({ bot: bot.name, conversations: rows, otherSessionsUsingThisBot: others });
            }),
        },
        {
            name: "bot_files",
            description: "Inspect a bot's working directory: list its files, or read one text file (path relative to the working directory).",
            input: {
                type: "object",
                properties: { name: str("Bot (omit for yourself)"), path: str("File to read, relative to the working directory (omit to list files)"), depth: { type: "number", description: "Listing depth (default 3)" } },
            },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                const bot = store.require(target(input, ctx));
                if (typeof input.path === "string" && input.path) {
                    const r = readInside(bot.workdir, input.path);
                    if (!r.ok)
                        throw new BotError(r.error);
                    return text(r.content + (r.truncated ? "\n… (truncated)" : ""));
                }
                const depth = Math.min(Math.max(Number(input.depth) || 3, 1), 6);
                const { entries } = listTree(bot.workdir, { depth });
                return text(`${bot.workdir}\n${renderTree(bot.workdir, { depth })}\n(${entries.length} entries)`);
            }),
        },
        {
            name: "bot_export",
            description: "Export a bot (config + local skills) to a portable JSON bundle file. MCP secrets are redacted unless include_secrets is true.",
            input: {
                type: "object",
                properties: { name: str("Bot to export"), path: str("Target file (default: <openbot home>/exports/<name>.openbot.json)"), include_secrets: { type: "boolean" } },
                required: ["name"],
            },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                requireHuman(ctx, "export bots");
                const r = exportToFile(store, input.name, input.path ? expandPath(input.path) : undefined, { includeSecrets: input.include_secrets === true });
                return text(`Exported "${input.name}" to ${r.path}${r.bundle.warnings.length ? "\nWarnings:\n- " + r.bundle.warnings.join("\n- ") : ""}`);
            }),
        },
        {
            name: "bot_import",
            description: "Import a bot from a bundle file made by bot_export. Use rename to import under another name, overwrite to replace an existing bot.",
            input: {
                type: "object",
                properties: {
                    path: str("Bundle file to import"),
                    rename: str("Import under this name"),
                    overwrite: { type: "boolean" },
                    workdir: str("Working directory on this machine"),
                },
                required: ["path"],
            },
            options: { codemode: false },
            execute: wrap(async (input, ctx) => {
                requireHuman(ctx, "import bots");
                const { bot, warnings } = importBot(service, { file: expandPath(input.path) }, {
                    rename: input.rename,
                    overwrite: input.overwrite === true,
                    workdir: input.workdir ? expandPath(input.workdir) : undefined,
                });
                await deps.reload();
                return text(`Imported bot "${bot.name}" (workdir ${bot.workdir}).${warnings.length ? "\nWarnings:\n- " + warnings.join("\n- ") : ""}`, { bot: bot.name });
            }),
        },
    ];
    return tools;
}
