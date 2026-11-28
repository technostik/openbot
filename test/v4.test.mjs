import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { BotStore, validateCapabilities } from "../dist/store.js"
import { makeService, createBot } from "../dist/service.js"
import { buildTools } from "../dist/tools.js"
import { applyAgents, applyWorkdirMcp, capabilityRules, composeSystem, describeCapabilities, newOwned, resolveCapabilities, skillRules } from "../dist/host.js"
import { renderAgentFile } from "../dist/materialize.js"
import { auditFile, countAudit, isAuditableTool, readAudit, recordAudit, rotateAudit } from "../dist/audit.js"
import { diagnose } from "../dist/debug/diagnose.js"
import { exportBundle, importBundle } from "../dist/bundle.js"
import { tmpdir } from "./helpers/tmp.mjs"

const mk = () => new BotStore(tmpdir())
const human = { agent: "build", sessionID: "ses_human" }

const fakeAgents = (existing = []) => {
  const map = new Map(existing.map((id) => [id, { id, permissions: [{ action: "*", resource: "*", effect: "allow" }] }]))
  return {
    map,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    update(id, fn) {
      const a = map.get(id) ?? { id, permissions: [{ action: "*", resource: "*", effect: "allow" }] }
      fn(a)
      map.set(id, a)
    },
    remove: (id) => map.delete(id),
  }
}

const session = {
  create: async () => ({}),
  get: async () => ({}),
  prompt: async () => ({}),
  move: async () => ({}),
  wait: async () => {},
  context: async () => [],
  interrupt: async () => {},
  list: async () => [],
}

const tools = (store) => Object.fromEntries(buildTools({ store, service: makeService(store), session, reload: async () => {} }).map((t) => [t.name, t]))

/* ---- validation and storage ---- */

test("capabilities: validation rejects bad presets and lists, keeps legacy keys", () => {
  assert.throws(() => validateCapabilities({ preset: "nope" }), /preset must be one of/)
  assert.throws(() => validateCapabilities({ tools: "read" }), /tools must be an array/)
  assert.throws(() => validateCapabilities({ denyTools: [""] }), /denyTools must be an array/)
  assert.throws(() => validateCapabilities(null), /must be an object/)
  assert.deepEqual(validateCapabilities({ preset: "minimal", tools: ["read", " read ", "edit"], denyTools: ["shell"], mcps: ["crm"], legacy: true }), {
    preset: "minimal",
    tools: ["read", "edit"],
    denyTools: ["shell"],
    mcps: ["crm"],
    legacy: true,
  })
})

test("store: capabilities round-trip, null clears, invalid bot.json is rejected", () => {
  const s = mk()
  s.create({ name: "cap", instructions: "x", capabilities: { preset: "minimal", tools: ["read"], mcps: [] } })
  assert.deepEqual(s.get("cap").capabilities, { preset: "minimal", tools: ["read"], mcps: [] })
  const raw = JSON.parse(fs.readFileSync(path.join(s.botDir("cap"), "bot.json"), "utf8"))
  assert.deepEqual(raw.capabilities, { preset: "minimal", tools: ["read"], mcps: [] })
  s.update("cap", { capabilities: null })
  assert.equal(s.get("cap").capabilities, undefined)
  fs.writeFileSync(path.join(s.botDir("cap"), "bot.json"), JSON.stringify({ name: "cap", schema: 1, capabilities: { preset: "bogus" } }))
  assert.throws(() => s.get("cap"), /preset must be one of/)
})

/* ---- resolution ---- */

