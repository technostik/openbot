/**
 * Bot operations shared by the server tools and the TUI. Every change goes
 * through here so that the on-disk bot and its materialized agent file never
 * drift apart.
 */
import { dematerialize, materialize } from "./materialize.js";
import { importBundle, importFromFile } from "./bundle.js";
export const makeService = (store, opts = {}) => ({
    store,
    materialize: opts.materialize !== false,
    log: opts.log ?? (() => { }),
});
export const materializeEnv = (store) => ({
    skillsDir: (n) => store.skillsDir(n),
    systemFile: (n) => store.systemPath(n),
});
export function syncAgentFile(svc, bot) {
    if (!svc.materialize)
        return undefined;
    const r = materialize(bot, materializeEnv(svc.store));
    if (r.status !== "unchanged")
        svc.log("materialize", { bot: bot.name, ...r });
    return r;
}
export function createBot(svc, input) {
    const bot = svc.store.create(input);
    syncAgentFile(svc, bot);
    return bot;
}
export function updateBot(svc, name, patch) {
    const before = svc.store.require(name);
    const bot = svc.store.update(name, patch);
    if (svc.materialize && bot.workdir !== before.workdir)
        dematerialize(before);
    syncAgentFile(svc, bot);
    return { bot, before };
}
export function deleteBot(svc, name) {
    const bot = svc.store.delete(name);
    if (svc.materialize)
        dematerialize(bot);
    return bot;
}
export function importBot(svc, source, opts = {}) {
    const r = "file" in source ? importFromFile(svc.store, source.file, opts) : importBundle(svc.store, source.bundle, opts);
    syncAgentFile(svc, r.bot);
    return r;
}
/** At startup / after an external change: migrate legacy bots and refresh every agent file. */
export function syncAll(svc) {
    const migrated = svc.store.migrate();
    const results = svc.materialize ? svc.store.list().map((b) => syncAgentFile(svc, b)).filter(Boolean) : [];
    return { migrated, results };
}
