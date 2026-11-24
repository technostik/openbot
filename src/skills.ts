import fs from "node:fs"
import path from "node:path"

export interface LocalSkill {
  /** Skill name as the model invokes it. */
  name: string
  description?: string
  /** Absolute path of the SKILL.md file. */
  path: string
  content: string
}

/** Minimal frontmatter reader: only `name:` and `description:` are needed. */
export function parseSkillFile(file: string, raw: string): LocalSkill | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  const fm: Record<string, string> = {}
  if (m) {
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line)
      if (kv) fm[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "")
    }
  }
  const name = fm.name || path.basename(path.dirname(file))
  if (!name) return undefined
  return { name, description: fm.description || undefined, path: file, content: raw }
}

/** Skills that ship inside a bot: `<botdir>/skills/<id>/SKILL.md`. */
export function loadLocalSkills(skillsDir: string): LocalSkill[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: LocalSkill[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const file = path.join(skillsDir, e.name, "SKILL.md")
    try {
      const s = parseSkillFile(file, fs.readFileSync(file, "utf8"))
      if (s) out.push(s)
    } catch {
      /* no SKILL.md in this folder */
    }
  }
  return out
}