test("capabilities: presets resolve to the documented baselines", () => {
  const base = { name: "p", instructions: "x", workdir: "/w", mcps: { crm: { type: "local", command: ["node"] }, mail: { type: "local", command: ["node"] } } }
  const std = resolveCapabilities({ ...base })
  assert.deepEqual([std.preset, std.toolMode, std.tools, std.skills, std.mcps], ["standard", "all", [], "bot", ["crm", "mail"]])
  const none = resolveCapabilities({ ...base, capabilities: { preset: "none" } })
  assert.deepEqual([none.preset, none.toolMode, none.tools, none.skills, none.mcps, none.deniedMcps], ["none", "list", [], "none", [], ["crm", "mail"]])
  const min = resolveCapabilities({ ...base, capabilities: { preset: "minimal" } })
  assert.deepEqual([min.toolMode, min.tools, min.skills, min.mcps], ["list", ["read", "glob", "grep"], "none", []])
  const full = resolveCapabilities({ ...base, capabilities: { preset: "full" } })
  assert.deepEqual([full.toolMode, full.skills, full.mcps], ["all", "all", ["crm", "mail"]])
})

test("capabilities: explicit lists override the preset; mcps accept local or host names", () => {
  const bot = { name: "scout", instructions: "x", workdir: "/w", mcps: { crm: { type: "local", command: ["node"] }, mail: { type: "local", command: ["node"] } } }
  const r = resolveCapabilities({ ...bot, capabilities: { preset: "standard", tools: ["read", "edit"], denyTools: ["edit"], mcps: ["crm", "scout-mail", "ghost"] } })
  assert.deepEqual([r.toolMode, r.tools, r.denyTools, r.mcps, r.deniedMcps, r.unknownMcps], ["list", ["read", "edit"], ["edit"], ["crm", "mail"], [], ["ghost"]])
  const all = resolveCapabilities({ ...bot, capabilities: { tools: ["*"], mcps: ["*"] } })
  assert.deepEqual([all.toolMode, all.tools, all.mcps], ["all", [], ["crm", "mail"]])
})

/* ---- permission rules ---- */

test("capabilities: rules deny everything first, keep bot_* and let denyTools win", () => {
  const bot = { name: "rb", instructions: "x", workdir: "/w", skills: ["web"] }
  const std = capabilityRules(bot, [])
  assert.deepEqual(std, [
    { action: "skill", resource: "*", effect: "deny" },
    { action: "skill", resource: "web", effect: "allow" },
  ])
  const none = capabilityRules({ ...bot, capabilities: { preset: "none" } }, [])
  assert.deepEqual(none.slice(0, 2), [
    { action: "*", resource: "*", effect: "deny" },
    { action: "bot_*", resource: "*", effect: "allow" },
  ])
  assert.deepEqual(none.at(-1), { action: "skill", resource: "*", effect: "deny" })
  const minimal = capabilityRules({ ...bot, capabilities: { preset: "minimal" } }, [])
  assert.deepEqual(minimal.map((r) => `${r.effect}:${r.action}`), ["deny:*", "allow:read", "allow:glob", "allow:grep", "allow:bot_*", "deny:skill"])
  const denied = capabilityRules({ ...bot, capabilities: { tools: ["read", "edit"], denyTools: ["edit"] } }, [])
  assert.deepEqual(denied.at(-1), { action: "edit", resource: "*", effect: "deny" })
  assert.deepEqual(skillRules({ skills: undefined }, []), [], "skillRules is unchanged")
})

test("capabilities: MCP rules use the host action name and narrow the allowlist", () => {
  const bot = {
    name: "scout",
    instructions: "x",
    workdir: "/w",
    mcps: { crm: { type: "local", command: ["node"] }, mail: { type: "local", command: ["node"] } },
    capabilities: { mcps: ["crm"] },
  }
  const rules = capabilityRules(bot, [])
  assert.ok(rules.some((r) => r.action === "scout-mail_*" && r.effect === "deny"))
  assert.ok(rules.some((r) => r.action === "scout-crm_*" && r.effect === "allow"))
  assert.ok(!rules.some((r) => r.action.includes("mcp__")))
  const none = capabilityRules({ ...bot, capabilities: { preset: "none", mcps: ["crm"] } }, [])
  assert.ok(none.some((r) => r.action === "scout-mail_*" && r.effect === "deny"))
  assert.ok(none.some((r) => r.action === "scout-crm_*" && r.effect === "allow"))
})

