import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { BotStore, validateAutomations } from "../dist/store.js"
import { makeService, createBot } from "../dist/service.js"
import { buildTools } from "../dist/tools.js"
import { addInboxItem, readInbox, updateInboxItem, openItems } from "../dist/inbox.js"
import { syncHistory, readRecorded, listRecorded, renderTranscript, historyFile } from "../dist/history.js"
import { AUTO_PREFIX, nativeName, standardPrompt, toNativeInput, sameAutomation, reconcile, describeAutomations, isScheduled } from "../dist/automation.js"
import { buildStateContext, addToSection } from "../dist/memory.js"
import { fieldText } from "../dist/flows.js"
import { composeSystem } from "../dist/host.js"
import { say } from "../dist/session-io.js"
import { diagnose } from "../dist/debug/diagnose.js"
import { tmpdir } from "./helpers/tmp.mjs"

const mk = () => new BotStore(tmpdir())
const human = { agent: "build", sessionID: "ses_human" }

/* ---- fakes ---- */
function port() {
  const sessions = new Map(); const log = []; let n = 0
  const p = { log, sessions }
  Object.assign(p, {
    async create(i) { const s = { id: `ses_${++n}`, ...i }; sessions.set(s.id, s); return s },
    async get({ sessionID }) { const s = sessions.get(sessionID); if (!s) throw new Error("gone"); return s },
    async prompt(i) { const id = `m_${++n}`; const s = sessions.get(i.sessionID); s.msgs = [...(s.msgs ?? []), { id, type: "user", text: i.text, time: { created: 1_700_000_000_000 } }, { id: `m_${++n}`, type: "assistant", content: [{ type: "text", text: "echo:" + i.text }] }, { id: `m_${++n}`, type: "idle", outcome: "succeeded" }]; return { id } },
    async wait() {}, async context({ sessionID }) { return sessions.get(sessionID)?.msgs ?? [] }, async interrupt(i) { log.push(["interrupt", i.sessionID]) },
    async list() { return [...sessions.values()] },
  })
  return p
}
function nativeFake() {
  const items = []; let n = 0; const f = { items, created: [], removed: [], failCreate: null }
  f.list = async () => items.map((x) => ({ ...x }))
  f.create = async (input) => { if (f.failCreate) throw new Error(f.failCreate); const info = { id: `aut_${++n}`, name: input.name, status: "active", trigger: input.trigger, action: { ...input.action, to: { session: input.sessionID } }, runCount: 0 }; items.push(info); f.created.push(input.name); return info }
  f.remove = async (id) => { const i = items.findIndex((x) => x.id === id); if (i >= 0) items.splice(i, 1); f.removed.push(id) }
  return f
}
const deps = (s, native, p) => ({ store: s, native, ensureAutoSession: async (bot) => { const r = await (await import("../dist/session-io.js")).ensureSession(p, s, bot, { key: "auto" }); return r.sessionID } })
const tools = (s, p, native, reconcileHook) => Object.fromEntries(buildTools({ store: s, service: makeService(s), session: p, reload: async () => {}, automation: native ? { native, reconcile: reconcileHook ?? (() => reconcile(deps(s, native, p))) } : undefined }).map((t) => [t.name, t]))

/* ---- validation + store ---- */
test("automations: valid schedules and clear errors", () => {
  const ok = validateAutomations([{ id: "scan", every: "6 hours", prompt: " look " }, { id: "morning", cron: "0 9 * * 1-5", tz: "Europe/Paris" }, { id: "once", at: "in 10 minutes", enabled: false }])
  assert.equal(ok[0].prompt, "look"); assert.equal(ok[1].tz, "Europe/Paris"); assert.equal(ok[2].enabled, false)
  for (const [bad, re] of [[[{ id: "Bad", every: "1 hour" }], /id/], [[{ id: "x" }], /exactly one/], [[{ id: "x", every: "1 hour", cron: "* * * * *" }], /exactly one/], [[{ id: "x", every: "30 seconds" }], /every must look/], [[{ id: "x", every: "0 minutes" }], /every must look/], [[{ id: "x", cron: "* *" }], /cron needs/], [[{ id: "a", every: "1 day" }, { id: "a", every: "1 day" }], /duplicate/], ["nope", /array/], [Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, every: "1 day" })), /at most/]]) assert.throws(() => validateAutomations(bad), re)
})

