import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { BotStore } from "../dist/store.js"
import { nameProblem } from "../dist/names.js"
import { findMention, delegationText } from "../dist/mention.js"
import { exportBundle, importBundle, exportToFile, importFromFile, REDACTED } from "../dist/bundle.js"
import { applyAgents, applyWorkdirMcp, applyWorkdirSkills, newOwned, parseModelRef, composeSystem, skillRules } from "../dist/host.js"
import { extractReply, summarizeMessages, ensureSession, say } from "../dist/session-io.js"
import { resolveRoot } from "../dist/paths.js"
import { buildTools } from "../dist/tools.js"
import { tmpdir } from "./helpers/tmp.mjs"

const mk = () => new BotStore(tmpdir())

test("names: accepts good, rejects bad and reserved", () => {
  assert.equal(nameProblem("scout"), undefined)
  assert.equal(nameProblem("crm-bot2"), undefined)
  for (const bad of ["A", "x", "Scout", "1bot", "bot-", "has space", "build", "plan", "", 5]) assert.ok(nameProblem(bad), String(bad))
})

test("paths: root priority option > OPENBOT_HOME > XDG", () => {
  assert.equal(resolveRoot({ root: "/a/b" }, {}), "/a/b")
  assert.equal(resolveRoot({}, { OPENBOT_HOME: "/h" }), "/h")
  assert.equal(resolveRoot(undefined, { XDG_DATA_HOME: "/x" }), "/x/openbot")
})

test("store: create/get/list/update/delete round trip", () => {
  const s = mk()
  const b = s.create({ name: "scout", instructions: " find partners ", description: "d", model: "anthropic/claude-x#high", skills: ["a", "a", "b"] })
  assert.equal(b.instructions, "find partners")
  assert.deepEqual(b.skills, ["a", "b"])
  assert.equal(b.workdir, path.join(s.botDir("scout"), "workspace"))
  assert.ok(fs.existsSync(b.workdir))
  assert.equal(s.list().length, 1)
  const u = s.update("scout", { instructions: "new", model: null, skills: null, description: null })
  assert.equal(u.instructions, "new")
  assert.equal(u.model, undefined)
  assert.equal(u.skills, undefined)
  assert.equal(u.description, undefined)
  assert.throws(() => s.create({ name: "scout", instructions: "x" }), /already exists/)
  s.delete("scout")
  assert.equal(s.get("scout"), undefined)
  assert.throws(() => s.require("scout"), /No bot named/)
})

test("store: validation errors are clear", () => {
  const s = mk()
  assert.throws(() => s.create({ name: "a1", instructions: "" }), /instructions/)
  assert.throws(() => s.create({ name: "a1", instructions: "x", model: "nope" }), /provider\/model/)
  assert.throws(() => s.create({ name: "a1", instructions: "x", workdir: "/" }), /root/)
  assert.throws(() => s.create({ name: "a1", instructions: "x", mcps: { Bad: { type: "local", command: ["x"] } } }), /mcp server name/)
  assert.throws(() => s.create({ name: "a1", instructions: "x", mcps: { ok: { type: "local", command: [] } } }), /command/)
  assert.throws(() => s.create({ name: "a1", instructions: "x", mcps: { ok: { type: "remote", url: "ftp://x" } } }), /http/)
  assert.throws(() => s.create({ name: "a1", instructions: "x", skills: "nope" }), /skills/)
})

test("store: workdir is created and ~ expanded", () => {
  const s = mk(); const w = path.join(tmpdir(), "deep", "dir")
  s.create({ name: "wd", instructions: "x", workdir: w })
  assert.ok(fs.existsSync(w))
})

