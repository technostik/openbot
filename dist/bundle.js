/** Export / import of a bot as one self-contained JSON bundle. */
import fs from "node:fs";
import path from "node:path";
import { BotError } from "./types.js";
export const BUNDLE_FORMAT = "openbot.bundle";
export const BUNDLE_VERSION = 1;
export const REDACTED = "<redacted>";
const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
function redact(mcps) {
    let count = 0;
    const out = {};
    for (const [k, v] of Object.entries(mcps)) {
        const copy = { ...v };
        for (const field of ["environment", "headers"]) {
            if (copy[field]) {
                copy[field] = Object.fromEntries(Object.keys(copy[field]).map((key) => [key, REDACTED]));
                count += Object.keys(copy[field]).length;
            }
        }
        out[k] = copy;
    }
    return { mcps: out, count };
}
function readTextTree(dir, base, out, warnings) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = path.posix.join(base, e.name);
        if (e.isDirectory())
            readTextTree(full, rel, out, warnings);
        else if (e.isFile()) {
            if (Object.keys(out).length >= MAX_FILES) {
                warnings.push(`too many files, skipped ${rel}`);
                continue;
            }
            const buf = fs.readFileSync(full);
            if (buf.length > MAX_FILE_BYTES || buf.includes(0)) {
                warnings.push(`skipped ${rel} (binary or larger than ${MAX_FILE_BYTES / 1024} KB)`);
                continue;
            }
            out[rel] = buf.toString("utf8");
        }
    }
}
export function exportBundle(store, name, opts = {}) {
    const bot = store.require(name);
    const warnings = [];
    const { workdir: _w, createdAt: _c, updatedAt: _u, schema: _s, mcps, ...rest } = bot;
    const bundleBot = { ...rest };
    if (mcps) {
        if (opts.includeSecrets) {
            bundleBot.mcps = mcps;
            warnings.push("includes MCP environment/headers values: do not share this file publicly");
        }
        else {
            const r = redact(mcps);
            bundleBot.mcps = r.mcps;
            if (r.count)
                warnings.push(`${r.count} MCP environment/header value(s) were redacted; fill them in after importing`);
        }
    }
    const files = {};
    readTextTree(store.skillsDir(name), "skills", files, warnings);
    return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), bot: bundleBot, files, warnings };
}
export function exportToFile(store, name, file, opts = {}) {
    const bundle = exportBundle(store, name, opts);
    const target = file ?? path.join(store.root, "exports", `${name}.openbot.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(bundle, null, 2) + "\n", "utf8");
    return { path: target, bundle };
}
function safeRelPath(rel) {
    const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
    if (norm.startsWith("/") || norm.startsWith("..") || norm.includes("/../") || !norm.startsWith("skills/")) {
        throw new BotError(`bundle contains an unsafe or unsupported file path: ${rel}`);
    }
    return norm;
}
export function importBundle(store, raw, opts = {}) {
    const b = raw;
    if (!b || b.format !== BUNDLE_FORMAT)
        throw new BotError(`not an openbot bundle (expected format "${BUNDLE_FORMAT}")`);
    if (typeof b.version !== "number" || b.version > BUNDLE_VERSION) {
        throw new BotError(`bundle version ${String(b.version)} is newer than this openbot supports (${BUNDLE_VERSION})`);
    }
    if (!b.bot || typeof b.bot !== "object")
        throw new BotError("bundle has no bot");
    const warnings = [...(b.warnings ?? []).filter((w) => typeof w === "string")];
    const name = opts.rename ?? b.bot.name;
    const files = b.files && typeof b.files === "object" ? b.files : {};
    const fileList = Object.entries(files);
    if (fileList.length > MAX_FILES)
        throw new BotError(`bundle has more than ${MAX_FILES} files`);
    const safe = fileList.map(([rel, content]) => {
        if (typeof content !== "string")
            throw new BotError(`bundle file ${rel} is not text`);
        return [safeRelPath(rel), content];
    });
    const input = {
        name,
        instructions: b.bot.instructions,
        description: b.bot.description,
        model: b.bot.model,
        workdir: opts.workdir,
        skills: b.bot.skills,
        mcps: b.bot.mcps,
        capabilities: b.bot.capabilities,
    };
    const exists = store.exists(name);
    if (exists && !opts.overwrite)
        throw new BotError(`A bot named "${name}" already exists. Use rename, or overwrite: true to replace it.`);
    let bot;
    if (exists) {
        const patch = {
            instructions: input.instructions,
            description: input.description ?? null,
            model: input.model ?? null,
            skills: input.skills ?? null,
            mcps: input.mcps ?? null,
            capabilities: input.capabilities ?? null,
            ...(input.workdir ? { workdir: input.workdir } : {}),
        };
        fs.rmSync(store.skillsDir(name), { recursive: true, force: true });
        bot = store.update(name, patch);
    }
    else {
        bot = store.create(input);
    }
    for (const [rel, content] of safe) {
        const target = path.join(store.botDir(name), rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf8");
    }
    if (JSON.stringify(bot.mcps ?? {}).includes(REDACTED))
        warnings.push("some MCP values are still <redacted>: edit bot.json or use bot_update to set them");
    return { bot, warnings };
}
export function importFromFile(store, file, opts = {}) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (e) {
        throw new BotError(`cannot read bundle ${file}: ${e.message}`);
    }
    return importBundle(store, raw, opts);
}
