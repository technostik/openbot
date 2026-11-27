/**
 * The bot's outbox to the user: alerts and notes the bot wants you to see.
 * One small JSON file per bot (inbox.json). Delivery channels (TUI toast and
 * notification now, Telegram later) all read this same file.
 */
import fs from "node:fs";
import path from "node:path";
const MAX_ITEMS = 200;
const file = (store, bot) => path.join(store.botDir(bot), "inbox.json");
export function readInbox(store, bot) {
    try {
        const j = JSON.parse(fs.readFileSync(file(store, bot), "utf8"));
        return Array.isArray(j.items) ? j.items : [];
    }
    catch {
        return [];
    }
}
function write(store, bot, items) {
    const f = file(store, bot);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ items: items.slice(-MAX_ITEMS) }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, f);
}
export function addInboxItem(store, bot, input) {
    store.require(bot);
    const item = {
        id: `ibx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        level: input.level,
        message: input.message.trim(),
        status: "open",
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    };
    write(store, bot, [...readInbox(store, bot), item]);
    return item;
}
export function updateInboxItem(store, bot, id, patch) {
    const items = readInbox(store, bot);
    const i = items.findIndex((x) => x.id === id);
    if (i < 0)
        return undefined;
    items[i] = { ...items[i], ...patch, ...(patch.answer !== undefined ? { answeredAt: new Date().toISOString() } : {}) };
    write(store, bot, items);
    return items[i];
}
export const openItems = (store, bot) => readInbox(store, bot).filter((x) => x.status === "open");