test("store: hand-edited bot.json is parsed; broken ones reported, not fatal", () => {
  const s = mk()
  s.create({ name: "good", instructions: "ok" })
  fs.mkdirSync(s.botDir("broken"), { recursive: true })
  fs.writeFileSync(path.join(s.botDir("broken"), "bot.json"), "{ nope")
  fs.mkdirSync(s.botDir("wrongname"), { recursive: true })
  fs.writeFileSync(path.join(s.botDir("wrongname"), "bot.json"), JSON.stringify({ name: "other", instructions: "x" }))
  const r = s.listWithProblems()
  assert.deepEqual(r.bots.map((b) => b.name), ["good"])
  assert.equal(r.problems.length, 2)
  // a minimal hand-written file is enough
  fs.mkdirSync(s.botDir("mini"), { recursive: true })
  fs.writeFileSync(path.join(s.botDir("mini"), "bot.json"), JSON.stringify({ name: "mini", instructions: "just this" }))
  assert.equal(s.get("mini").workdir, path.join(s.botDir("mini"), "workspace"))
})

test("store: newer schema refused; signature changes on edit", () => {
  const s = mk(); s.create({ name: "sig", instructions: "x" })
  const sig = s.signature()
  fs.writeFileSync(path.join(s.botDir("sig"), "bot.json"), JSON.stringify({ name: "sig", instructions: "changed!!", schema: 99 }))
  assert.notEqual(s.signature(), sig)
  assert.throws(() => s.get("sig"), /newer than this openbot/)
})

test("store: state is separate from config", () => {
  const s = mk(); s.create({ name: "st", instructions: "x" })
  assert.deepEqual(s.readState("st"), {})
  s.writeState("st", { sessionID: "ses_1" })
  assert.equal(s.readState("st").sessionID, "ses_1")
  assert.ok(!("sessionID" in s.get("st")))
})

test("mention: structured, leading plain text, and non-bots", () => {
  const isBot = (n) => n === "scout"
  const text = "hey @scout find me leads please"
  const m = findMention({ text, agents: [{ name: "scout", mention: { start: 4, end: 10, text: "@scout" } }] }, isBot)
  assert.deepEqual(m, { bot: "scout", message: "hey find me leads please" })
  assert.deepEqual(findMention({ text: "@scout: do it" }, isBot), { bot: "scout", message: "do it" })
  assert.equal(findMention({ text: "mail me @scout later" }, isBot), undefined) // plain mid-text mention is not structured
  assert.equal(findMention({ text: "@build hi" }, isBot), undefined)
  assert.equal(findMention({ text: "x", agents: [{ name: "explore" }] }, isBot), undefined)
  const d = delegationText({ bot: "scout", message: "hi" })
  assert.match(d, /bot_say/); assert.match(d, /"scout"/); assert.match(d, /hi/)
  assert.match(delegationText({ bot: "scout", message: "" }), /without a message/)
})

test("bundle: export redacts secrets, import round trips with local skills", () => {
  const a = mk(); const b = mk()
  a.create({ name: "src", instructions: "role", mcps: { crm: { type: "local", command: ["node", "x.js"], environment: { TOKEN: "s3cret" } }, web: { type: "remote", url: "https://x.test/mcp", headers: { Authorization: "Bearer zzz" } } } })
  fs.mkdirSync(path.join(a.skillsDir("src"), "hello"), { recursive: true })
  fs.writeFileSync(path.join(a.skillsDir("src"), "hello", "SKILL.md"), "---\nname: hello\ndescription: says hi\n---\nbody")
  const bundle = exportBundle(a, "src")
  const raw = JSON.stringify(bundle)
  assert.ok(!raw.includes("s3cret") && !raw.includes("zzz"))
  assert.ok(raw.includes(REDACTED))
  assert.ok(!("workdir" in bundle.bot))
  assert.ok(bundle.files["skills/hello/SKILL.md"])
  const { bot, warnings } = importBundle(b, bundle, { rename: "copy" })
  assert.equal(bot.name, "copy")
  assert.ok(warnings.some((w) => /redacted/.test(w)))
  assert.ok(fs.existsSync(path.join(b.skillsDir("copy"), "hello", "SKILL.md")))
  assert.throws(() => importBundle(b, bundle, { rename: "copy" }), /already exists/)
  assert.equal(importBundle(b, bundle, { rename: "copy", overwrite: true }).bot.name, "copy")
  const withSecrets = exportBundle(a, "src", { includeSecrets: true })
  assert.ok(JSON.stringify(withSecrets).includes("s3cret"))
})

