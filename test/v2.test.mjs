import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { BotStore } from "../dist/store.js"
import { MARKER, renderAgentFile, materialize, dematerialize, inspectMaterialized, agentFilePath } from "../dist/materialize.js"
import { makeService, createBot, updateBot, deleteBot, importBot, syncAll, materializeEnv } from "../dist/service.js"
import { ensureSession, say } from "../dist/session-io.js"
import { buildTools, explainError } from "../dist/tools.js"
import { composeSystem } from "../dist/host.js"
import { listTree, readInside, renderTree } from "../dist/files.js"
import { diagnose, renderChecks } from "../dist/debug/diagnose.js"
import { buildReport, writeReport, redactBot } from "../dist/debug/report.js"
import { createDebugLog, tailLog } from "../dist/debug/log.js"
import { debugEnabled } from "../dist/debug/enabled.js"
import { clientDiagEnv } from "../dist/debug/client-env.js"
import { VERSION } from "../dist/version.js"
import { tmpdir } from "./helpers/tmp.mjs"

const mk = () => new BotStore(tmpdir())
const env = (s) => materializeEnv(s)

test("version constant matches package.json", () => {
  assert.equal(VERSION, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version)
})

test("system.md: master prompt is its own file; bot.json stays clean; hand edits are detected", () => {
  const s = mk(); s.create({ name: "sm", instructions: "ORIGINAL" })
  assert.equal(fs.readFileSync(s.systemPath("sm"), "utf8"), "ORIGINAL\n")
  assert.ok(!("instructions" in JSON.parse(fs.readFileSync(path.join(s.botDir("sm"), "bot.json"), "utf8"))))
  const sig = s.signature()
  fs.writeFileSync(s.systemPath("sm"), "EDITED BY HAND\n")
  assert.notEqual(s.signature(), sig, "system.md edits change the signature")
  assert.equal(s.get("sm").instructions, "EDITED BY HAND")
  s.update("sm", { instructions: "VIA TOOL" })
  assert.equal(fs.readFileSync(s.systemPath("sm"), "utf8"), "VIA TOOL\n")
})

test("system.md: legacy bots (instructions inside bot.json) are migrated", () => {
  const s = mk(); fs.mkdirSync(s.botDir("old"), { recursive: true })
  fs.writeFileSync(path.join(s.botDir("old"), "bot.json"), JSON.stringify({ name: "old", instructions: "legacy prompt", model: "a/b" }))
  assert.equal(s.get("old").instructions, "legacy prompt")
  assert.deepEqual(s.migrate(), ["old"])
  assert.equal(fs.readFileSync(s.systemPath("old"), "utf8"), "legacy prompt\n")
  assert.deepEqual(s.migrate(), [], "idempotent")
  assert.equal(s.get("old").model, "a/b")
})

test("threads: per-caller conversations, legacy session.json becomes main", () => {
  const s = mk(); s.create({ name: "th", instructions: "x" })
  assert.deepEqual(s.listThreads("th"), [])
  s.setThread("th", "ses_A", { sessionID: "ses_bot1", parentID: "ses_A", createdAt: "2026-01-01T00:00:00Z", lastAt: "2026-01-01T00:00:00Z" })
  s.setThread("th", "main", { sessionID: "ses_bot2", createdAt: "2026-01-02T00:00:00Z", lastAt: "2026-01-02T00:00:00Z" })
  assert.deepEqual(s.listThreads("th").map((t) => t.key), ["main", "ses_A"], "most recent first")
  assert.ok(s.isBotSession("th", "ses_bot1") && !s.isBotSession("th", "ses_other"))
  s.touchThread("th", "ses_A"); assert.equal(s.listThreads("th")[0].key, "ses_A")
  const l = mk(); l.create({ name: "lg", instructions: "x" }); l.writeState("lg", { sessionID: "ses_legacy", sessionCreatedAt: "2026-01-01T00:00:00Z" })
  assert.equal(l.readThreads("lg").main.sessionID, "ses_legacy")
})

