import fs from "node:fs";
import path from "node:path";
import { assertName, nameProblem } from "./names.js";
import { expandPath } from "./paths.js";
import { BotError, BOT_STATUSES, CAPABILITY_PRESETS, SCHEMA_VERSION, } from "./types.js";
const MODEL_RE = /^[^/\s#]+\/[^\s#]+(#[^\s#]+)?$/;
const MCP_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/* ------------------------------------------------------------------ */
/* Validation (pure, no I/O) — exported for tests and for import.      */
/* ------------------------------------------------------------------ */
export function validateModel(model) {
    if (typeof model !== "string" || !MODEL_RE.test(model.trim())) {
        throw new BotError('model must look like "provider/model" (optionally "provider/model#variant")');
    }
    return model.trim();
}
export function validateSkills(skills) {
    if (!Array.isArray(skills) || skills.some((s) => typeof s !== "string" || !s.trim())) {
        throw new BotError("skills must be an array of skill names");
    }
    return [...new Set(skills.map((s) => s.trim()))];
}
function stringRecord(v, label) {
    if (v === undefined)
        return undefined;
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.values(v).some((x) => typeof x !== "string")) {
        throw new BotError(`${label} must be an object of strings`);
    }
    return { ...v };
}
export function validateMcps(mcps) {
    if (!mcps || typeof mcps !== "object" || Array.isArray(mcps)) {
        throw new BotError("mcps must be an object: { serverName: { type, ... } }");
    }
    const out = {};
    for (const [key, raw] of Object.entries(mcps)) {
        if (!MCP_KEY_RE.test(key)) {
            throw new BotError(`mcp server name "${key}" must be lowercase letters, digits, "-" or "_" (max 32)`);
        }
        const v = raw;
        if (!v || typeof v !== "object")
            throw new BotError(`mcp "${key}" must be an object`);
        if (v.type === "local") {
            if (!Array.isArray(v.command) || !v.command.length || v.command.some((c) => typeof c !== "string")) {
                throw new BotError(`mcp "${key}": local servers need "command": ["cmd", "arg", ...]`);
            }
            const environment = stringRecord(v.environment, `mcp "${key}" environment`);
            out[key] = { ...v, type: "local", command: [...v.command], ...(environment ? { environment } : {}) };
        }
        else if (v.type === "remote") {
            if (typeof v.url !== "string" || !/^https?:\/\//.test(v.url)) {
                throw new BotError(`mcp "${key}": remote servers need an http(s) "url"`);
            }
            const headers = stringRecord(v.headers, `mcp "${key}" headers`);
            out[key] = { ...v, type: "remote", url: v.url, ...(headers ? { headers } : {}) };
        }
        else {
            throw new BotError(`mcp "${key}": "type" must be "local" or "remote"`);
        }
    }
    return out;
}
const AUTO_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const EVERY_RE = /^(\d+)\s+(minute|minutes|hour|hours|day|days)$/;
const MAX_AUTOMATIONS = 10;
/** Validates scheduled runs. The host needs prompt automations to be at least one minute apart. */
const REL_AT_RE = /^in\s+(\d+)\s+(second|minute|hour|day|week)s?$/i;
const REL_AT_UNIT_MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
/**
 * Resolve a relative `at` ("in 10 minutes") once, when the spec is written.
 * The native host stores the absolute date it resolved to, so keeping the
 * relative string would make sameAutomation() see a difference on every
 * reconcile and re-arm the schedule (a one-shot `at` would fire again and again).
 */