test("bundle: file round trip and hostile bundles are rejected", () => {
  const a = mk(); const b = mk(); a.create({ name: "f1", instructions: "x" })
  const out = path.join(tmpdir(), "f1.json")
  exportToFile(a, "f1", out)
  assert.equal(importFromFile(b, out).bot.name, "f1")
  const base = { format: "openbot.bundle", version: 1, bot: { name: "evil", instructions: "x" }, files: {} }
  for (const rel of ["../escape.txt", "/etc/passwd", "skills/../../x", "notskills/a.md"]) {
    assert.throws(() => importBundle(b, { ...base, files: { [rel]: "x" } }), /unsafe|unsupported/, rel)
  }
  assert.throws(() => importBundle(b, { ...base, format: "nope" }), /not an openbot bundle/)
  assert.throws(() => importBundle(b, { ...base, version: 99 }), /newer/)
  assert.throws(() => importFromFile(b, "/nonexistent.json"), /cannot read/)
})

/* ---- host translation ---- */

const fakeAgents = (existing = []) => {
  const map = new Map(existing.map((id) => [id, { id, permissions: [{ action: "*", resource: "*", effect: "allow" }] }]))
  return {
    map,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    update(id, fn) { const a = map.get(id) ?? { id, permissions: [{ action: "*", resource: "*", effect: "allow" }] }; fn(a); map.set(id, a) },
    remove: (id) => map.delete(id),
  }
}

test("host: bots become agents (mode all, prompt, model, skill allowlist)", () => {
  const s = mk()
  const bot = s.create({ name: "scout", instructions: "FIND PARTNERS", description: "partner scout", model: "p/m#v", skills: ["web"] })
  fs.mkdirSync(path.join(s.skillsDir("scout"), "mine"), { recursive: true })
  fs.writeFileSync(path.join(s.skillsDir("scout"), "mine", "SKILL.md"), "---\nname: mine\n---\nx")
  const ed = fakeAgents(["build"]); const owned = newOwned()
  applyAgents(ed, s.list(), owned, { skillsDir: (n) => s.skillsDir(n) })
  const a = ed.map.get("scout")
  assert.equal(a.mode, "all"); assert.equal(a.hidden, false)
  assert.match(a.system, /FIND PARTNERS/); assert.match(a.system, new RegExp(bot.workdir.replace(/[/\\]/g, ".")))
  assert.deepEqual(a.model, { providerID: "p", id: "m", variant: "v" })
  const rules = a.permissions.filter((r) => r.action === "skill")
  assert.deepEqual(rules.map((r) => `${r.effect}:${r.resource}`), ["deny:*", "allow:web", "allow:mine", "allow:scout.mine"])
  assert.ok(owned.agents.has("scout"))
})

test("host: unrestricted skills add no rules; [] denies all; bot removal retracts agent", () => {
  const s = mk(); s.create({ name: "open", instructions: "x" }); s.create({ name: "closed", instructions: "x", skills: [] })
  const ed = fakeAgents(); const owned = newOwned(); const env = { skillsDir: (n) => s.skillsDir(n) }
  applyAgents(ed, s.list(), owned, env)
  assert.equal(ed.map.get("open").permissions.filter((r) => r.action === "skill").length, 0)
  assert.deepEqual(ed.map.get("closed").permissions.filter((r) => r.action === "skill").map((r) => r.effect), ["deny"])
  s.delete("open")
  applyAgents(ed, s.list(), owned, env)
  assert.ok(!ed.map.has("open")); assert.ok(ed.map.has("closed"))
})