test("materialize: renders a native agent file with marker, model, permissions", () => {
  const s = mk(); const bot = s.create({ name: "mat", instructions: "DO WORK", description: 'says "hi"', model: "p/m#v", skills: ["web"] })
  const out = renderAgentFile(bot, env(s))
  assert.match(out, /^---\n/); assert.ok(out.includes(MARKER)); assert.match(out, /mode: all/)
  assert.match(out, /model: "p\/m#v"/); assert.match(out, /description: "says \\"hi\\""/)
  assert.match(out, /- \{action: "skill", resource: "\*", effect: "deny"\}/); assert.match(out, /resource: "web"/)
  assert.match(out, /DO WORK/); assert.ok(out.includes(s.systemPath("mat")), "the bot is told where its master prompt lives")
})

test("materialize: write, unchanged, conflict with foreign file, safe removal", () => {
  const s = mk(); const bot = s.create({ name: "wr", instructions: "x" })
  assert.equal(inspectMaterialized(bot, env(s)), "missing")
  assert.equal(materialize(bot, env(s)).status, "written"); assert.equal(materialize(bot, env(s)).status, "unchanged")
  assert.equal(inspectMaterialized(bot, env(s)), "ok")
  fs.appendFileSync(agentFilePath(bot), "tamper"); assert.equal(inspectMaterialized(bot, env(s)), "stale")
  fs.writeFileSync(agentFilePath(bot), "---\nmode: all\n---\nmy own agent, not openbot's\n")
  assert.equal(materialize(bot, env(s)).status, "conflict"); assert.equal(inspectMaterialized(bot, env(s)), "foreign")
  assert.equal(dematerialize(bot), "foreign"); assert.ok(fs.existsSync(agentFilePath(bot)), "foreign files are never deleted")
  fs.rmSync(agentFilePath(bot)); materialize(bot, env(s)); assert.equal(dematerialize(bot), "removed"); assert.equal(dematerialize(bot), "absent")
})

test("service: create/update/delete keep the agent file in sync; materialize:false writes nothing", () => {
  const s = mk(); const svc = makeService(s); const w1 = tmpdir(); const w2 = tmpdir()
  const bot = createBot(svc, { name: "sv", instructions: "a", workdir: w1 })
  assert.ok(fs.existsSync(path.join(w1, ".opencode", "agents", "sv.md")))
  updateBot(svc, "sv", { instructions: "b" }); assert.match(fs.readFileSync(path.join(w1, ".opencode", "agents", "sv.md"), "utf8"), /\nb\n/)
  updateBot(svc, "sv", { workdir: w2 })
  assert.ok(!fs.existsSync(path.join(w1, ".opencode", "agents", "sv.md")) && fs.existsSync(path.join(w2, ".opencode", "agents", "sv.md")), "moves with the workdir")
  deleteBot(svc, "sv"); assert.ok(!fs.existsSync(path.join(w2, ".opencode", "agents", "sv.md")))
  const off = makeService(mk(), { materialize: false }); const w3 = tmpdir()
  createBot(off, { name: "off", instructions: "x", workdir: w3 }); assert.ok(!fs.existsSync(path.join(w3, ".opencode")))
})

test("service: syncAll migrates legacy bots and heals missing agent files; import materializes", () => {
  const s = mk(); const svc = makeService(s); const w = tmpdir()
  fs.mkdirSync(s.botDir("lg"), { recursive: true })
  fs.writeFileSync(path.join(s.botDir("lg"), "bot.json"), JSON.stringify({ name: "lg", instructions: "legacy", workdir: w }))
  const r = syncAll(svc); assert.deepEqual(r.migrated, ["lg"]); assert.ok(fs.existsSync(path.join(w, ".opencode", "agents", "lg.md")))
  fs.rmSync(path.join(w, ".opencode"), { recursive: true }); syncAll(svc); assert.ok(fs.existsSync(path.join(w, ".opencode", "agents", "lg.md")), "healed")
  const other = mk(); createBot(makeService(other), { name: "imp", instructions: "x" })
  const bundleFile = path.join(tmpdir(), "b.json"); fs.writeFileSync(bundleFile, JSON.stringify(JSON.parse(JSON.stringify(
    { format: "openbot.bundle", version: 1, bot: { name: "imp", instructions: "from bundle" }, files: {}, warnings: [] }))))
  const imp = importBot(svc, { file: bundleFile }); assert.ok(fs.existsSync(agentFilePath(imp.bot)))
})

