import fs from "node:fs"
import path from "node:path"

export interface TreeEntry {
  path: string
  type: "dir" | "file"
  size?: number
  modified?: string
}

const SKIP = new Set([".git", "node_modules", ".DS_Store"])

/** Breadth-limited directory listing, relative paths, dirs first. */
export function listTree(root: string, opts: { depth?: number; max?: number } = {}): { entries: TreeEntry[]; truncated: boolean; exists: boolean } {
  const depth = opts.depth ?? 3
  const max = opts.max ?? 200
  const entries: TreeEntry[] = []
  let truncated = false
  if (!fs.existsSync(root)) return { entries, truncated, exists: false }
  const walk = (dir: string, level: number) => {
    let items: fs.Dirent[] = []
    try {
      items = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !SKIP.has(e.name))
    } catch {
      return
    }
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of items) {
      if (entries.length >= max) { truncated = true; return }
      const full = path.join(dir, e.name)
      const rel = path.relative(root, full)
      try {
        const st = fs.statSync(full)
        entries.push(e.isDirectory() ? { path: rel, type: "dir", modified: st.mtime.toISOString() } : { path: rel, type: "file", size: st.size, modified: st.mtime.toISOString() })
      } catch {
        continue
      }
      if (e.isDirectory() && level + 1 < depth) walk(full, level + 1)
    }
  }
  walk(root, 0)
  return { entries, truncated, exists: true }
}

/** Compact text rendering of a tree. */
export function renderTree(root: string, opts: { depth?: number; max?: number } = {}): string {
  const { entries, truncated, exists } = listTree(root, opts)
  if (!exists) return `(directory does not exist: ${root})`
  if (!entries.length) return "(empty)"
  const lines = entries.map((e) => `${"  ".repeat(e.path.split(path.sep).length - 1)}${path.basename(e.path)}${e.type === "dir" ? "/" : e.size !== undefined ? `  (${e.size} B)` : ""}`)
  return lines.join("\n") + (truncated ? "\n… (truncated)" : "")
}

/** Reads a text file inside `root` only (no path escapes), clipped to `maxBytes`. */
export function readInside(root: string, rel: string, maxBytes = 20_000): { ok: true; content: string; truncated: boolean } | { ok: false; error: string } {
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(path.resolve(root) + path.sep)) return { ok: false, error: "path escapes the working directory" }
  try {
    const buf = fs.readFileSync(full)
    if (buf.includes(0)) return { ok: false, error: "binary file" }
    return { ok: true, content: buf.subarray(0, maxBytes).toString("utf8"), truncated: buf.length > maxBytes }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