/* ---- injection ---- */

test("prompt: the Permissions section tells the model what it may call", () => {
  const none = composeSystem({ name: "n", instructions: "I", workdir: "/w", capabilities: { preset: "none" } })
  assert.match(none, /## Permissions\nPreset: none\nTools: bot_\* \(anything else is denied\)/)
  assert.match(none, /MCP servers: none/)
  assert.match(none, /Skills: none/)
  assert.match(none, /## Your instructions\nI$/)
  const std = composeSystem({ name: "n", instructions: "I", workdir: "/w" })
  assert.match(std, /Preset: standard\nTools: all/)
})

test("materialize: capability rules reach the native agent file", () => {
  const s = mk()
  const bot = s.create({ name: "mat", instructions: "x", capabilities: { preset: "minimal" } })
  const out = renderAgentFile(bot, { skillsDir: (n) => s.skillsDir(n) })
  assert.match(out, /action: "\*", resource: "\*", effect: "deny"/)
  assert.match(out, /action: "read", resource: "\*", effect: "allow"/)
  assert.match(out, /action: "bot_\*", resource: "\*", effect: "allow"/)
  assert.match(out, /## Permissions/)
})

test("host: applyAgents injects capability rules; applyWorkdirMcp registers only allowed servers", () => {
  const s = mk()
  const w = tmpdir()
  s.create({
    name: "box",
    instructions: "x",
    workdir: w,
    mcps: { crm: { type: "local", command: ["node"] }, mail: { type: "local", command: ["node"] } },
    capabilities: { mcps: ["crm"] },
  })
  const ed = fakeAgents()
  const owned = newOwned()
  applyAgents(ed, s.list(), owned, { skillsDir: (n) => s.skillsDir(n) })
  const rules = ed.map.get("box").permissions
  assert.ok(rules.some((r) => r.action === "box-mail_*" && r.effect === "deny"))
  assert.ok(rules.some((r) => r.action === "box-crm_*" && r.effect === "allow"))
  const mcp = {
    m: new Map(),
    set(n, c) {
      this.m.set(n, c)
    },
    remove(n) {
      this.m.delete(n)
    },
  }
  applyWorkdirMcp(w, s.list(), mcp, owned)
  assert.deepEqual([...mcp.m.keys()], ["box-crm"])
})

/* ---- tools ---- */

test("tools: bot_create/bot_update accept capabilities; bot_get shows effective permissions", async () => {
  const s = mk()
  const t = tools(s)
  const created = await t.bot_create.execute({ name: "tc", instructions: "x", capabilities: { preset: "none" } }, human)
  assert.match(created.content, /created/)
  assert.deepEqual(s.get("tc").capabilities, { preset: "none" })
  const bad = await t.bot_update.execute({ name: "tc", capabilities: { preset: "bogus" } }, human)
  assert.match(bad.content, /preset must be one of/)
  const got = JSON.parse((await t.bot_get.execute({ name: "tc" }, human)).content)
  assert.equal(got.permissions.preset, "none")
  assert.deepEqual(got.permissions.tools, ["bot_*"])
  const escalated = await t.bot_update.execute({ capabilities: { preset: "full" } }, { agent: "tc", sessionID: "ses_tc" })
  assert.match(escalated.content, /cannot change permissions/)
  assert.equal(s.get("tc").capabilities.preset, "none")
})

test("bundle: capabilities survive export/import", () => {
  const s = mk()
  s.create({ name: "bu", instructions: "x", capabilities: { preset: "minimal", tools: ["read"], mcps: [] } })
  const bundle = exportBundle(s, "bu")
  assert.deepEqual(bundle.bot.capabilities, { preset: "minimal", tools: ["read"], mcps: [] })
  const t = mk()
  const { bot } = importBundle(t, bundle)
  assert.deepEqual(bot.capabilities, { preset: "minimal", tools: ["read"], mcps: [] })
})

/* ---- audit ---- */

test("audit: records, reads newest first, rotates, and only audits sensitive tools", async () => {
  const s = mk()
  s.create({ name: "au", instructions: "x" })
  await recordAudit(s, "au", { tool: "au-crm_search", sessionID: "ses_1" })
  await recordAudit(s, "au", { tool: "bot_say", target: "other", detail: "called by a human agent" })
  assert.equal(countAudit(s, "au"), 2)
  const rows = readAudit(s, "au", 10)
  assert.deepEqual(rows.map((r) => r.tool), ["bot_say", "au-crm_search"])
  assert.equal(rows[0].target, "other")
  const file = auditFile(s, "au")
  fs.writeFileSync(file, Array.from({ length: 20 }, (_, i) => JSON.stringify({ bot: "au", at: new Date().toISOString(), tool: "t" + i })).join("\n") + "\n")
  await rotateAudit(file, 5)
  assert.equal(countAudit(s, "au"), 5)
  assert.equal(readAudit(s, "au", 5)[0].tool, "t19")
  assert.equal(isAuditableTool("read"), false)
  assert.equal(isAuditableTool("bot_say"), false)
  assert.equal(isAuditableTool("au-crm_search"), true)
  assert.equal(isAuditableTool("mcp_call"), true)
})

test("diagnose: reports effective permissions, denied MCP servers and the audit log", async () => {
  const s = mk()
  s.create({
    name: "dg",
    instructions: "x",
    mcps: { crm: { type: "local", command: [process.execPath] }, mail: { type: "local", command: [process.execPath] } },
    capabilities: { preset: "none", mcps: ["crm"] },
  })
  await recordAudit(s, "dg", { tool: "dg-crm_search" })
  const env = {
    store: s,
    pluginVersion: "x",
    materializeEnabled: false,
    pluginLoadedAt: async () => true,
    agentsAt: async () => ["dg"],
    models: async () => [],
    defaultModel: async () => "p/m",
    skillsAt: async () => [],
    mcpAt: async () => [],
    sessionContext: async () => [],
  }
  const r = await diagnose(env, "dg")
  const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]))
  assert.match(byId.permissions.title, /preset none/)
  assert.match(byId.permissions.detail, /MCP: dg-crm/)
  assert.match(byId["mcp-denied:mail"].title, /not allowed/)
  assert.ok(!byId["mcp:mail"], "a denied server is not checked as missing")
  assert.match(byId.audit.title, /Audit log: 1 entry/)
})