/* ---- sessions as child threads ---- */
function port() {
  const sessions = new Map(); const log = []; let n = 0; const p = { log, sessions, failParent: false }
  Object.assign(p, {
    async create(i) { if (i.parentID && p.failParent) throw new Error("cross-location parent refused"); const s = { id: `ses_${++n}`, location: i.location, parentID: i.parentID, agent: i.agent }; sessions.set(s.id, s); log.push(["create", i]); return s },
    async get({ sessionID }) { const s = sessions.get(sessionID); if (!s) throw new Error("gone"); return s },
    async prompt(i) { const id = `m_${++n}`; sessions.get(i.sessionID).msgs = [{ id, type: "user", text: i.text }, { id: `m_${++n}`, type: "assistant", content: [{ type: "text", text: "echo:" + i.text }] }, { id: `m_${++n}`, type: "idle", outcome: "succeeded" }]; return { id } },
    async move(i) { log.push(["move", i]); if (p.failMove) throw new Error("move refused") }, failMove: false,
    async wait() {}, async context({ sessionID }) { return sessions.get(sessionID).msgs ?? [] }, async interrupt() {},
    async list() { return [...sessions.values()] },
  })
  return p
}

test("threads: one conversation per calling session, created as its child; main when there is no caller", async () => {
  const s = mk(); const bot = s.create({ name: "kid", instructions: "x" }); const p = port()
  const a = await ensureSession(p, s, bot, { callerSessionID: "ses_callerA" }); const a2 = await ensureSession(p, s, bot, { callerSessionID: "ses_callerA" })
  const b = await ensureSession(p, s, bot, { callerSessionID: "ses_callerB" }); const m = await ensureSession(p, s, bot, {})
  assert.equal(a.sessionID, a2.sessionID); assert.notEqual(a.sessionID, b.sessionID); assert.equal(m.key, "main")
  assert.equal(p.log.find((l) => l[0] === "create")[1].parentID, "ses_callerA"); assert.ok(a.parented)
  assert.equal(p.log.filter((l) => l[0] === "create")[2].parentID, undefined, "no parent for main")
  assert.deepEqual(s.listThreads("kid").map((t) => t.key).sort(), ["main", "ses_callerA", "ses_callerB"])
  const f = await ensureSession(p, s, bot, { callerSessionID: "ses_callerA", fresh: true }); assert.notEqual(f.sessionID, a.sessionID)
})

test("threads: a parented session is moved to the bot's workdir; its stale reported location does not cause re-creation", async () => {
  const s = mk(); const bot = s.create({ name: "mv", instructions: "x" }); const p = port()
  const a = await ensureSession(p, s, bot, { callerSessionID: "ses_c" })
  assert.deepEqual(p.log.find((l) => l[0] === "move")[1], { sessionID: a.sessionID, directory: bot.workdir })
  assert.equal(s.listThreads("mv")[0].workdir, bot.workdir)
  p.sessions.get(a.sessionID).location = { directory: "/the/callers/project" } // what the host reports before the first run
  const b = await ensureSession(p, s, bot, { callerSessionID: "ses_c" }); assert.equal(b.sessionID, a.sessionID); assert.equal(b.created, false)
  const moved = { ...bot, workdir: tmpdir() }; const c = await ensureSession(p, s, moved, { callerSessionID: "ses_c" })
  assert.notEqual(c.sessionID, a.sessionID, "new session when the bot's workdir changed")
  p.failMove = true; const d = await ensureSession(p, s, bot, { callerSessionID: "ses_d" }); assert.ok(d.parented, "a failed move does not lose the parent link")
})

test("threads: falls back to a standalone session when the host refuses the parent", async () => {
  const s = mk(); const bot = s.create({ name: "fb", instructions: "x" }); const p = port(); p.failParent = true
  const r = await ensureSession(p, s, bot, { callerSessionID: "ses_x" })
  assert.equal(r.parented, false); assert.equal(s.listThreads("fb")[0].parentID, "ses_x", "parent still recorded for the UI")
  assert.equal((await say(p, s, bot, "hi", { callerSessionID: "ses_x", pollMs: 1 })).thread, "ses_x")
})