export function resolveAt(at, now = Date.now()) {
    const value = at.trim();
    const m = REL_AT_RE.exec(value);
    if (!m)
        return value;
    return new Date(now + Number(m[1]) * REL_AT_UNIT_MS[m[2].toLowerCase()]).toISOString();
}
export function validateAutomations(list) {
    if (!Array.isArray(list))
        throw new BotError("automations must be an array");
    if (list.length > MAX_AUTOMATIONS)
        throw new BotError(`at most ${MAX_AUTOMATIONS} automations per bot`);
    const seen = new Set();
    return list.map((raw) => {
        if (!raw || typeof raw !== "object")
            throw new BotError("each automation must be an object");
        const id = raw.id;
        if (typeof id !== "string" || !AUTO_ID_RE.test(id))
            throw new BotError('automation "id" must be lowercase letters, digits and dashes (e.g. "daily-scan")');
        if (seen.has(id))
            throw new BotError(`duplicate automation id "${id}"`);
        seen.add(id);
        const triggers = ["every", "cron", "at"].filter((k) => raw[k] !== undefined);
        if (triggers.length !== 1)
            throw new BotError(`automation "${id}": give exactly one of every / cron / at`);
        const out = { id };
        if (raw.every !== undefined) {
            const m = typeof raw.every === "string" ? EVERY_RE.exec(raw.every.trim()) : null;
            if (!m || Number(m[1]) < 1)
                throw new BotError(`automation "${id}": every must look like "30 minutes", "6 hours" or "1 day"`);
            out.every = raw.every.trim();
        }
        if (raw.cron !== undefined) {
            if (typeof raw.cron !== "string" || raw.cron.trim().split(/\s+/).length < 5)
                throw new BotError(`automation "${id}": cron needs 5 fields, e.g. "0 9 * * 1-5"`);
            out.cron = raw.cron.trim();
        }
        if (raw.at !== undefined) {
            if (typeof raw.at !== "string" || !raw.at.trim())
                throw new BotError(`automation "${id}": at must be a time such as "in 10 minutes" or "2026-12-01T09:00"`);
            out.at = resolveAt(raw.at);
        }
        if (raw.tz !== undefined)
            out.tz = String(raw.tz);
        if (raw.prompt !== undefined) {
            if (typeof raw.prompt !== "string")
                throw new BotError(`automation "${id}": prompt must be text`);
            if (raw.prompt.trim())
                out.prompt = raw.prompt.trim();
        }
        if (raw.enabled !== undefined)
            out.enabled = raw.enabled !== false;
        if (raw.expires !== undefined)
            out.expires = String(raw.expires);
        return out;
    });
}
function validateStringList(v, label) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
        throw new BotError(`${label} must be an array of non-empty strings`);
    }
    return [...new Set(v.map((x) => x.trim()))];
}
/**
 * Validates the reserved `capabilities` field. Unknown keys are kept: bots
 * created before v4 may have a free-form object there, and dropping it would
 * silently rewrite their bot.json.
 */
