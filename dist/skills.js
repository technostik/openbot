import fs from "node:fs";
import path from "node:path";
/** Minimal frontmatter reader: only `name:` and `description:` are needed. */
export function parseSkillFile(file, raw) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    const fm = {};
    if (m) {
        for (const line of m[1].split(/\r?\n/)) {
            const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
            if (kv)
                fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
        }
    }
    const name = fm.name || path.basename(path.dirname(file));
    if (!name)
        return undefined;
    return { name, description: fm.description || undefined, path: file, content: raw };
}
/** Skills that ship inside a bot: `<botdir>/skills/<id>/SKILL.md`. */
export function loadLocalSkills(skillsDir) {
    let entries = [];
    try {
        entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const e of entries) {
        if (!e.isDirectory())
            continue;
        const file = path.join(skillsDir, e.name, "SKILL.md");
        try {
            const s = parseSkillFile(file, fs.readFileSync(file, "utf8"));
            if (s)
                out.push(s);
        }
        catch {
            /* no SKILL.md in this folder */
        }
    }
    return out;
}