/* ---- tools ---- */
const tools = (s, p) => Object.fromEntries(buildTools({ store: s, service: makeService(s), session: p, reload: async () => {} }).map((t) => [t.name, t]))
const human = { agent: "build", sessionID: "ses_human" }

test("tools: bot_say links the bot's conversation to the calling session; history/conversations find it", async () => {
  const s = mk(); const p = port(); const t = tools(s, p); createBot(makeService(s), { name: "ask", instructions: "x" })
  const bg = await t.bot_say.execute({ name: "ask", message: "background please" }, human)
  assert.equal(bg.metadata.status, "started"); assert.match(bg.content, /background result/); assert.equal(bg.metadata.thread, "ses_human")
  const r = await t.bot_say.execute({ name: "ask", message: "ping", wait: true }, human); assert.equal(r.content, "echo:ping"); assert.equal(r.metadata.thread, "ses_human")
  assert.equal((await t.bot_say.execute({ name: "ask", message: "no caller session" }, { agent: "build", sessionID: "" })).content, "echo:no caller session", "blocks when there is no conversation to deliver to")
  const h = JSON.parse((await t.bot_history.execute({ name: "ask" }, human)).content); assert.equal(h.sessionID, r.metadata.sessionID)
  const convs = JSON.parse((await t.bot_conversations.execute({ name: "ask" }, human)).content)
  const mine = convs.conversations.find((x) => x.thread === "ses_human"); assert.equal(mine.startedFrom, "ses_human"); assert.equal(mine.exists, true)
  const viaId = JSON.parse((await t.bot_history.execute({ name: "ask", thread: r.metadata.sessionID }, { agent: "build", sessionID: "ses_other" })).content)
  assert.equal(viaId.sessionID, r.metadata.sessionID)
  assert.match((await t.bot_history.execute({ name: "ask", thread: "last" }, { agent: "build", sessionID: "ses_other" })).content, /messages/)
})

test("tools: bot_conversations also lists other sessions that use the bot's agent", async () => {
  const s = mk(); const p = port(); const t = tools(s, p); const bot = createBot(makeService(s), { name: "oth", instructions: "x" })
  p.sessions.set("ses_manual", { id: "ses_manual", agent: "oth", title: "I switched agent with Tab", location: { directory: bot.workdir } })
  const out = JSON.parse((await t.bot_conversations.execute({ name: "oth" }, human)).content)
  assert.deepEqual(out.otherSessionsUsingThisBot.map((x) => x.sessionID), ["ses_manual"])
})