export function validateCapabilities(c) {
    if (!c || typeof c !== "object" || Array.isArray(c))
        throw new BotError("capabilities must be an object");
    const raw = c;
    const out = { ...raw };
    if (raw.preset !== undefined) {
        if (typeof raw.preset !== "string" || !CAPABILITY_PRESETS.includes(raw.preset)) {
            throw new BotError(`capabilities.preset must be one of ${CAPABILITY_PRESETS.join(", ")}`);
        }
        out.preset = raw.preset;
    }
    for (const key of ["tools", "denyTools", "mcps"]) {
        if (raw[key] !== undefined)
            out[key] = validateStringList(raw[key], `capabilities.${key}`);
    }
    return out;
}
function validateInstructions(v) {
    if (typeof v !== "string" || !v.trim())
        throw new BotError("instructions (the bot's role and goal) must be a non-empty string");
    return v.trim();
}
function validateWorkdir(v, base) {
    if (typeof v !== "string" || !v.trim())
        throw new BotError("workdir must be a path");
    const p = expandPath(v, base);
    if (p === path.parse(p).root)
        throw new BotError("workdir must not be the filesystem root");
    return p;
}
export class BotStore {
    root;
    constructor(root) {
        this.root = root;
    }
    get botsDir() {
        return path.join(this.root, "bots");
    }
    botDir(name) {
        assertName(name);
        return path.join(this.botsDir, name);
    }
    configPath(name) {
        return path.join(this.botDir(name), "bot.json");
    }
    statePath(name) {
        return path.join(this.botDir(name), "state", "session.json");
    }
    threadsPath(name) {
        return path.join(this.botDir(name), "state", "threads.json");
    }
    /** The master prompt, as a plain markdown file anyone (user or bot) can edit. */
    systemPath(name) {
        return path.join(this.botDir(name), "system.md");
    }
    skillsDir(name) {
        return path.join(this.botDir(name), "skills");
    }
    defaultWorkdir(name) {
        return path.join(this.botDir(name), "workspace");
    }
    exists(name) {
        if (nameProblem(name))
            return false;
        return fs.existsSync(this.configPath(name));
    }
    get(name) {
        if (nameProblem(name))
            return undefined;
        try {
            return this.parse(fs.readFileSync(this.configPath(name), "utf8"), name);
        }
        catch (e) {
            if (e.code === "ENOENT")
                return undefined;
            throw e;
        }
    }
    require(name) {
        const bot = this.get(name);
        if (!bot)
            throw new BotError(`No bot named "${name}". Use bot_list to see existing bots.`);
        return bot;
    }
    list() {
        return this.listWithProblems().bots;
    }
    listWithProblems() {
        const result = { bots: [], problems: [] };
        let entries = [];
        try {
            entries = fs.readdirSync(this.botsDir);
        }
        catch {
            return result;
        }
        for (const name of entries.sort()) {
            if (nameProblem(name))
                continue;
            try {
                const raw = fs.readFileSync(this.configPath(name), "utf8");
                result.bots.push(this.parse(raw, name));
            }
            catch (e) {
                if (e.code === "ENOENT")
                    continue;
                result.problems.push({ name, error: e.message });
            }
        }
        return result;
    }
    /** Cheap change detector (names + mtimes + sizes of every bot.json). */
    signature() {
        let entries = [];
        try {
            entries = fs.readdirSync(this.botsDir);
        }
        catch {
            return "";
        }
        const parts = [];
        for (const name of entries.sort()) {
            try {
                const st = fs.statSync(path.join(this.botsDir, name, "bot.json"));
                let sys = "";
                try {
                    const ss = fs.statSync(path.join(this.botsDir, name, "system.md"));
                    sys = `:${ss.mtimeMs}:${ss.size}`;
                }
                catch {
                    /* legacy bot without system.md */
                }
                parts.push(`${name}:${st.mtimeMs}:${st.size}${sys}`);
            }
            catch {
                /* not a bot directory */
            }
        }
        return parts.join("|");
    }
    create(input) {
        assertName(input.name);
        if (this.exists(input.name))
            throw new BotError(`A bot named "${input.name}" already exists.`);
        const now = new Date().toISOString();
        const bot = {
            schema: SCHEMA_VERSION,
            name: input.name,
            instructions: validateInstructions(input.instructions),
            workdir: input.workdir ? validateWorkdir(input.workdir) : this.defaultWorkdir(input.name),
            createdAt: now,
            updatedAt: now,
        };
        if (input.description?.trim())
            bot.description = input.description.trim();
        if (input.model !== undefined)
            bot.model = validateModel(input.model);
        if (input.skills !== undefined)
            bot.skills = validateSkills(input.skills);
        if (input.mcps !== undefined)
            bot.mcps = validateMcps(input.mcps);
        if (input.capabilities !== undefined)
            bot.capabilities = validateCapabilities(input.capabilities);
        if (input.automations !== undefined)
            bot.automations = validateAutomations(input.automations);
        fs.mkdirSync(path.join(this.botDir(bot.name), "state"), { recursive: true });
        fs.mkdirSync(this.skillsDir(bot.name), { recursive: true });
        fs.mkdirSync(bot.workdir, { recursive: true });
        this.write(bot);
        this.ensureStateFile(bot);
        return bot;
    }
    update(name, patch) {
        const bot = this.require(name);
        const next = { ...bot };
        if (patch.instructions !== undefined)
            next.instructions = validateInstructions(patch.instructions);
        if (patch.workdir !== undefined)
            next.workdir = validateWorkdir(patch.workdir);
        if (patch.description !== undefined) {
            if (patch.description === null || !patch.description.trim())
                delete next.description;
            else
                next.description = patch.description.trim();
        }
        if (patch.model !== undefined) {
            if (patch.model === null)
                delete next.model;
            else
                next.model = validateModel(patch.model);
        }
        if (patch.skills !== undefined) {
            if (patch.skills === null)
                delete next.skills;
            else
                next.skills = validateSkills(patch.skills);
        }
        if (patch.mcps !== undefined) {
            if (patch.mcps === null)
                delete next.mcps;
            else
                next.mcps = validateMcps(patch.mcps);
        }
        if (patch.capabilities !== undefined) {
            if (patch.capabilities === null)
                delete next.capabilities;
            else
                next.capabilities = validateCapabilities(patch.capabilities);
        }
        if (patch.automations !== undefined) {
            if (patch.automations === null)
                delete next.automations;
            else
                next.automations = validateAutomations(patch.automations);
        }
        next.updatedAt = new Date().toISOString();
        fs.mkdirSync(next.workdir, { recursive: true });
        this.write(next);
        return next;
    }
    /** Removes the bot's directory (config, state, local skills, default workspace). A custom workdir is never touched. */
    delete(name) {
        const bot = this.require(name);
        fs.rmSync(this.botDir(name), { recursive: true, force: true });
        return bot;
    }
    /**
     * Writes a fully-formed bot: the master prompt goes to system.md, everything
     * else to bot.json (so each file is pleasant to edit by hand).
     */
    write(bot) {
        const dir = this.botDir(bot.name);
        fs.mkdirSync(dir, { recursive: true });
        const { instructions, ...config } = bot;
        this.atomicWrite(this.systemPath(bot.name), instructions.trimEnd() + "\n");
        this.atomicWrite(this.configPath(bot.name), JSON.stringify(config, null, 2) + "\n");
    }
    atomicWrite(file, content) {
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, content, "utf8");
        fs.renameSync(tmp, file);
    }
    /** Moves v0.1 bots (instructions inside bot.json) to the system.md layout. */
    migrate() {
        const migrated = [];
        for (const bot of this.list()) {
            if (!fs.existsSync(this.systemPath(bot.name))) {
                this.write(bot);
                migrated.push(bot.name);
            }
            if (this.ensureStateFile(bot) && !migrated.includes(bot.name))
                migrated.push(bot.name);
        }
        return migrated;
    }
    /* ---- conversations (threads) ---- */
    readThreads(name) {
        let threads = {};
        try {
            threads = JSON.parse(fs.readFileSync(this.threadsPath(name), "utf8")).threads ?? {};
        }
        catch {
            /* none yet */
        }
        const legacy = this.readState(name);
        if (legacy.sessionID && !threads.main) {
            const at = legacy.sessionCreatedAt ?? new Date(0).toISOString();
            threads = { ...threads, main: { sessionID: legacy.sessionID, createdAt: at, lastAt: at } };
        }
        return threads;
    }
    setThread(name, key, info) {
        const threads = { ...this.readThreads(name), [key]: info };
        const file = this.threadsPath(name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.atomicWrite(file, JSON.stringify({ threads }, null, 2) + "\n");
    }
    touchThread(name, key) {
        const t = this.readThreads(name)[key];
        if (t)
            this.setThread(name, key, { ...t, lastAt: new Date().toISOString() });
    }
    /** Is this session one of the bot's own conversations? */
    isBotSession(name, sessionID) {
        return Object.values(this.readThreads(name)).some((t) => t.sessionID === sessionID);
    }
    /** Threads, most recently used first. */
    listThreads(name) {
        return Object.entries(this.readThreads(name))
            .map(([key, t]) => ({ key, ...t }))
            .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    }
    /* ---- legacy runtime state ---- */
    readState(name) {
        try {
            return JSON.parse(fs.readFileSync(this.statePath(name), "utf8"));
        }
        catch {
            return {};
        }
    }
    writeState(name, patch) {
        const next = patch === null ? {} : { ...this.readState(name), ...patch };
        const file = this.statePath(name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf8");
        return next;
    }
    /* ---- parsing a hand-edited bot.json ---- */
    parse(raw, expectedName) {
        let j;
        try {
            j = JSON.parse(raw);
        }
        catch (e) {
            throw new BotError(`bot.json is not valid JSON: ${e.message}`);
        }
        if (!j || typeof j !== "object")
            throw new BotError("bot.json must be an object");
        if (j.name !== expectedName)
            throw new BotError(`bot.json "name" ("${String(j.name)}") must match its folder ("${expectedName}")`);
        if (typeof j.schema === "number" && j.schema > SCHEMA_VERSION) {
            throw new BotError(`bot.json uses schema ${j.schema}, newer than this openbot (${SCHEMA_VERSION}). Update openbot.`);
        }
        const now = new Date().toISOString();
        let fromFile;
        try {
            fromFile = fs.readFileSync(this.systemPath(expectedName), "utf8").trim() || undefined;
        }
        catch {
            /* legacy bot: instructions live in bot.json */
        }
        const bot = {
            schema: SCHEMA_VERSION,
            name: expectedName,
            instructions: validateInstructions(fromFile ?? j.instructions),
            workdir: j.workdir !== undefined ? validateWorkdir(j.workdir) : this.defaultWorkdir(expectedName),
            createdAt: typeof j.createdAt === "string" ? j.createdAt : now,
            updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : now,
        };
        if (typeof j.description === "string" && j.description.trim())
            bot.description = j.description.trim();
        if (j.model !== undefined)
            bot.model = validateModel(j.model);
        if (j.skills !== undefined)
            bot.skills = validateSkills(j.skills);
        if (j.mcps !== undefined)
            bot.mcps = validateMcps(j.mcps);
        if (j.capabilities !== undefined)
            bot.capabilities = validateCapabilities(j.capabilities);
        if (j.automations !== undefined)
            bot.automations = validateAutomations(j.automations);
        if (j.status !== undefined) {
            if (!BOT_STATUSES.includes(j.status))
                throw new BotError(`status must be one of ${BOT_STATUSES.join(", ")}`);
            bot.status = j.status;
        }
        if (typeof j.statusNote === "string")
            bot.statusNote = j.statusNote;
        if (typeof j.statusAt === "string")
            bot.statusAt = j.statusAt;
        return bot;
    }
    /* ---- lifecycle ---- */
    /** Changes the bot's lifecycle status (the only writer of status). */
    setStatus(name, status, note) {
        if (!BOT_STATUSES.includes(status))
            throw new BotError(`status must be one of ${BOT_STATUSES.join(", ")}`);
        const bot = this.require(name);
        const next = { ...bot, status, statusAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        if (note?.trim())
            next.statusNote = note.trim();
        else
            delete next.statusNote;
        this.write(next);
        return next;
    }
    /* ---- state.md: the bot's working memory ---- */
    stateFile(name) {
        return path.join(this.botDir(name), "state.md");
    }
    /** Creates state.md from the template when missing. */
    ensureStateFile(bot) {
        const file = this.stateFile(bot.name);
        if (fs.existsSync(file))
            return false;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.atomicWrite(file, stateTemplate(bot));
        return true;
    }
    readStateFile(name) {
        try {
            return fs.readFileSync(this.stateFile(name), "utf8");
        }
        catch {
            return "";
        }
    }
    writeStateFile(name, content) {
        this.require(name);
        if (Buffer.byteLength(content) > MAX_STATE_BYTES)
            throw new BotError(`state.md would exceed ${MAX_STATE_BYTES / 1024} KB: condense it (keep only what matters now)`);
        this.atomicWrite(this.stateFile(name), content.endsWith("\n") ? content : content + "\n");
    }
}
export const MAX_STATE_BYTES = 64 * 1024;
export function stateTemplate(bot) {
    return [
        `# State of ${bot.name}`,
        "",
        "_Working memory. It is shown to the bot on every turn; the bot and you may edit it. Keep it short and current._",
        "",
        "## Goal",
        bot.description ? bot.description : "(what this bot is for, and what \"finished\" would mean, if it ever ends)",
        "",
        "## Important",
        "- ",
        "",
        "## Todo",
        "- [ ] ",
        "",
        "## Waiting for the user",
        "- (nothing)",
        "",
        "## Notes",
        "",
    ].join("\n");
}