test("automations: a relative at is resolved once to an absolute date", () => {
  const [once] = validateAutomations([{ id: "once", at: "in 10 minutes" }])
  assert.match(once.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  const [fixed] = validateAutomations([{ id: "fixed", at: "2026-12-01T09:00" }])
  assert.equal(fixed.at, "2026-12-01T09:00")
})

test("store: status defaults to active, round-trips, is validated; automations persist in bot.json", () => {
  const s = mk(); const b = s.create({ name: "lc", instructions: "x", automations: [{ id: "scan", every: "1 hour" }] })
  assert.equal(b.status, undefined); assert.equal(s.get("lc").automations[0].id, "scan")
  const st = s.setStatus("lc", "stopped", "vacation"); assert.deepEqual([st.status, st.statusNote], ["stopped", "vacation"]); assert.ok(st.statusAt)
  assert.equal(s.get("lc").status, "stopped"); assert.equal(s.setStatus("lc", "active").statusNote, undefined)
  assert.throws(() => s.setStatus("lc", "paused"), /status must be/)
  fs.writeFileSync(path.join(s.botDir("lc"), "bot.json"), JSON.stringify({ name: "lc", status: "nonsense" })); assert.throws(() => s.get("lc"), /status must be/)
})

test("state.md: template on create, migration for old bots, size cap, read/write", () => {
  const s = mk(); s.create({ name: "st", instructions: "x", description: "find partners" })
  const t = s.readStateFile("st"); assert.match(t, /## Goal\nfind partners/); assert.match(t, /## Todo/); assert.match(t, /## Waiting for the user/)
  s.writeStateFile("st", "custom"); assert.equal(s.readStateFile("st"), "custom\n"); s.create({ name: "old", instructions: "y" }); fs.rmSync(s.stateFile("old"))
  assert.ok(s.migrate().includes("old")); assert.ok(fs.existsSync(s.stateFile("old"))); assert.deepEqual(s.migrate(), [])
  assert.throws(() => s.writeStateFile("st", "x".repeat(70 * 1024)), /exceed/)
})

test("memory: the bot sees status and state; a long state is clipped with a pointer", () => {
  const s = mk(); s.create({ name: "mm", instructions: "x" }); s.writeStateFile("mm", "## Todo\n- [ ] call Ada")
  assert.match(buildStateContext(s, "mm"), /Lifecycle status: active[\s\S]*call Ada/)
  s.setStatus("mm", "finished", "done!"); assert.match(buildStateContext(s, "mm"), /finished \(done!\)/)
  s.writeStateFile("mm", "y".repeat(9000)); assert.match(buildStateContext(s, "mm"), /clipped here/); assert.equal(buildStateContext(s, "ghost"), undefined)
  assert.match(composeSystem({ name: "n", instructions: "I", workdir: "/w" }), /bot_state[\s\S]*bot_notify[\s\S]*question tool[\s\S]*bot_status[\s\S]*bot_automation/)
})

/* ---- inbox ---- */
test("inbox: add, update, open count, cap", () => {
  const s = mk(); s.create({ name: "ib", instructions: "x" })
  const a = addInboxItem(s, "ib", { level: "attention", message: " Need your OK ", title: "Budget", sessionID: "ses_9" }); addInboxItem(s, "ib", { level: "info", message: "fyi" })
  assert.equal(a.message, "Need your OK"); assert.equal(a.status, "open"); assert.equal(openItems(s, "ib").length, 2)
  const u = updateInboxItem(s, "ib", a.id, { status: "answered", answer: "yes" }); assert.equal(u.answer, "yes"); assert.ok(u.answeredAt); assert.equal(openItems(s, "ib").length, 1)
  assert.equal(updateInboxItem(s, "ib", "nope", { status: "read" }), undefined)
  for (let i = 0; i < 210; i++) addInboxItem(s, "ib", { level: "info", message: "m" + i }); assert.equal(readInbox(s, "ib").length, 200)
  assert.throws(() => addInboxItem(s, "ghost", { level: "info", message: "x" }), /No bot/)
})

/* ---- history ---- */
test("history: incremental, append-only, survives the session, clipped, readable", async () => {
  const s = mk(); s.create({ name: "hs", instructions: "x" }); const p = port()
  const ses = await p.create({ agent: "hs" })
  assert.equal(await syncHistory(p, s, "hs", ses.id), 0)
  await p.prompt({ sessionID: ses.id, text: "first question" }); assert.equal(await syncHistory(p, s, "hs", ses.id, { thread: "ses_c", parentID: "ses_c" }), 3)
  assert.equal(await syncHistory(p, s, "hs", ses.id), 0, "nothing new")
  await p.prompt({ sessionID: ses.id, text: "x".repeat(30000) }); assert.equal(await syncHistory(p, s, "hs", ses.id), 3)
  const rec = readRecorded(s, "hs", ses.id); assert.equal(rec.length, 6); assert.match(rec[3].text, /clipped 10000 chars/)
  p.sessions.delete(ses.id)  // opencode loses the session; the record stays
  assert.equal(readRecorded(s, "hs", ses.id).length, 6)
  const l = listRecorded(s, "hs"); assert.deepEqual([l[0].sessionID, l[0].count, l[0].thread, l[0].parentID], [ses.id, 6, "ses_c", "ses_c"])
  const t = renderTranscript(rec); assert.match(t, /you \/ caller\nfirst question/); assert.match(t, /bot\necho:first question/); assert.match(t, /run succeeded/)
  assert.ok(fs.existsSync(historyFile(s, "hs", ses.id)))
  assert.match(renderTranscript([{ type: "assistant", content: [{ type: "tool", name: "read", input: { path: "a" }, output: "ok" }] }, { type: "idle", outcome: "failed", error: { message: "boom" } }]), /\[read\][\s\S]*run failed: boom/)
})

test("history: say() records the exchange; bot_history reads the record even when the session is gone", async () => {
  const s = mk(); const p = port(); const t = tools(s, p); createBot(makeService(s), { name: "hb", instructions: "x" })
  const r = await t.bot_say.execute({ name: "hb", message: "remember me", wait: true }, human)
  assert.equal(listRecorded(s, "hb").length, 1); p.sessions.delete(r.metadata.sessionID)
  const h = JSON.parse((await t.bot_history.execute({ name: "hb", thread: r.metadata.sessionID }, human)).content); assert.equal(h.recordedMessages, 3)
  assert.match((await t.bot_history.execute({ name: "hb", thread: "last", transcript: true }, human)).content, /remember me/)
  assert.match((await t.bot_get.execute({ name: "hb" }, human)).content, /"recordedHistory"[\s\S]*"messages": 3/)
  assert.match((await t.bot_conversations.execute({ name: "hb" }, human)).content, /"recordedMessages": 3/)
})

/* ---- automations ---- */
test("automation: prompt, native input mapping, equality", () => {
  const bot = { name: "au", status: "active" }; const spec = { id: "scan", every: "6 hours", prompt: "focus on podcasts" }
  const p = standardPrompt(bot, spec); assert.match(p, /automation "scan"/); assert.match(p, /bot_state/); assert.match(p, /bot_notify[\s\S]*question tool/); assert.match(p, /finished/); assert.ok(p.endsWith("focus on podcasts"))
  const input = toNativeInput(bot, spec, "ses_1"); assert.deepEqual([input.name, input.sessionID, input.trigger, input.action.type], ["openbot:au:scan", "ses_1", { type: "every", every: "6 hours" }, "prompt"])
  assert.deepEqual(toNativeInput(bot, { id: "m", cron: "0 9 * * *", tz: "Europe/Paris" }, "s").trigger, { type: "cron", cron: "0 9 * * *", tz: "Europe/Paris" })
  assert.deepEqual(toNativeInput(bot, { id: "o", at: "in 5 minutes", expires: "1 day" }, "s").expires, "1 day")
  const info = { trigger: input.trigger, action: { type: "prompt", prompt: input.action.prompt, to: { session: "ses_1" } } }
  assert.equal(sameAutomation(info, input), true); assert.equal(sameAutomation({ ...info, trigger: { type: "every", every: "1 hour" } }, input), false); assert.equal(sameAutomation({ ...info, action: { ...info.action, to: { session: "ses_2" } } }, input), false)
  assert.equal(isScheduled({ status: "stopped" }, { enabled: true }), false); assert.equal(isScheduled({}, { enabled: false }), false); assert.equal(isScheduled({}, {}), true)
})

test("automation reconcile: creates for active bots only; status gates them; changes are re-synced; orphans and duplicates removed", async () => {
  const s = mk(); const p = port(); const n = nativeFake(); const svc = makeService(s)
  createBot(svc, { name: "a1", instructions: "x", automations: [{ id: "scan", every: "6 hours" }, { id: "off", every: "1 day", enabled: false }] })
  createBot(svc, { name: "a2", instructions: "x", automations: [{ id: "scan", every: "1 hour" }] }); s.setStatus("a2", "stopped")
  createBot(svc, { name: "a3", instructions: "x", automations: [{ id: "scan", every: "1 hour" }] }); s.setStatus("a3", "finished")
  let r = await reconcile(deps(s, n, p)); assert.deepEqual(r.created, ["openbot:a1:scan"]); assert.deepEqual(n.items.map((x) => x.name), ["openbot:a1:scan"])
  assert.equal(n.items[0].action.to.session, s.readThreads("a1").auto.sessionID, "anchored on the bot's automation conversation")
  r = await reconcile(deps(s, n, p)); assert.deepEqual([r.created, r.removed, r.kept], [[], [], ["openbot:a1:scan"]], "idempotent")
  s.setStatus("a2", "active"); r = await reconcile(deps(s, n, p)); assert.deepEqual(r.created, ["openbot:a2:scan"])
  s.setStatus("a1", "finished"); r = await reconcile(deps(s, n, p)); assert.deepEqual(r.removed, ["openbot:a1:scan"]); assert.deepEqual(n.items.map((x) => x.name), ["openbot:a2:scan"])
  s.update("a2", { automations: [{ id: "scan", every: "2 hours" }] }); r = await reconcile(deps(s, n, p)); assert.equal(r.removed.length, 1); assert.equal(r.created.length, 1); assert.equal(n.items[0].trigger.every, "2 hours")
  n.items.push({ ...n.items[0], id: "aut_dup" }, { id: "aut_foreign", name: "someone-elses", trigger: { type: "every", every: "1 day" }, action: { type: "prompt", prompt: "x" } }, { id: "aut_orphan", name: "openbot:ghost:x", trigger: { type: "every", every: "1 day" }, action: { type: "prompt", prompt: "x" } })
  r = await reconcile(deps(s, n, p)); assert.deepEqual(r.removed.sort(), ["openbot:a2:scan", "openbot:ghost:x"].sort()); assert.ok(n.items.some((x) => x.name === "someone-elses"), "foreign automations are never touched")
  s.delete("a2"); r = await reconcile(deps(s, n, p)); assert.deepEqual(n.items.map((x) => x.name), ["someone-elses"])
})

test("automation reconcile: errors are reported and kept for diagnostics; a held lock skips; done one-shots are not re-fired", async () => {
  const s = mk(); const p = port(); const n = nativeFake(); createBot(makeService(s), { name: "er", instructions: "x", automations: [{ id: "scan", every: "1 hour" }, { id: "once", at: "in 5 minutes" }] })
  n.failCreate = "automations are off"; let r = await reconcile(deps(s, n, p)); assert.equal(r.errors.length, 2); assert.match(r.errors[0].error, /off/)
  assert.match(fs.readFileSync(path.join(s.botDir("er"), "state", "automation.json"), "utf8"), /automations are off/)
  n.failCreate = null; r = await reconcile(deps(s, n, p)); assert.equal(r.created.length, 2); n.items.find((x) => x.name.endsWith(":once")).status = "done"
  r = await reconcile(deps(s, n, p)); assert.deepEqual(r.created, [], "a finished one-shot stays done")
  fs.mkdirSync(path.join(s.root, "state", "automation.lock"), { recursive: true }); assert.equal((await reconcile(deps(s, n, p))).skipped, "locked")
  const old = new Date(Date.now() - 60_000); fs.utimesSync(path.join(s.root, "state", "automation.lock"), old, old); assert.equal((await reconcile(deps(s, n, p))).skipped, undefined, "stale lock is broken")
  const d = await describeAutomations(n, s.get("er")); assert.equal(d.find((x) => x.id === "once").native.status, "done"); assert.equal(d[0].scheduled, true)
})

/* ---- tools: state ---- */
test("bot_state: read/write/append/replace; a bot edits only itself; validation", async () => {
  const s = mk(); const t = tools(s, port()); createBot(makeService(s), { name: "bs", instructions: "x" }); createBot(makeService(s), { name: "other", instructions: "y" })
  const self = { agent: "bs", sessionID: "ses_b" }
  assert.match((await t.bot_state.execute({ op: "read" }, self)).content, /## Todo/)
  await t.bot_state.execute({ op: "write", content: "# S\n## Todo\n- [ ] a\n" }, self); assert.equal(s.readStateFile("bs"), "# S\n## Todo\n- [ ] a\n")
  await t.bot_state.execute({ op: "append", text: "- [ ] b" }, self); assert.match(s.readStateFile("bs"), /- \[ \] a\n- \[ \] b\n$/)
  await t.bot_state.execute({ op: "replace", old: "- [ ] a", new: "- [x] a" }, self); assert.match(s.readStateFile("bs"), /\[x\] a/)
  assert.match((await t.bot_state.execute({ op: "replace", old: "nope", new: "x" }, self)).content, /not found/)
  await t.bot_state.execute({ op: "write", content: "- [ ] z\n- [ ] z\n" }, self); assert.match((await t.bot_state.execute({ op: "replace", old: "- [ ] z", new: "x" }, self)).content, /2 times/)
  assert.match((await t.bot_state.execute({ name: "other", op: "read" }, self)).content, /not allowed/); assert.match((await t.bot_state.execute({ op: "write" }, self)).content, /content/)
  assert.match((await t.bot_state.execute({ name: "other", op: "read" }, human)).content, /## Todo/, "the user may read any bot's state")
  assert.match((await t.bot_state.execute({ op: "burn" }, self)).content, /op must be/)
})

/* ---- tools: status ---- */
test("bot_status: a bot may only finish itself; the user decides stop/restart; stopping interrupts and unschedules", async () => {
  const s = mk(); const p = port(); const n = nativeFake(); const t = tools(s, p, n); const svc = makeService(s)
  createBot(svc, { name: "ls", instructions: "x", automations: [{ id: "scan", every: "1 hour" }] }); await reconcile(deps(s, n, p)); assert.equal(n.items.length, 1)
  await t.bot_say.execute({ name: "ls", message: "hello", wait: true }, human)
  const self = { agent: "ls", sessionID: "ses_self" }
  assert.match((await t.bot_status.execute({ status: "stopped" }, self)).content, /only set itself to "finished"/); assert.match((await t.bot_status.execute({ name: "ghost", status: "finished" }, self)).content, /not allowed|No bot/)
  const stopped = await t.bot_status.execute({ name: "ls", status: "stopped", note: "pause for now" }, human)
  assert.match(stopped.content, /now stopped[\s\S]*not scheduled/); assert.equal(s.get("ls").status, "stopped"); assert.equal(s.get("ls").statusNote, "pause for now"); assert.equal(n.items.length, 0, "automations removed")
  assert.ok(p.log.some((l) => l[0] === "interrupt"), "running conversations are interrupted")
  assert.match((await t.bot_status.execute({ name: "ls", status: "active" }, human)).content, /1 automation\(s\) scheduled/); assert.equal(n.items.length, 1)
  assert.match((await t.bot_status.execute({ status: "finished", note: "goal achieved" }, self)).content, /now finished/); assert.equal(n.items.length, 0)
  assert.match((await t.bot_status.execute({ status: "active" }, self)).content, /only set itself/, "a finished bot cannot reopen itself")
  assert.match((await t.bot_status.execute({ name: "ls", status: "bogus" }, human)).content, /status must be/)
})

/* ---- tools: notify ---- */
test("bot_notify: lands in the inbox with the conversation it came from", async () => {
  const s = mk(); const t = tools(s, port()); createBot(makeService(s), { name: "nt", instructions: "x" })
  const self = { agent: "nt", sessionID: "ses_n" }
  const r = await t.bot_notify.execute({ message: "Found 3 podcasts, need your pick", level: "attention", title: "Pick" }, self); assert.match(r.content, /inbox \(attention\)/)
  const it = readInbox(s, "nt")[0]; assert.deepEqual([it.level, it.title, it.sessionID, it.status], ["attention", "Pick", "ses_n", "open"])
  assert.equal(readInbox(s, "nt").length, 1); await t.bot_notify.execute({ message: "fyi" }, self); assert.equal(readInbox(s, "nt")[1].level, "info")
  assert.match((await t.bot_notify.execute({ message: "  " }, self)).content, /empty/); assert.match((await t.bot_notify.execute({ message: "x" }, human)).content, /Provide "name"/)
  assert.match((await t.bot_notify.execute({ name: "nt", message: "from the user's agent" }, human)).content, /inbox/)
})

/* ---- tools: automation ---- */
test("bot_automation: add/update/disable/enable/remove/list/run sync the native schedule", async () => {
  const s = mk(); const p = port(); const n = nativeFake(); const t = tools(s, p, n); createBot(makeService(s), { name: "ta", instructions: "x" })
  const self = { agent: "ta", sessionID: "ses_ta" }
  let r = await t.bot_automation.execute({ op: "add", id: "scan", every: "6 hours", prompt: "podcasts" }, self); assert.match(r.content, /added "scan"[\s\S]*Schedule synced/)
  assert.deepEqual(n.items.map((x) => [x.name, x.trigger.every]), [["openbot:ta:scan", "6 hours"]]); assert.equal(s.get("ta").automations[0].prompt, "podcasts")
  await t.bot_automation.execute({ op: "update", id: "scan", cron: "0 9 * * *", tz: "Europe/Paris" }, self); assert.equal(n.items[0].trigger.type, "cron"); assert.equal(s.get("ta").automations[0].every, undefined, "switching trigger replaces the old one")
  await t.bot_automation.execute({ op: "disable", id: "scan" }, self); assert.equal(n.items.length, 0); await t.bot_automation.execute({ op: "enable", id: "scan" }, self); assert.equal(n.items.length, 1)
  const listed = JSON.parse((await t.bot_automation.execute({ op: "list" }, self)).content); assert.equal(listed.automations[0].native.status, "active"); assert.equal(listed.status, "active")
  const run = await t.bot_automation.execute({ op: "run", id: "scan" }, self); assert.match(run.content, /Run started/); assert.match(JSON.stringify(p.sessions.get(s.readThreads("ta").auto.sessionID).msgs), /automation \\"scan\\"/)
  await t.bot_automation.execute({ op: "remove", id: "scan" }, self); assert.equal(n.items.length, 0); assert.equal(s.get("ta").automations.length, 0)
  assert.match((await t.bot_automation.execute({ op: "add", id: "x", every: "10 seconds" }, self)).content, /every must look/); assert.match((await t.bot_automation.execute({ op: "add", id: "x" }, self)).content, /exactly one/)
  assert.match((await t.bot_automation.execute({ op: "update", id: "nope", every: "1 hour" }, self)).content, /no automation/)
  createBot(makeService(s), { name: "tb", instructions: "y" }); assert.match((await t.bot_automation.execute({ name: "tb", op: "add", id: "x", every: "1 hour" }, self)).content, /not allowed/)
  assert.match((await t.bot_automation.execute({ name: "tb", op: "list" }, self)).content, /automations/, "reading another bot is fine")
  s.setStatus("ta", "stopped"); assert.match((await t.bot_automation.execute({ op: "run", id: "scan" }, self)).content, /stopped: set it active/)
  r = await t.bot_automation.execute({ op: "add", id: "later", every: "1 day" }, human); assert.match(r.content, /Provide "name"/)
  r = await t.bot_automation.execute({ name: "ta", op: "add", id: "later", every: "1 day" }, human); assert.match(r.content, /bot is stopped, so nothing is scheduled/)
})

test("bot_automation: without native automations the schedule is saved and the user is told", async () => {
  const s = mk(); const t = tools(s, port(), undefined); createBot(makeService(s), { name: "nn", instructions: "x" })
  assert.match((await t.bot_automation.execute({ name: "nn", op: "add", id: "a", every: "1 hour" }, human)).content, /no automations: saved in bot\.json only/)
})

test("bot_update/bot_create accept automations", async () => {
  const s = mk(); const t = tools(s, port()); await t.bot_create.execute({ name: "cu", instructions: "x", automations: [{ id: "a", every: "1 hour" }] }, human)
  assert.equal(s.get("cu").automations.length, 1); await t.bot_update.execute({ name: "cu", automations: null }, human); assert.equal(s.get("cu").automations, undefined)
  assert.match((await t.bot_update.execute({ name: "cu", automations: [{ id: "a" }] }, human)).content, /exactly one/)
})

test("state.md: addToSection puts lines in the right section, drops placeholders, keeps the rest", () => {
  const md = "# S\n\n## Important\n- \n\n## Todo\n- [ ] \n- [x] done\n\n## Waiting for the user\n- (nothing)\n\n## Notes\n"
  let r = addToSection(md, "Todo", "- [ ] call Ada")
  assert.match(r, /## Todo\n- \[x\] done\n- \[ \] call Ada\n\n## Waiting/); assert.ok(!/- \[ \] \n/.test(r), "empty todo placeholder removed")
  r = addToSection(r, "Important", "- budget is small"); assert.match(r, /## Important\n- budget is small\n\n## Todo/)
  r = addToSection(r, "Waiting for the user", "- the budget decision"); assert.ok(!/\(nothing\)/.test(r)); assert.match(r, /## Waiting for the user\n- the budget decision/)
  r = addToSection(r, "Notes", "- first note"); assert.match(r, /## Notes\n- first note\n$/)
  assert.match(addToSection("# only title\n", "Todo", "- [ ] x"), /## Todo\n- \[ \] x/)
})

test("tui: a question field reads the host's shape (text in description, header in title)", () => {
  assert.equal(fieldText({ key: "q0", title: "Pick", description: "Which podcast first?" }), "Which podcast first?")
  assert.equal(fieldText({ title: "Pick" }), "Pick"); assert.equal(fieldText({}), "(question)")
})

test("diagnose: status, state, automations, plugin-not-loaded-in-workdir, inbox, history", async () => {
  const s = mk(); const svc = makeService(s)
  const env = (over = {}) => ({ store: s, pluginVersion: "x", materializeEnabled: true, pluginLoadedAt: async () => true, agentsAt: async () => ["d1"], models: async () => [], defaultModel: async () => "p/m", skillsAt: async () => [], mcpAt: async () => [], sessionContext: async () => [], ...over })
  createBot(svc, { name: "d1", instructions: "x", model: "p/m", automations: [{ id: "scan", every: "1 hour" }] })
  let r = await diagnose(env(), "d1"); let by = Object.fromEntries(r.checks.map((c) => [c.id, c]))
  assert.equal(by.status.level, "ok"); assert.equal(by.state.level, "ok"); assert.match(by.automations.title, /1 automation\(s\) configured and synced/); assert.match(by.history.title, /nothing recorded/)
  fs.mkdirSync(path.join(s.botDir("d1"), "state"), { recursive: true }); fs.writeFileSync(path.join(s.botDir("d1"), "state", "automation.json"), JSON.stringify({ errors: [{ name: "openbot:d1:scan", error: "automations are off" }] }))
  r = await diagnose(env({ pluginLoadedAt: async () => false }), "d1"); by = Object.fromEntries(r.checks.map((c) => [c.id, c]))
  assert.equal(by.automations.level, "error"); assert.match(by.automations.title, /automations are off/); assert.equal(by["tools-in-workdir"].level, "error"); assert.match(by["tools-in-workdir"].fix, /globally/)
  s.setStatus("d1", "finished", "done"); addInboxItem(s, "d1", { level: "info", message: "x" }); fs.mkdirSync(path.join(s.botDir("d1"), "history"), { recursive: true }); fs.writeFileSync(path.join(s.botDir("d1"), "history", "index.json"), JSON.stringify({ ses_1: { count: 2 } }))
  r = await diagnose(env(), "d1"); by = Object.fromEntries(r.checks.map((c) => [c.id, c]))
  assert.match(by.status.title, /finished \(done\)/); assert.match(by.inbox.title, /1 item/); assert.match(by.history.title, /1 recorded/)
  createBot(svc, { name: "d2", instructions: "y", model: "p/m" }); r = await diagnose(env({ pluginLoadedAt: async () => false, agentsAt: async () => ["d2"] }), "d2")
  assert.equal(r.checks.find((c) => c.id === "tools-in-workdir").level, "warn", "a warning (not an error) when the bot has no automations")
})
