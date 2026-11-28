/**
 * The TUI's interactions (dialogs and commands), as plain functions over the
 * TUI plugin context. Kept out of the JSX file so they compile with the rest
 * and can be tested with a fake context.
 */
import fs from "node:fs";
import path from "node:path";
import { readAudit } from "./audit.js";
import { describeAutomations, standardPrompt } from "./automation.js";
import { describeCapabilities } from "./host.js";
import { readInside } from "./files.js";
import { listRecorded, readRecorded, renderTranscript } from "./history.js";
import { addToSection } from "./memory.js";
import { addInboxItem, openItems, readInbox, updateInboxItem } from "./inbox.js";
import { nameProblem } from "./names.js";
import { redactBot } from "./redact.js";
import { createBot, deleteBot, updateBot } from "./service.js";
import { say } from "./session-io.js";
import { CAPABILITY_PRESETS } from "./types.js";
import { VERSION } from "./version.js";
const clip = (s, n = 2600) => (s.length > n ? s.slice(0, n) + "\n… (clipped)" : s);
const ago = (iso) => {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const message = (e) => (e instanceof Error ? e.message : String(e));
const unwrap = (o) => (Array.isArray(o) ? o : Array.isArray(o?.data) ? o.data : []);
const at = (d, directory) => (directory ? { location: { directory } } : d.ctx.location ? { location: d.ctx.location } : undefined);
const view = (d, title, text) => d.viewer ? d.viewer(title, text) : d.ctx.ui.dialog.alert({ title, message: clip(text, 3000) });
/** The TUI's client, shaped like the session API the server side uses. */
export const clientPort = (client) => ({
    create: (i) => client.session.create(i),
    get: (i) => client.session.get(i),
    prompt: (i) => client.session.prompt(i),
    move: (i) => client.session.move(i),
    wait: async () => { },
    context: (i) => client.session.context(i),
    interrupt: (i) => client.session.interrupt(i),
    list: (i) => client.session.list(i),
});
const statusTag = (b) => ((b.status ?? "active") === "active" ? "" : ` [${b.status}]`);
/** Words shown in parentheses in the sidebar. French, because that is what the sidebar is read in. */
const SIDEBAR_STATUS = {
    active: "actif",
    stopped: "arrêté",
    finished: "terminé",
    waiting: "en attente",
};
/**
 * Sidebar parenthesis. A pending question (the bot needs an answer) wins over the
 * lifecycle status. Not persisted: automations keep following active/stopped/finished.
 */
export function sidebarStatus(status, questions) {
    const key = questions > 0 ? "waiting" : status || "active";
    return SIDEBAR_STATUS[key] ?? key;
}
/** Model picker. Resolves to "" for opencode's default, a "provider/model" id, or undefined when cancelled. */
export async function pickModel(d, title, current) {
    const options = [{ title: "Default model", value: "", description: "use whatever opencode uses by default" }];
    const cur = d.ctx.ui.model.current();
    if (cur)
        options.push({ title: `Same as the current model (${cur.providerID}/${cur.modelID})`, value: `${cur.providerID}/${cur.modelID}` });
    try {
        const models = unwrap(await d.ctx.client.model.list(at(d)));
        for (const m of models) {
            const id = `${m.providerID}/${m.modelID ?? m.id}`;
            options.push({ title: m.name ?? String(m.modelID ?? m.id), value: id, description: id, category: m.providerID });
        }
    }
    catch {
        /* model list is best effort */
    }
    return d.ctx.ui.dialog.select({ title, options, current: current ?? "" });
}
export async function createBotFlow(d) {
    const { dialog, toast } = d.ctx.ui;
    let name = "";
    for (;;) {
        const input = await dialog.prompt({ title: "Create bot: name", description: "Lowercase letters, digits and dashes. You will talk to it with @name.", placeholder: "scout" });
        if (input === undefined)
            return;
        name = input.trim().toLowerCase();
        const problem = nameProblem(name) ?? (d.store.exists(name) ? `A bot named "${name}" already exists.` : undefined);
        if (!problem)
            break;
        await dialog.alert({ title: "Invalid name", message: problem });
    }
    const role = await dialog.prompt({ title: "Create bot: role", description: "Its master prompt: role, goal, rules. You can edit it later (system.md).", placeholder: "You find potential business partners on the web and keep a CRM in crm.md" });
    if (!role?.trim())
        return;
    const model = await pickModel(d, "Create bot: model");
    if (model === undefined)
        return;
    const def = d.store.defaultWorkdir(name);
    const wd = await dialog.prompt({ title: "Create bot: working directory", description: "Where it works and keeps its files. Empty = its private workspace.", placeholder: def });
    if (wd === undefined)
        return;
    try {
        createBot(d.service, { name, instructions: role, ...(model ? { model } : {}), ...(wd.trim() ? { workdir: wd.trim() } : {}) });
        toast.show({ title: "Bot created", message: `@${name} is ready. Mention it in a prompt, or open it from the sidebar.`, variant: "success" });
    }
    catch (e) {
        await dialog.alert({ title: "Could not create the bot", message: message(e) });
    }
}
/** Pick one of the bots, then open its menu. */
export async function botsFlow(d) {
    const bots = d.store.list();
    if (!bots.length) {
        if (await d.ctx.ui.dialog.confirm({ title: "No bots yet", message: "Create your first bot now?", label: { confirm: "Create bot" } }))
            await createBotFlow(d);
        return;
    }
    const name = await d.ctx.ui.dialog.select({
        title: "Bots",
        options: bots.map((b) => ({ title: `@${b.name}${statusTag(b)}`, value: b.name, description: b.description ?? b.model ?? "default model", footer: `${openItems(d.store, b.name).length ? openItems(d.store, b.name).length + " waiting · " : ""}${d.store.listThreads(b.name).length} conversation(s)` })),
        actions: [{ bind: "ctrl+n", title: "new bot", selection: "none", onTrigger: () => void createBotFlow(d) }],
    });
    if (name)
        await botMenuFlow(d, name);
}
export async function botMenuFlow(d, name) {
    const { dialog } = d.ctx.ui;
    for (;;) {
        const bot = d.store.get(name);
        if (!bot)
            return;
        const n = d.store.listThreads(name).length;
        const waiting = openItems(d.store, name).length;
        const autos = bot.automations ?? [];
        const choice = await dialog.select({
            title: `@${name}${statusTag(bot)}`,
            options: [
                { title: "Inbox", value: "inbox", description: waiting ? `${waiting} thing(s) the bot wants you to see` : "alerts and questions from the bot" },
                { title: "Status", value: "status", description: `${bot.status ?? "active"}${bot.statusNote ? `: ${bot.statusNote}` : ""} (stop, resume, finished)` },
                { title: "State", value: "state", description: "its working memory: goal, important, todo" },
                { title: "Automations", value: "autos", description: autos.length ? `${autos.length} scheduled run(s)` : "none yet: schedule recurring work" },
                { title: "Conversations", value: "conv", description: `${n} live, ${listRecorded(d.store, name).length} recorded: open or read the history` },
                { title: "Master prompt", value: "prompt", description: "view or edit what the bot is told to be" },
                { title: "Working directory", value: "files", description: `browse ${bot.workdir}` },
                { title: "Bot folder", value: "folder", description: "system.md, state.md, history, inbox, skills" },
                { title: "Model", value: "model", description: bot.model ?? "default model" },
                { title: "Permissions", value: "perms", description: `${describeCapabilities(bot).preset} preset: tools, MCP, skills` },
                { title: "Audit log", value: "audit", description: "recent sensitive tool use (MCP, third-party tools, bot_say)" },
                { title: "Configuration", value: "config", description: "bot.json (secrets hidden)" },
                ...(d.debug ? [{ title: "Diagnose", value: "diag", description: "check everything this bot needs", category: "Debug" }, { title: "Generate report", value: "report", description: "write a full markdown report", category: "Debug" }] : []),
                { title: "Delete bot", value: "delete", description: "removes its config; the working directory is kept", category: "Danger" },
            ],
        });
        if (!choice)
            return;
        if (choice === "conv") {
            if (await conversationsFlow(d, name))
                return;
        }
        else if (choice === "inbox") {
            if (await inboxFlow(d, name))
                return;
        }
        else if (choice === "status")
            await statusFlow(d, name);
        else if (choice === "state")
            await stateFlow(d, name);
        else if (choice === "autos")
            await automationsFlow(d, name);
        else if (choice === "prompt")
            await promptFlow(d, name);
        else if (choice === "files")
            await browseFlow(d, `@${name}: working directory`, bot.workdir);
        else if (choice === "folder")
            await browseFlow(d, `@${name}: bot folder`, d.store.botDir(name));
        else if (choice === "model")
            await modelFlow(d, name);
        else if (choice === "perms")
            await permissionsFlow(d, name);
        else if (choice === "audit")
            await auditFlow(d, name);
        else if (choice === "config")
            await view(d, `@${name}: bot.json`, JSON.stringify(redactBot(bot), null, 2));
        else if (choice === "diag")
            await diagnoseFlow(d, name, false);
        else if (choice === "report")
            await diagnoseFlow(d, name, true);
        else if (choice === "delete") {
            if (await dialog.confirm({ title: `Delete @${name}?`, message: "Its configuration, state, history and local skills are removed. The working directory is not touched.", label: { confirm: "Delete" } })) {
                try {
                    deleteBot(d.service, name);
                    d.ctx.ui.toast.show({ message: `@${name} deleted`, variant: "info" });
                }
                catch (e) {
                    await dialog.alert({ title: "Could not delete", message: message(e) });
                }
                return;
            }
        }
    }
}
/* ------------------------------------------------------------------ */
/* Browsing files (working directory, bot folder), with a real viewer.  */
/* ------------------------------------------------------------------ */
const IGNORE = new Set([".git", "node_modules", ".DS_Store"]);
export async function browseFlow(d, title, root) {
    const { dialog } = d.ctx.ui;
    let rel = "";
    for (;;) {
        const dir = path.join(root, rel);
        let names = [];
        try {
            names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !IGNORE.has(e.name));
        }
        catch {
            /* missing directory */
        }
        if (!fs.existsSync(root))
            return void (await dialog.alert({ title, message: `${root}\n\n(does not exist yet; it is created when the bot first works)` }));
        names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        const options = [];
        if (rel)
            options.push({ title: "..", value: "..", description: "up one level" });
        for (const e of names) {
            const full = path.join(dir, e.name);
            try {
                const st = fs.statSync(full);
                if (e.isDirectory())
                    options.push({ title: e.name + "/", value: "d:" + e.name, description: `${fs.readdirSync(full).length} item(s)` });
                else
                    options.push({ title: e.name, value: "f:" + e.name, description: `${st.size} B`, footer: st.mtime.toISOString().slice(0, 16).replace("T", " ") });
            }
            catch {
                /* vanished */
            }
        }
        if (!options.length)
            options.push({ title: "(empty)", value: "..", description: rel ? "go up" : "this directory is empty" });
        const pick = await dialog.select({ title: `${title}: /${rel}`, placeholder: "Enter opens a folder or reads a file", options });
        if (!pick)
            return;
        if (pick === "..") {
            if (!rel)
                return;
            rel = path.dirname(rel) === "." ? "" : path.dirname(rel);
        }
        else if (pick.startsWith("d:"))
            rel = path.join(rel, pick.slice(2));
        else if (pick.startsWith("f:")) {
            const file = path.join(rel, pick.slice(2));
            const r = readInside(root, file, 400_000);
            if (!r.ok) {
                await dialog.alert({ title: file, message: r.error });
                continue;
            }
            let body = r.content;
            if (file.endsWith(".jsonl")) {
                try {
                    body = renderTranscript(body.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
                }
                catch { /* show raw */ }
            }
            await view(d, file, body + (r.truncated ? "\n\n… (file is longer; showing the first 400 KB)" : ""));
        }
    }
}
/* ------------------------------------------------------------------ */
/* Status, state, automations                                           */
/* ------------------------------------------------------------------ */
async function statusFlow(d, name) {
    const { dialog, toast } = d.ctx.ui;
    const bot = d.store.require(name);
    const choice = await dialog.select({
        title: `@${name}: status`,
        current: bot.status ?? "active",
        options: [
            { title: "Active", value: "active", description: "works; its automations are scheduled" },
            { title: "Stopped", value: "stopped", description: "paused by you: running work is interrupted, automations are removed" },
            { title: "Finished", value: "finished", description: "goal achieved: automations are removed (reopen any time)" },
        ],
    });
    if (!choice || choice === (bot.status ?? "active"))
        return;
    const note = choice === "active" ? undefined : await dialog.prompt({ title: `@${name} → ${choice}`, description: "Optional note (why)", placeholder: "e.g. waiting for the budget decision" });
    if (note === undefined && choice !== "active")
        return;
    try {
        d.store.setStatus(name, choice, note ?? undefined);
        if (choice !== "active")
            for (const t of d.store.listThreads(name))
                await d.ctx.client.session.interrupt({ sessionID: t.sessionID }).catch(() => { });
        toast.show({ message: `@${name} is now ${choice}`, variant: "info" });
    }
    catch (e) {
        await dialog.alert({ title: "Could not change the status", message: message(e) });
    }
}
async function stateFlow(d, name) {
    const { dialog, toast } = d.ctx.ui;
    const act = await dialog.select({
        title: `@${name}: state`,
        options: [
            { title: "Read the state", value: "read", description: d.store.stateFile(name) },
            { title: "Add a todo", value: "todo", description: 'append to "Todo"' },
            { title: "Add something important", value: "important", description: 'append to "Important"' },
            { title: "Note something the bot should know", value: "note", description: 'append to "Notes"' },
        ],
    });
    if (!act)
        return;
    if (act === "read")
        return view(d, `@${name}: state.md`, d.store.readStateFile(name) || "(empty)");
    const heading = act === "todo" ? "Todo" : act === "important" ? "Important" : "Notes";
    const text = await dialog.prompt({ title: `@${name}: ${heading}`, placeholder: act === "todo" ? "Contact the host of …" : "…" });
    if (!text?.trim())
        return;
    try {
        d.store.writeStateFile(name, addToSection(d.store.readStateFile(name), heading, act === "todo" ? `- [ ] ${text.trim()}` : `- ${text.trim()}`));
        toast.show({ message: `Added to ${heading}`, variant: "success" });
    }
    catch (e) {
        await dialog.alert({ title: "Could not update the state", message: message(e) });
    }
}
async function automationsFlow(d, name) {
    const { dialog, toast } = d.ctx.ui;
    for (;;) {
        const bot = d.store.require(name);
        const rows = await describeAutomations({ list: async () => unwrap(await d.ctx.client.experimental.automation.list(at(d))) }, bot);
        const sched = (r) => (r.every ? `every ${r.every}` : r.cron ? `cron ${r.cron}${r.tz ? " " + r.tz : ""}` : `at ${r.at}`);
        const pick = await dialog.select({
            title: `@${name}: automations${(bot.status ?? "active") === "active" ? "" : ` (not scheduled: bot is ${bot.status})`}`,
            options: [
                ...rows.map((r) => ({
                    title: r.id,
                    value: "a:" + r.id,
                    description: `${sched(r)}${r.enabled === false ? " · disabled" : ""}${r.native ? ` · ${r.native.status}, ran ${r.native.runCount ?? 0}x${r.native.lastOutcome ? `, last ${r.native.lastOutcome}` : ""}` : r.scheduled ? " · not synced yet" : ""}`,
                })),
                { title: "+ Add an automation", value: "add", description: "schedule recurring work" },
            ],
        });
        if (!pick)
            return;
        try {
            if (pick === "add") {
                const id = (await dialog.prompt({ title: "New automation: id", placeholder: "daily-scan" }))?.trim();
                if (!id)
                    continue;
                const kind = await dialog.select({ title: "Schedule", options: [{ title: "Every…", value: "every", description: '"30 minutes", "6 hours", "1 day" (at least 1 minute)' }, { title: "Cron", value: "cron", description: '"0 9 * * 1-5"' }, { title: "Once", value: "at", description: '"in 10 minutes" or "2026-12-01T09:00"' }] });
                if (!kind)
                    continue;
                const value = (await dialog.prompt({ title: `Schedule (${kind})`, placeholder: kind === "every" ? "6 hours" : kind === "cron" ? "0 9 * * 1-5" : "in 10 minutes" }))?.trim();
                if (!value)
                    continue;
                const prompt = (await dialog.prompt({ title: "Extra instructions (optional)", description: "Added to the standard routine (read state, work, update state).", placeholder: "Focus on podcasts" }))?.trim();
                updateBot(d.service, name, { automations: [...(bot.automations ?? []), { id, [kind]: value, ...(prompt ? { prompt } : {}) }] });
                toast.show({ message: `Automation "${id}" added`, variant: "success" });
                continue;
            }
            const id = pick.slice(2);
            const spec = (bot.automations ?? []).find((x) => x.id === id);
            const act = await dialog.select({
                title: `@${name}: ${id}`,
                options: [
                    { title: "Run now", value: "run", description: "start one run immediately in the bot's automation conversation" },
                    { title: spec.enabled === false ? "Enable" : "Disable", value: "toggle", description: "keep it in bot.json but " + (spec.enabled === false ? "schedule it" : "stop scheduling it") },
                    { title: "Edit extra instructions", value: "prompt", description: spec.prompt ?? "(none)" },
                    { title: "Remove", value: "remove", category: "Danger" },
                ],
            });
            if (!act)
                continue;
            if (act === "run") {
                if ((bot.status ?? "active") !== "active") {
                    await dialog.alert({ title: "Not active", message: `@${name} is ${bot.status}. Set it active first.` });
                    continue;
                }
                const r = await say(clientPort(d.ctx.client), d.store, bot, standardPrompt(bot, spec), { wait: false, key: "auto" });
                toast.show({ message: `Run started for @${name} (${r.sessionID.slice(0, 12)}…)`, variant: "success" });
            }
            else if (act === "toggle") {
                updateBot(d.service, name, { automations: (bot.automations ?? []).map((x) => (x.id === id ? { ...x, enabled: x.enabled === false } : x)) });
            }
            else if (act === "prompt") {
                const text = await dialog.prompt({ title: `${id}: extra instructions`, value: spec.prompt ?? "" });
                if (text !== undefined)
                    updateBot(d.service, name, { automations: (bot.automations ?? []).map((x) => (x.id === id ? { ...x, ...(text.trim() ? { prompt: text.trim() } : { prompt: undefined }) } : x)) });
            }
            else if (act === "remove" && (await dialog.confirm({ title: `Remove "${id}"?`, message: "It stops being scheduled." }))) {
                updateBot(d.service, name, { automations: (bot.automations ?? []).filter((x) => x.id !== id) });
            }
        }
        catch (e) {
            await dialog.alert({ title: "Automation", message: message(e) });
        }
    }
}
/** Forms (e.g. the question tool) waiting for an answer in a bot's conversations. */
export async function pendingQuestions(d) {
    const out = [];
    const bots = d.store.list();
    const dirs = [...new Set(bots.map((b) => b.workdir))];
    for (const dir of dirs) {
        let forms = [];
        try {
            forms = unwrap(await d.ctx.client.form.list({ location: { directory: dir } }));
        }
        catch {
            continue;
        }
        for (const f of forms) {
            const bot = bots.find((b) => b.workdir === dir && (d.store.isBotSession(b.name, f.sessionID) || listRecorded(d.store, b.name).some((r) => r.sessionID === f.sessionID)));
            if (bot)
                out.push({ bot: bot.name, sessionID: f.sessionID, formID: f.id, title: f.title ?? "Question", fields: f.fields ?? [] });
        }
    }
    return out;
}
const fieldKey = (f, i) => f.key ?? f.id ?? f.name ?? `q${i}`;
/** The host puts the question text in `description` and a short header in `title`. */
export const fieldText = (f) => f.description ?? f.title ?? f.question ?? f.label ?? "(question)";
async function answerQuestion(d, q) {
    const { dialog } = d.ctx.ui;
    const answer = {};
    for (let i = 0; i < q.fields.length; i++) {
        const f = q.fields[i];
        const options = f.options ?? [];
        let value;
        if (options.length) {
            value = await dialog.select({ title: `@${q.bot}: ${fieldText(f)}`, options: [...options.map((o) => ({ title: String(o.label ?? o.value), value: String(o.value ?? o.label), description: o.description })), { title: "Other…", value: "\u0000other", description: "type your own answer" }] });
            if (value === "\u0000other")
                value = await dialog.prompt({ title: fieldText(f) });
        }
        else
            value = await dialog.prompt({ title: `@${q.bot}: ${fieldText(f)}` });
        if (value === undefined)
            return false;
        answer[fieldKey(f, i)] = value;
    }
    try {
        await d.ctx.client.session.form.reply({ sessionID: q.sessionID, formID: q.formID, answer });
        d.ctx.ui.toast.show({ message: `Answered @${q.bot}`, variant: "success" });
        return true;
    }
    catch (e) {
        await dialog.alert({ title: "Could not send the answer", message: message(e) });
        return false;
    }
}
/** Everything waiting for you (one bot, or all). Returns true when it navigated away. */
export async function inboxFlow(d, only) {
    const { dialog } = d.ctx.ui;
    for (;;) {
        const names = only ? [only] : d.store.list().map((b) => b.name);
        const waiting = [
            ...(await pendingQuestions(d)).filter((q) => !only || q.bot === only).map((q) => ({ kind: "question", q })),
            ...names.flatMap((n) => openItems(d.store, n).map((item) => ({ kind: "alert", bot: n, item }))).sort((a, b) => b.item.at.localeCompare(a.item.at)),
        ];
        if (!waiting.length) {
            await dialog.alert({ title: only ? `@${only}: inbox` : "Inbox", message: "Nothing is waiting for you." });
            return false;
        }
        const pick = await dialog.select({
            title: only ? `@${only}: waiting for you` : "Waiting for you",
            options: waiting.map((w, i) => w.kind === "question"
                ? { title: `? @${w.q.bot}: ${fieldText(w.q.fields[0] ?? {}).slice(0, 70)}`, value: i, description: "a question: the bot is waiting for your answer", footer: "question" }
                : { title: `${w.item.level === "attention" ? "! " : ""}@${w.bot}: ${w.item.title ?? w.item.message.slice(0, 60)}`, value: i, description: w.item.message.slice(0, 110), footer: w.item.at.slice(0, 16).replace("T", " ") }),
        });
        if (pick === undefined)
            return false;
        const w = waiting[pick];
        if (w.kind === "question") {
            const act = await dialog.select({ title: `@${w.q.bot}: question`, options: [{ title: "Answer", value: "answer" }, { title: "Open the conversation", value: "open" }] });
            if (act === "answer")
                await answerQuestion(d, w.q);
            else if (act === "open")
                return openSession(d, w.q.sessionID);
            continue;
        }
        const act = await dialog.select({
            title: `@${w.bot}: ${w.item.title ?? "alert"}`,
            options: [
                { title: "Read", value: "read", description: "the full message" },
                { title: "Reply to the bot", value: "reply", description: "send it a message about this" },
                ...(w.item.sessionID ? [{ title: "Open the conversation", value: "open", description: "where the bot raised it" }] : []),
                { title: "Mark as read", value: "mark" },
                { title: "Dismiss", value: "dismiss" },
            ],
        });
        if (act === "read")
            await view(d, `@${w.bot}: ${w.item.title ?? "alert"}`, `${w.item.at}\n\n${w.item.message}`);
        else if (act === "reply") {
            const text = await dialog.prompt({ title: `Reply to @${w.bot}`, placeholder: "Go ahead with option B." });
            if (text?.trim()) {
                try {
                    const bot = d.store.require(w.bot);
                    const sessionID = w.item.sessionID ?? (await say(clientPort(d.ctx.client), d.store, bot, `You asked: "${w.item.message}"\nMy answer: ${text.trim()}`, { wait: false, key: "auto" })).sessionID;
                    if (w.item.sessionID)
                        await d.ctx.client.session.prompt({ sessionID, text: `Reply to your alert "${w.item.title ?? w.item.message.slice(0, 60)}":\n${text.trim()}` });
                    updateInboxItem(d.store, w.bot, w.item.id, { status: "answered", answer: text.trim() });
                    d.ctx.ui.toast.show({ message: `Sent to @${w.bot}`, variant: "success" });
                }
                catch (e) {
                    await dialog.alert({ title: "Could not send the reply", message: message(e) });
                }
            }
        }
        else if (act === "open" && w.item.sessionID)
            return openSession(d, w.item.sessionID);
        else if (act === "mark")
            updateInboxItem(d.store, w.bot, w.item.id, { status: "read" });
        else if (act === "dismiss")
            updateInboxItem(d.store, w.bot, w.item.id, { status: "dismissed" });
    }
}
function openSession(d, sessionID) {
    d.ctx.ui.dialog.clear();
    d.ctx.ui.router.navigate({ type: "session", sessionID });
    return true;
}
/** Used by the TUI to turn bot-originated alerts into notifications. */
export { addInboxItem, readInbox };
async function modelFlow(d, name) {
    const bot = d.store.require(name);
    const model = await pickModel(d, `@${name}: model`, bot.model);
    if (model === undefined)
        return;
    try {
        updateBot(d.service, name, { model: model || null });
        d.ctx.ui.toast.show({ message: `@${name} now uses ${model || "the default model"}`, variant: "success" });
    }
    catch (e) {
        await d.ctx.ui.dialog.alert({ title: "Could not change the model", message: message(e) });
    }
}
const PRESET_HELP = {
    none: "only the bot_* tools; no MCP servers, no skills",
    minimal: "read the workspace with read/glob/grep plus bot_*; no MCP servers, no skills",
    standard: "current behavior: all tools, the bot's MCP servers and its skills",
    full: "all tools, the bot's MCP servers and every skill",
};
const presetSummary = (bot) => {
    const caps = describeCapabilities(bot);
    const tools = caps.tools === "*" ? "all tools" : caps.tools.join(", ") || "no tools";
    const skills = caps.skills === "*" ? "all skills" : caps.skills === "none" ? "no skills" : `${caps.skills.length} skill(s)`;
    return `${tools}; ${caps.mcpHosts.length} MCP; ${skills}`;
};
async function editCapabilityList(d, bot, key) {
    const { dialog } = d.ctx.ui;
    const current = bot.capabilities?.[key];
    const labels = { tools: "allowed tools", denyTools: "denied tools", mcps: "MCP servers" };
    const act = await dialog.select({
        title: `@${bot.name}: ${labels[key]}`,
        options: [
            { title: "Use the preset", value: "preset", description: "remove this explicit list and follow the preset" },
            { title: "All (*)", value: "all", description: key === "mcps" ? "every MCP server of this bot" : "every tool" },
            { title: "Edit the list", value: "edit", description: current?.length ? current.join(", ") : "empty" },
        ],
    });
    if (!act)
        return undefined;
    const next = { ...(bot.capabilities ?? {}) };
    if (act === "preset")
        delete next[key];
    else if (act === "all")
        next[key] = ["*"];
    else {
        const text = await dialog.prompt({
            title: `@${bot.name}: ${labels[key]}`,
            description: key === "mcps" ? "Comma-separated server names from the bot's mcps (or host names)." : "Comma-separated tool actions, e.g. read, edit, shell, bot_*.",
            value: (current ?? []).join(", "),
            placeholder: key === "mcps" ? "github, slack" : "read, edit, bot_*",
        });
        if (text === undefined)
            return undefined;
        next[key] = text
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return Object.keys(next).length ? next : null;
}
async function permissionsFlow(d, name) {
    const { dialog, toast } = d.ctx.ui;
    for (;;) {
        const bot = d.store.require(name);
        const caps = describeCapabilities(bot);
        const choice = await dialog.select({
            title: `@${name}: permissions`,
            options: [
                { title: "Preset", value: "preset", description: `${caps.preset}: ${presetSummary(bot)}` },
                { title: "Allowed tools", value: "tools", description: caps.tools === "*" ? "all tools" : caps.tools.join(", ") || "none" },
                { title: "Denied tools", value: "denyTools", description: caps.denyTools.length ? caps.denyTools.join(", ") : "none" },
                { title: "MCP servers", value: "mcps", description: caps.mcpHosts.length ? caps.mcpHosts.join(", ") : "none" },
                { title: "Reset to the default preset", value: "reset", description: "remove capabilities (standard preset)", category: "Danger" },
            ],
        });
        if (!choice)
            return;
        try {
            if (choice === "preset") {
                const preset = await dialog.select({
                    title: `@${name}: permission preset`,
                    current: caps.preset,
                    options: CAPABILITY_PRESETS.map((p) => ({ title: p, value: p, description: PRESET_HELP[p] })),
                });
                if (!preset)
                    continue;
                updateBot(d.service, name, { capabilities: { ...(bot.capabilities ?? {}), preset } });
                toast.show({ message: `@${name}: preset ${preset}`, variant: "success" });
            }
            else if (choice === "reset") {
                if (!(await dialog.confirm({ title: `@${name}: reset permissions?`, message: "Remove every explicit list and use the standard preset (current behavior).", label: { confirm: "Reset" } })))
                    continue;
                updateBot(d.service, name, { capabilities: null });
                toast.show({ message: `@${name}: permissions reset to standard`, variant: "success" });
            }
            else {
                const key = choice;
                const next = await editCapabilityList(d, bot, key);
                if (next === undefined)
                    continue;
                updateBot(d.service, name, { capabilities: next });
                toast.show({ message: `@${name}: ${key} updated`, variant: "success" });
            }
        }
        catch (e) {
            await dialog.alert({ title: "Could not change the permissions", message: message(e) });
        }
    }
}
async function auditFlow(d, name) {
    const rows = readAudit(d.store, name, 100);
    if (!rows.length) {
        await d.ctx.ui.dialog.alert({ title: `@${name}: audit log`, message: "No sensitive tool use recorded yet. MCP servers, third-party tools and bot_say are audited." });
        return;
    }
    const text = rows
        .map((r) => `${r.at}  ${r.tool}${r.target ? ` -> ${r.target}` : ""}${r.sessionID ? `  [${r.sessionID}]` : ""}${r.codemode ? " (code mode)" : ""}${r.detail ? `  ${r.detail}` : ""}`)
        .join("\n");
    await view(d, `@${name}: audit log (${rows.length} newest)`, text);
}
async function promptFlow(d, name) {
    const { dialog } = d.ctx.ui;
    const bot = d.store.require(name);
    const file = d.store.systemPath(name);
    const act = await dialog.select({
        title: `@${name}: master prompt`,
        options: [
            { title: "View", value: "view", description: file },
            { title: "Replace", value: "replace", description: "edit the whole text here" },
            { title: "Add an instruction", value: "append", description: "append a line to the prompt" },
        ],
    });
    try {
        if (act === "view")
            await dialog.alert({ title: `@${name}: ${file}`, message: clip(bot.instructions, 3000) + `\n\n(edit this file in any editor; changes apply within seconds)` });
        else if (act === "replace") {
            const text = await dialog.prompt({ title: `@${name}: master prompt`, description: `Stored in ${file}`, value: bot.instructions });
            if (text?.trim())
                updateBot(d.service, name, { instructions: text });
        }
        else if (act === "append") {
            const text = await dialog.prompt({ title: `@${name}: add an instruction`, placeholder: "Always answer in French." });
            if (text?.trim())
                updateBot(d.service, name, { instructions: bot.instructions + "\n\n" + text.trim() });
        }
    }
    catch (e) {
        await dialog.alert({ title: "Could not save", message: message(e) });
    }
}
/** A bot's conversations: open one live, or read its recorded history (which outlives opencode's own sessions). Returns true when it navigated away. */
export async function conversationsFlow(d, name) {
    const bot = d.store.require(name);
    const known = d.store.listThreads(name);
    const recorded = listRecorded(d.store, name);
    const options = known.map((t) => ({
        title: t.key === "auto" ? "Automation conversation" : t.key === "main" ? "Main conversation (no caller)" : `Used from session ${t.key.slice(0, 18)}…`,
        value: t.sessionID,
        description: `last used ${ago(t.lastAt)} · ${recorded.find((r) => r.sessionID === t.sessionID)?.count ?? 0} recorded message(s)`,
        footer: t.sessionID,
    }));
    for (const r of recorded)
        if (!known.some((k) => k.sessionID === r.sessionID))
            options.push({ title: `Recorded: ${r.thread ?? r.sessionID.slice(0, 18)}`, value: r.sessionID, description: `${r.count} message(s), last ${ago(r.lastAt)}`, footer: r.sessionID });
    try {
        for (const s of unwrap(await d.ctx.client.session.list({ directory: bot.workdir }))) {
            if (s.agent === name && !options.some((o) => o.value === s.id))
                options.push({ title: s.title ?? s.id, value: s.id, description: "other session using this bot", footer: s.id });
        }
    }
    catch {
        /* listing is best effort */
    }
    if (!options.length)
        return void (await d.ctx.ui.dialog.alert({ title: `@${name}: conversations`, message: "No conversation yet. Mention the bot in a prompt (@" + name + " ...) to start one." })), false;
    const id = await d.ctx.ui.dialog.select({ title: `@${name}: conversations`, placeholder: "Pick one", options });
    if (!id)
        return false;
    const act = await d.ctx.ui.dialog.select({
        title: `@${name}: ${id.slice(0, 20)}…`,
        options: [
            { title: "Read the recorded history", value: "read", description: "everything said, saved in the bot's folder (survives deleted sessions)" },
            { title: "Open the session", value: "open", description: "go to it in the terminal UI (needs the session to still exist)" },
        ],
    });
    if (act === "read") {
        const msgs = readRecorded(d.store, name, id);
        await view(d, `@${name}: ${id}`, msgs.length ? renderTranscript(msgs) : "Nothing recorded for this conversation yet (it is saved when the bot's run ends).");
        return false;
    }
    if (act === "open")
        return openSession(d, id);
    return false;
}
/** Debug: diagnose one bot (or everything) from the TUI, optionally writing a report. */
export async function diagnoseFlow(d, name, report) {
    if (!d.debug)
        return;
    const { dialog, toast } = d.ctx.ui;
    try {
        const [{ diagnose, renderChecks }, { clientDiagEnv }, { buildReport, writeReport }] = await Promise.all([import("./debug/diagnose.js"), import("./debug/client-env.js"), import("./debug/report.js")]);
        const env = clientDiagEnv(d.ctx.client, {
            store: d.store,
            pluginVersion: VERSION,
            appVersion: d.ctx.app?.version,
            location: d.ctx.location?.directory,
            options: d.options,
            materializeEnabled: d.service.materialize,
        });
        if (report) {
            const { markdown, result } = await buildReport(env, { bot: name });
            const file = writeReport(d.store.root, markdown);
            toast.show({ title: "Report written", message: file, variant: result.ok ? "success" : "warning", duration: 8000 });
            await dialog.alert({ title: result.ok ? "Report written (no errors)" : "Report written (there are errors)", message: `${file}\n\n${clip(renderChecks(result, { onlyProblems: true }), 2000)}` });
        }
        else {
            await dialog.alert({ title: name ? `Diagnose @${name}` : "Diagnose openbot", message: clip(renderChecks(await diagnose(env, name))) });
        }
    }
    catch (e) {
        await dialog.alert({ title: "Diagnose failed", message: message(e) });
    }
}