test("host: never shadows a foreign agent, but keeps updating its own", () => {
  const s = mk(); s.create({ name: "mine", instructions: "v1" })
  const ed = fakeAgents(["mine"]); const owned = newOwned(); const logs = []
  applyAgents(ed, s.list(), owned, { skillsDir: (n) => s.skillsDir(n), log: (m) => logs.push(m) })
  assert.equal(ed.map.get("mine").system, undefined); assert.equal(logs.length, 1) // foreign "mine" untouched
  const ed2 = fakeAgents(); const own2 = newOwned(); const env = { skillsDir: (n) => s.skillsDir(n) }
  applyAgents(ed2, s.list(), own2, env)
  s.update("mine", { instructions: "v2" })
  applyAgents(ed2, s.list(), own2, env) // second reload: editor still holds our agent
  assert.match(ed2.map.get("mine").system, /v2/)
})

test("host: MCP and local skills register only where the bot works", () => {
  const s = mk(); const w = tmpdir()
  s.create({ name: "box", instructions: "x", workdir: w, mcps: { crm: { type: "local", command: ["node", "m.js"] } } })
  fs.mkdirSync(path.join(s.skillsDir("box"), "k"), { recursive: true })
  fs.writeFileSync(path.join(s.skillsDir("box"), "k", "SKILL.md"), "---\nname: k\ndescription: kk\n---\nbody")
  const mcp = { set: (n, c) => mcp.m.set(n, c), remove: (n) => mcp.m.delete(n), m: new Map() }
  const sk = { add: (x) => sk.m.set(x.id, x), remove: (i) => sk.m.delete(i), m: new Map() }
  const env = { skillsDir: (n) => s.skillsDir(n) }
  const owned = newOwned()
  applyWorkdirMcp("/somewhere/else", s.list(), mcp, owned); applyWorkdirSkills("/somewhere/else", s.list(), sk, owned, env)
  assert.equal(mcp.m.size, 0); assert.equal(sk.m.size, 0)
  applyWorkdirMcp(w, s.list(), mcp, owned); applyWorkdirSkills(w, s.list(), sk, owned, env)
  assert.deepEqual([...mcp.m.keys()], ["box-crm"])
  assert.equal(sk.m.get("box.k").description, "kk")
  s.update("box", { mcps: null })
  applyWorkdirMcp(w, s.list(), mcp, owned)
  assert.equal(mcp.m.size, 0)
})