test("tools: bot_files lists the workdir and reads inside it only", async () => {
  const s = mk(); const t = tools(s, port()); const bot = createBot(makeService(s), { name: "fl", instructions: "x" })
  fs.mkdirSync(path.join(bot.workdir, "notes")); fs.writeFileSync(path.join(bot.workdir, "crm.md"), "# CRM\n- Ada")
  const list = (await t.bot_files.execute({ name: "fl" }, human)).content; assert.match(list, /crm\.md/); assert.match(list, /notes\//)
  assert.match((await t.bot_files.execute({ name: "fl", path: "crm.md" }, human)).content, /Ada/)
  assert.match((await t.bot_files.execute({ name: "fl", path: "../../../etc/passwd" }, human)).content, /escapes/)
  assert.match((await t.bot_get.execute({ name: "fl" }, human)).content, /systemPromptFile/)
})

test("tools: create reports the master prompt file; update(instructions) writes system.md and the agent file", async () => {
  const s = mk(); const t = tools(s, port())
  const c = await t.bot_create.execute({ name: "mp", instructions: "first" }, human); assert.ok(c.content.includes(s.systemPath("mp")))
  await t.bot_update.execute({ name: "mp", instructions: "second" }, human)
  assert.equal(fs.readFileSync(s.systemPath("mp"), "utf8"), "second\n"); assert.match(fs.readFileSync(agentFilePath(s.get("mp")), "utf8"), /second/)
})

test("tools: explainError turns 'Agent not found' into guidance", () => {
  assert.match(explainError('Agent not found: "x"'), /materialize/); assert.equal(explainError("other"), "other")
})

test("host: system prompt tells the bot where its master prompt is", () => {
  assert.match(composeSystem({ name: "n", instructions: "I", workdir: "/w" }, "/b/n/system.md"), /\/b\/n\/system\.md/)
  assert.doesNotMatch(composeSystem({ name: "n", instructions: "I", workdir: "/w" }), /master prompt/)
})

/* ---- files ---- */
test("files: tree skips noise and truncates; readInside blocks escapes and binaries", () => {
  const d = tmpdir(); fs.mkdirSync(path.join(d, "node_modules", "x"), { recursive: true }); fs.mkdirSync(path.join(d, "a", "b", "c", "d"), { recursive: true })
  fs.writeFileSync(path.join(d, "a", "x.md"), "hi"); fs.writeFileSync(path.join(d, "bin"), Buffer.from([0, 1, 2]))
  const names = listTree(d, { depth: 2 }).entries.map((e) => e.path); assert.ok(!names.some((n) => n.includes("node_modules")) && !names.some((n) => n.includes("c")))
  assert.equal(listTree(d, { max: 1 }).truncated, true); assert.match(renderTree("/nonexistent/zzz"), /does not exist/)
  assert.equal(readInside(d, "a/x.md").ok, true); assert.equal(readInside(d, "../x").ok, false); assert.match(readInside(d, "bin").error, /binary/)
})

/* ---- debug package ---- */
test("debug switch: option wins, then env, default off", () => {
  assert.equal(debugEnabled(undefined, {}), false); assert.equal(debugEnabled({}, { OPENBOT_DEBUG: "1" }), true)
  assert.equal(debugEnabled({ debug: false }, { OPENBOT_DEBUG: "1" }), false); assert.equal(debugEnabled({ debug: true }, {}), true)
})

test("debug log: silent when off, JSON lines when on, tail works", () => {
  const root = tmpdir(); createDebugLog(root, false)("x", {}); assert.ok(!fs.existsSync(path.join(root, "logs")))
  const log = createDebugLog(root, true, "/here"); log("a", { n: 1 }); log("b"); const lines = tailLog(root, 10)
  assert.equal(lines.length, 2); assert.equal(JSON.parse(lines[0]).event, "a"); assert.equal(JSON.parse(lines[0]).where, "/here")
})

function fakeEnv(s, over = {}) {
  const base = {
    store: s, pluginVersion: "0.2.0", appVersion: "2.4.1", location: "/proj", materializeEnabled: true,
    pluginLoadedAt: async () => true, agentsAt: async () => ["bot1"], models: async () => ["p/m"], defaultModel: async () => "p/m",
    skillsAt: async () => ["web"], mcpAt: async () => [], sessionContext: async () => [],
  }
  return { ...base, ...over }
}

test("diagnose: a healthy bot has no errors", async () => {
  const s = mk(); const svc = makeService(s); createBot(svc, { name: "bot1", instructions: "x", model: "p/m" })
  const r = await diagnose(fakeEnv(s)); assert.equal(r.ok, true, renderChecks(r)); assert.ok(r.counts.ok >= 5)
})

test("diagnose: finds the missing model, missing agent, and a failed last run — with fixes", async () => {
  const s = mk(); const svc = makeService(s); const bot = createBot(svc, { name: "bot1", instructions: "x" }); fs.rmSync(path.join(bot.workdir, ".opencode"), { recursive: true })
  s.setThread("bot1", "main", { sessionID: "ses_1", createdAt: "t", lastAt: "t" })
  const r = await diagnose(fakeEnv(s, { defaultModel: async () => undefined, agentsAt: async () => [], pluginLoadedAt: async () => false, sessionContext: async () => [{ type: "idle", outcome: "failed", error: { message: 'Agent not found: "bot1"' } }] }))
  const ids = Object.fromEntries(r.checks.filter((c) => c.scope === "bot1").map((c) => [c.id, c])); assert.equal(r.ok, false)
  assert.equal(ids.model.level, "error"); assert.match(ids.model.fix, /bot_update/)
  assert.equal(ids["agent-workdir"].level, "error"); assert.equal(ids["agent-file"].level, "warn")
  assert.equal(ids["last-run"].level, "error"); assert.match(ids["last-run"].fix, /agent/)
  assert.match(renderChecks(r, { onlyProblems: true }), /fix:/)
})

test("diagnose: global problems (invalid bot.json, no models, plugin not loaded)", async () => {
  const s = mk(); fs.mkdirSync(s.botDir("bad"), { recursive: true }); fs.writeFileSync(path.join(s.botDir("bad"), "bot.json"), "{nope")
  const r = await diagnose(fakeEnv(s, { models: async () => [], pluginLoadedAt: async () => false }))
  const g = Object.fromEntries(r.checks.filter((c) => c.scope === "global").map((c) => [c.id, c.level]))
  assert.equal(g["invalid:bad"], "error"); assert.equal(g.models, "error"); assert.equal(g["plugin-here"], "error")
})

test("diagnose: MCP command not found; unknown model is a warning, not an error", async () => {
  const s = mk(); createBot(makeService(s), { name: "bot1", instructions: "x", model: "nope/none", mcps: { x: { type: "local", command: ["definitely-not-a-command-xyz"] } } })
  const r = await diagnose(fakeEnv(s), "bot1"); const c = Object.fromEntries(r.checks.map((x) => [x.id, x]))
  assert.equal(c.model.level, "warn"); assert.equal(c["mcp:x"].level, "error")
  assert.equal((await diagnose(fakeEnv(s), "ghost")).ok, false)
})

test("report: markdown with sections, secrets redacted, file written", async () => {
  const s = mk(); const svc = makeService(s); createBot(svc, { name: "bot1", instructions: "MASTER PROMPT TEXT", model: "p/m", mcps: { c: { type: "local", command: ["node"], environment: { TOKEN: "s3cret-value" } } } })
  s.setThread("bot1", "main", { sessionID: "ses_1", createdAt: "t", lastAt: "t" })
  const { markdown, result } = await buildReport(fakeEnv(s, { sessionContext: async () => [{ type: "idle", outcome: "failed", error: { message: "boom" } }] }))
  assert.match(markdown, /# openbot diagnostic report/); assert.match(markdown, /## Bot `bot1`/); assert.match(markdown, /MASTER PROMPT TEXT/)
  assert.match(markdown, /boom/); assert.ok(!markdown.includes("s3cret-value")); assert.match(markdown, /Working directory/); assert.equal(typeof result.ok, "boolean")
  const file = writeReport(s.root, markdown); assert.ok(fs.existsSync(file)); assert.equal(redactBot(s.get("bot1")).mcps.c.environment.TOKEN, "<redacted>")
})

test("client adapter: maps the real {location,data} shapes", async () => {
  const s = mk(); const calls = []
  const client = {
    agent: { list: async (i) => (calls.push(["agent", i?.location?.directory]), { data: [{ id: "bot1" }, { id: "openbot-marker" }] }) },
    model: { list: async () => ({ data: [{ providerID: "p", modelID: "m" }] }), default: async () => ({ data: { providerID: "p", modelID: "m" } }) },
    skill: { list: async () => ({ data: [{ id: "s.web", name: "web" }] }) }, mcp: { list: async () => ({ data: [{ name: "bot1-c", status: "connected" }] }) },
    session: { context: async () => [{ type: "idle", outcome: "succeeded" }] },
  }
  const e = clientDiagEnv(client, { store: s, pluginVersion: "x", location: "/proj", materializeEnabled: true })
  assert.equal(await e.pluginLoadedAt("/w"), true); assert.deepEqual(await e.agentsAt("/w"), ["bot1", "openbot-marker"]); assert.deepEqual(calls[0], ["agent", "/w"])
  assert.deepEqual(await e.models(), ["p/m"]); assert.equal(await e.defaultModel(), "p/m"); assert.deepEqual(await e.skillsAt("/w"), ["web", "s.web"])
  assert.deepEqual(await e.mcpAt("/w"), [{ name: "bot1-c", status: "connected", error: undefined }])
})