/* ---- describe ---- */

test("describeCapabilities: compact view used by prompts, tools and the TUI", () => {
  const s = mk()
  const bot = s.create({ name: "ds", instructions: "x", skills: ["web"], mcps: { crm: { type: "local", command: ["node"] } } })
  const d = describeCapabilities(bot)
  assert.equal(d.preset, "standard")
  assert.equal(d.tools, "*")
  assert.deepEqual(d.mcpHosts, ["ds-crm"])
  assert.deepEqual(d.skills, ["web"])
  assert.deepEqual(describeCapabilities({ ...bot, capabilities: { preset: "none" } }).skills, "none")
  assert.deepEqual(describeCapabilities({ ...bot, capabilities: { preset: "full" } }).skills, "*")
})

/* ---- legacy compatibility ---- */

test("compatibility: a bot without capabilities keeps the old skill rules and no tool rules", () => {
  const s = mk()
  const bot = s.create({ name: "old", instructions: "x", skills: ["web"] })
  assert.deepEqual(capabilityRules(bot, []), [
    { action: "skill", resource: "*", effect: "deny" },
    { action: "skill", resource: "web", effect: "allow" },
  ])
  const ed = fakeAgents()
  const owned = newOwned()
  applyAgents(ed, s.list(), owned, { skillsDir: (n) => s.skillsDir(n) })
  const rules = ed.map.get("old").permissions.filter((r) => r.action !== "*")
  assert.deepEqual(rules.map((r) => `${r.action}:${r.effect}`), ["skill:deny", "skill:allow"])
})
