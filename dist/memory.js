const MAX_CHARS = 6000;
export function buildStateContext(store, name) {
    const bot = store.get(name);
    if (!bot)
        return undefined;
    const state = store.readStateFile(name).trim();
    const status = bot.status ?? "active";
    const lines = [`## Your current state (${store.stateFile(name)})`, `Lifecycle status: ${status}${bot.statusNote ? ` (${bot.statusNote})` : ""}.`, ""];
    if (!state)
        lines.push("(state.md is empty: write your goal and todo with bot_state)");
    else if (state.length > MAX_CHARS)
        lines.push(state.slice(0, MAX_CHARS), "", `… state.md is ${state.length} characters; the rest is clipped here. Read it with bot_state read, and condense it.`);
    else
        lines.push(state);
    return lines.join("\n");
}
/** Adds `line` at the end of the `## <heading>` section of a markdown state file (creating the section if needed). */
export function addToSection(md, heading, line) {
    const lines = md.replace(/\s+$/, "").split("\n");
    const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(l));
    if (start < 0)
        return [...lines, "", `## ${heading}`, line, ""].join("\n");
    let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    if (end < 0)
        end = lines.length;
    // drop empty placeholder items ("- ", "- [ ] ", "- (nothing)") from the section
    const body = lines.slice(start + 1, end).filter((l) => !/^-\s*(\[\s\]\s*)?$/.test(l.trim()) && !/^-\s*\(nothing\)\s*$/i.test(l.trim()));
    while (body.length && body[body.length - 1] === "")
        body.pop();
    return [...lines.slice(0, start + 1), ...body, line, ...(end < lines.length ? ["", ...lines.slice(end)] : []), ""].join("\n");
}