test("host: parseModelRef and composeSystem", () => {
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude#fast"), { providerID: "openrouter", id: "anthropic/claude", variant: "fast" })
  assert.deepEqual(parseModelRef("a/b"), { providerID: "a", id: "b" })
  assert.match(composeSystem({ name: "n", instructions: "I", workdir: "/w", description: "D" }), /bot_update[\s\S]*## Your instructions\nI$/)
  assert.deepEqual(skillRules({ skills: undefined }, []), [])
})

/* ---- session I/O ---- */

test("session-io: extractReply picks the final assistant text after our message", () => {
  const msgs = [
    { id: "m1", type: "user", text: "old" }, { id: "m2", type: "assistant", content: [{ type: "text", text: "old reply" }] }, { id: "m3", type: "idle", outcome: "succeeded" },
    { id: "m4", type: "user", text: "new" },
    { id: "m5", type: "assistant", content: [{ type: "text", text: "thinking out loud" }, { type: "tool", name: "read" }] },
    { id: "m6", type: "assistant", content: [{ type: "text", text: "FINAL" }] },
  ]
  let r = extractReply(msgs, "m4"); assert.equal(r.done, false); assert.equal(r.text, "FINAL"); assert.equal(r.steps, 2)
  r = extractReply([...msgs, { id: "m7", type: "idle", outcome: "succeeded" }], "m4"); assert.equal(r.done, true)
  r = extractReply([...msgs.slice(0, 4), { id: "m7", type: "idle", outcome: "failed", error: { message: "boom" } }], "m4")
  assert.deepEqual([r.done, r.outcome, r.error, r.text], [true, "failed", "boom", ""])
})

test("session-io: summarizeMessages is compact", () => {
  const out = summarizeMessages([{ type: "user", text: "x".repeat(900) }, { type: "assistant", content: [{ type: "tool", name: "read" }, { type: "text", text: "ok" }] }, { type: "idle", outcome: "failed", error: { message: "e" } }], 5)
  assert.ok(out[0].text.length <= 401); assert.deepEqual(out[1].tools, ["read"]); assert.equal(out[2].error, "e")
})

function fakePort() {
  const sessions = new Map(); const log = []; let n = 0
  const port = {
    log, sessions,
    async create(i) { const s = { id: `ses_${++n}`, location: i.location, ...i }; sessions.set(s.id, s); log.push(["create", i]); return s },
    async get({ sessionID }) { const s = sessions.get(sessionID); if (!s) throw new Error("gone"); return s },
    async prompt(i) { const id = `m_${++n}`; log.push(["prompt", i]); const s = sessions.get(i.sessionID); s.msgs = [...(s.msgs ?? []), { id, type: "user", text: i.text }, { id: `m_${++n}`, type: "assistant", content: [{ type: "text", text: `echo:${i.text}` }] }, { id: `m_${++n}`, type: "idle", outcome: port.outcome ?? "succeeded", error: port.outcome === "failed" ? { message: "bad" } : undefined }]; return { id } },
    async wait() {}, async context({ sessionID }) { return sessions.get(sessionID).msgs ?? [] }, async interrupt() { log.push(["interrupt"]) },
  }
  return port
}

test("session-io: say creates the bot session in its workdir, reuses it, recreates when gone or workdir moved", async () => {
  const s = mk(); const bot = s.create({ name: "talk", instructions: "x" }); const port = fakePort()
  const r1 = await say(port, s, bot, "hello", { pollMs: 1 })
  assert.deepEqual([r1.status, r1.text], ["done", "echo:hello"])
  const created = port.log.find((l) => l[0] === "create")[1]
  assert.deepEqual([created.agent, created.location.directory, created.metadata.openbot.bot], ["talk", bot.workdir, "talk"])
  assert.equal(port.log.find((l) => l[0] === "prompt")[1].delivery, "queue")
  await say(port, s, bot, "again", { pollMs: 1 })
  assert.equal(port.log.filter((l) => l[0] === "create").length, 1, "conversation is continued")
  port.sessions.clear(); await say(port, s, bot, "after delete", { pollMs: 1 })
  assert.equal(port.log.filter((l) => l[0] === "create").length, 2, "recreated when session vanished")
  const moved = { ...bot, workdir: tmpdir() }; await say(port, s, moved, "moved", { pollMs: 1 })
  assert.equal(port.log.filter((l) => l[0] === "create").length, 3, "new session when workdir changed")
  await say(port, s, bot, "fresh", { pollMs: 1, fresh: true })
  assert.equal(port.log.filter((l) => l[0] === "create").length, 4)
  port.outcome = "failed"; const f = await say(port, s, bot, "x", { pollMs: 1 })
  assert.deepEqual([f.status, f.error], ["failed", "bad"])
  assert.equal((await say(port, s, bot, "bg", { wait: false })).status, "started")
})

test("session-io: timeout when the bot never goes idle", async () => {
  const s = mk(); const bot = s.create({ name: "slow", instructions: "x" }); const port = fakePort()
  port.prompt = async (i) => ({ id: "m_x" }); port.wait = () => new Promise((r) => setTimeout(r, 5))
  const r = await say(port, s, bot, "hi", { timeoutMs: 60, pollMs: 5 })
  assert.equal(r.status, "timeout")
})

/* ---- tools ---- */

const toolMap = (store, port) => Object.fromEntries(buildTools({ store, session: port, reload: async () => { toolMap.reloads = (toolMap.reloads ?? 0) + 1 } }).map((t) => [t.name, t]))
const human = { agent: "build", sessionID: "ses_h" }

test("tools: create -> get -> update(self) -> say -> history -> export/import -> delete", async () => {
  const s = mk(); const port = fakePort(); const t = toolMap(s, port)
  assert.ok(Object.values(t).every((x) => x.options.codemode === false && x.input.type === "object"))
  const c = await t.bot_create.execute({ name: "scout", instructions: "find", model: "a/b" }, human)
  assert.match(c.content, /created/); assert.ok(toolMap.reloads >= 1)
  assert.match((await t.bot_create.execute({ name: "scout", instructions: "x" }, human)).content, /already exists/)
  assert.match((await t.bot_get.execute({ name: "scout" }, human)).content, /"instructions": "find"/)
  const self = { agent: "scout", sessionID: "ses_b" }
  assert.match((await t.bot_update.execute({ instructions: "new role" }, self)).content, /updated/)
  assert.equal(s.get("scout").instructions, "new role")
  assert.match((await t.bot_get.execute({}, self)).content, /new role/)
  assert.match((await t.bot_update.execute({ name: "scout", model: "c/d" }, human)).content, /updated/)
  assert.match((await t.bot_update.execute({}, human)).content, /Error: Provide|Nothing/)
  const said = await t.bot_say.execute({ name: "scout", message: "ping" }, human)
  assert.equal(said.content, "echo:ping"); assert.equal(said.metadata.status, "done")
  const hist = JSON.parse((await t.bot_history.execute({ name: "scout" }, human)).content)
  assert.equal(hist.messages.at(-1).type, "idle")
  assert.match((await t.bot_get.execute({ name: "scout" }, human)).content, /ses_/)
  const file = path.join(tmpdir(), "x.json")
  assert.match((await t.bot_export.execute({ name: "scout", path: file }, human)).content, /Exported/)
  assert.match((await t.bot_import.execute({ path: file, rename: "scout2" }, human)).content, /Imported/)
  assert.deepEqual(s.list().map((b) => b.name), ["scout", "scout2"])
  assert.match((await t.bot_delete.execute({ name: "scout2", confirm: false }, human)).content, /confirm/)
  assert.match((await t.bot_delete.execute({ name: "scout2", confirm: true }, human)).content, /deleted/)
  assert.match((await t.bot_list.execute({}, human)).content, /scout/)
})

test("tools: safety rules between bots", async () => {
  const s = mk(); const port = fakePort(); const t = toolMap(s, port)
  s.create({ name: "alpha", instructions: "a" }); s.create({ name: "beta", instructions: "b" })
  const alpha = { agent: "alpha", sessionID: "s1" }
  assert.match((await t.bot_update.execute({ name: "beta", instructions: "hijack" }, alpha)).content, /not allowed/)
  assert.equal(s.get("beta").instructions, "b")
  for (const [tool, args] of [["bot_create", { name: "gamma", instructions: "x" }], ["bot_delete", { name: "beta", confirm: true }], ["bot_export", { name: "beta" }], ["bot_import", { path: "/x" }]]) {
    assert.match((await t[tool].execute(args, alpha)).content, /Bots cannot/, tool)
  }
  assert.match((await t.bot_say.execute({ name: "alpha", message: "me" }, alpha)).content, /itself/)
  assert.match((await t.bot_say.execute({ name: "ghost", message: "x" }, human)).content, /No bot named/)
  assert.match((await t.bot_say.execute({ name: "beta", message: "  " }, human)).content, /empty/)
  assert.match((await t.bot_get.execute({}, human)).content, /Provide "name"/)
})

test("tools: a bot waiting on another is not called back (cycle guard)", async () => {
  const s = mk(); const port = fakePort(); const t = toolMap(s, port)
  s.create({ name: "alpha", instructions: "a" }); s.create({ name: "beta", instructions: "b" })
  let release; const gate = new Promise((r) => (release = r))
  const origPrompt = port.prompt; port.prompt = async (i) => { await gate; return origPrompt(i) }
  const first = t.bot_say.execute({ name: "beta", message: "hi" }, { agent: "alpha", sessionID: "s1" }) // alpha now waits on beta
  await new Promise((r) => setTimeout(r, 20))
  const back = await t.bot_say.execute({ name: "alpha", message: "callback" }, { agent: "beta", sessionID: "s2" })
  assert.match(back.content, /cycle/)
  release(); assert.equal((await first).metadata.status, "done")
})
