// End-to-end test: the real opencode server (2.4.x) + this plugin + a scripted mock LLM. No network needed.
//   OPENCODE_BIN=/path/to/opencode npm run test:e2e      (or: npm i --no-save @opencode/cli@2.4.1)
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { startMock } from "../helpers/mock-llm.mjs"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const bin = process.env.OPENCODE_BIN ?? path.join(repo, "node_modules/.bin/opencode")
if (!fs.existsSync(bin)) { console.error(`opencode binary not found at ${bin}. Set OPENCODE_BIN or run: npm i --no-save @opencode/cli@2.4.1`); process.exit(2) }

const T = path.join(repo, ".tmp-e2e", String(Date.now()))
const dirs = { project: `${T}/project`, scout: `${T}/work-scout`, box: `${T}/work-box`, xdg: `${T}/xdg`, home: `${T}/openbot` }
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
fs.mkdirSync(`${dirs.xdg}/config/opencode`, { recursive: true })

const MOCK_PORT = 18099, SERVER_PORT = 18199
const mock = await startMock(MOCK_PORT)
fs.writeFileSync(`${dirs.xdg}/config/opencode/opencode.json`, JSON.stringify({
  plugins: [repo],
  providers: { mock: { name: "Mock", package: "@ai-sdk/openai-compatible", settings: { baseURL: mock.url, apiKey: "x" }, models: { "mock-1": { name: "Mock 1" } } } },
}, null, 2))

const env = { ...process.env, XDG_CONFIG_HOME: `${dirs.xdg}/config`, XDG_DATA_HOME: `${dirs.xdg}/data`, XDG_CACHE_HOME: `${dirs.xdg}/cache`, XDG_STATE_HOME: `${dirs.xdg}/state`, OPENBOT_HOME: dirs.home }
const serverArgs = ["serve", "--port", String(SERVER_PORT), "--hostname", "127.0.0.1", ...(process.env.E2E_DEBUG ? ["--print-logs", "--log-level", "info"] : [])]
const server = spawn(bin, serverArgs, { env, stdio: ["pipe", "pipe", "pipe"] })
let serverOut = ""
server.stdout.on("data", (d) => (serverOut += d)); server.stderr.on("data", (d) => (serverOut += d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 10000, step = 200) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return undefined; await sleep(step) } }
const password = await until(() => /server password (\S+)/.exec(serverOut)?.[1], 30000)
if (!password) { console.error("server did not start:\n" + serverOut); process.exit(2) }
const c = OpenCode.make({ baseUrl: `http://127.0.0.1:${SERVER_PORT}`, headers: { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") } })

let pass = 0, fail = 0
function check(name, ok, detail) { if (ok) { pass++; console.log("  ok   " + name) } else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700) : "")) } }
const scoutSays = (re) => (r) => r.system.includes('You are "scout"') && (!re || re.test(r.lastText))
const toolResultSeen = () => mock.requests.filter((r) => r.afterTool).at(-1)?.lastText ?? ""
const botJson = (n) => JSON.parse(fs.readFileSync(`${dirs.home}/bots/${n}/bot.json`, "utf8"))
const agents = async (dir) => { const o = await c.agent.list({ location: { directory: dir } }); return o.data ?? o }

async function ask(dir, text, { agents: ag, agent = "build", timeout = 60000 } = {}) {
  const s = await c.session.create({ agent, model: { providerID: "mock", id: "mock-1" }, location: { directory: dir } })
  const before = mock.requests.length
  await c.session.prompt({ sessionID: s.id, text, ...(ag ? { agents: ag } : {}) })
  await until(async () => { const m = await c.session.context({ sessionID: s.id }); return m.some((x) => x.type === "idle") }, timeout, 300)
  return { id: s.id, before }
}

try {
  console.log("\n[1] create a bot through the bot_create tool")
  mock.queue.push({ tool: "bot_create", args: { name: "scout", instructions: "You find business partners. Keep a CRM in crm.md.", description: "Partner scout", model: "mock/mock-1", workdir: dirs.scout } })
  await ask(dirs.project, "please create a bot")
  const tools0 = mock.requests.find((r) => !r.aux)?.tools ?? []
  check("bot_* tools are exposed natively to the model", ["bot_list", "bot_get", "bot_create", "bot_update", "bot_delete", "bot_say", "bot_history", "bot_export", "bot_import"].every((t) => tools0.includes(t)), tools0)
  check("bot.json written with the master prompt and workdir", fs.existsSync(`${dirs.home}/bots/scout/bot.json`) && botJson("scout").instructions.includes("CRM") && botJson("scout").workdir === dirs.scout, toolResultSeen())
  check("tool reported success to the model", /created/.test(toolResultSeen()), toolResultSeen())
  const a1 = await until(async () => (await agents(dirs.project)).find((a) => a.id === "scout"))
  check("bot is registered as an agent (visible to @ and Tab)", !!a1, (await agents(dirs.project)).map((a) => a.id))
  check("agent carries the master prompt, mode all, model", a1?.system?.includes("find business partners") && a1.mode === "all" && a1.model?.id === "mock-1", a1)
  const a1w = await until(async () => (await agents(dirs.scout)).find((a) => a.id === "scout"))
  check("the bot's own working directory instance also knows the bot", !!a1w)

  console.log("\n[2] talk to the bot (bot_say) — its own persistent session in its workdir")
  mock.queue.push({ tool: "bot_say", args: { name: "scout", message: "hello scout, who are you?" } })
  mock.queue.push({ when: scoutSays(/who are you/), text: "I am scout, ready to hunt partners." })
  await ask(dirs.project, "talk to scout")
  check("bot's answer came back through the tool", /I am scout, ready to hunt partners/.test(toolResultSeen()), toolResultSeen())
  const scoutReq = mock.requests.filter((r) => r.system.includes('You are "scout"')).at(-1)
  check("bot LLM call uses the master prompt", scoutReq?.system.includes("Keep a CRM in crm.md"))
  check("bot LLM call knows its working directory", scoutReq?.system.includes(dirs.scout), scoutReq?.system.slice(0, 300))
  const state = JSON.parse(fs.readFileSync(`${dirs.home}/bots/scout/state/session.json`, "utf8"))
  const sess = await c.session.get({ sessionID: state.sessionID })
  check("bot session lives in the bot's workdir with the bot's agent", sess.location?.directory === dirs.scout && sess.agent === "scout", sess)

  console.log("\n[3] the conversation is continued (bot remembers)")
  mock.queue.push({ tool: "bot_say", args: { name: "scout", message: "second message" } })
  mock.queue.push({ when: scoutSays(/second message/), text: "Noted." })
  await ask(dirs.project, "talk again")
  const scoutReq2 = mock.requests.filter((r) => r.system.includes('You are "scout"')).at(-1)
  check("same session reused, earlier exchange is in context", JSON.stringify(scoutReq2.messages).includes("hello scout, who are you?"), scoutReq2.messages.length)
  check("state still points to the same session", JSON.parse(fs.readFileSync(`${dirs.home}/bots/scout/state/session.json`, "utf8")).sessionID === state.sessionID)

  console.log("\n[4] @scout in the user's prompt is routed to the bot")
  mock.queue.push({ when: (r) => r.lastText.includes("[openbot]"), tool: "bot_say", args: { name: "scout", message: "status report please" } })
  mock.queue.push({ when: scoutSays(/status report/), text: "Status: all good." })
  await ask(dirs.project, "@scout status report please", { agents: [{ name: "scout", mention: { start: 0, end: 6, text: "@scout" } }] })
  const mainReq = mock.requests.find((r) => !r.aux && !r.afterTool && r.lastText.includes("[openbot]"))
  check("the user's own agent received the delegation instruction (hook rewrote the prompt)", !!mainReq && /bot_say/.test(mainReq.lastText) && /status report please/.test(mainReq.lastText), mock.requests.filter((r) => !r.aux).map((r) => r.lastText.slice(0, 80)).slice(-4))
  check("bot's reply relayed", /Status: all good/.test(toolResultSeen()), toolResultSeen())

  console.log("\n[5] a bot reconfigures itself; it cannot touch other bots")
  fs.mkdirSync(`${dirs.home}/bots/other`, { recursive: true })
  fs.writeFileSync(`${dirs.home}/bots/other/bot.json`, JSON.stringify({ name: "other", instructions: "I am hand-written.", description: "made by hand" }))
  const hand = await until(async () => (await agents(dirs.project)).find((a) => a.id === "other"), 15000)
  check("a hand-written bot.json is picked up without restart", !!hand && /hand-written/.test(hand.system), (await agents(dirs.project)).map((a) => a.id))
  mock.queue.push({ tool: "bot_say", args: { name: "scout", message: "please change your role" } })
  mock.queue.push({ when: scoutSays(/change your role/), tool: "bot_update", args: { instructions: "You are now a CRM keeper." } })
  await ask(dirs.project, "reconfigure scout via itself")
  check("bot_update (self) wrote the new instructions", botJson("scout").instructions === "You are now a CRM keeper.", botJson("scout").instructions)
  const a5 = await until(async () => (await agents(dirs.project)).find((a) => a.id === "scout" && a.system.includes("CRM keeper")), 15000)
  check("the live agent reflects the change without restart", !!a5)
  mock.queue.push({ tool: "bot_say", args: { name: "scout", message: "try to hijack other" } })
  mock.queue.push({ when: scoutSays(/hijack/), tool: "bot_update", args: { name: "other", instructions: "pwned" } })
  await ask(dirs.project, "hijack attempt")
  const denied = mock.requests.filter((r) => r.afterTool && r.system.includes('You are "scout"')).at(-1)?.lastText ?? ""
  check("a bot cannot modify another bot", /not allowed/.test(denied) && botJson("other").instructions === "I am hand-written.", denied)

  console.log("\n[6] skills allowlist, local skills and MCP packaged with a bot")
  fs.mkdirSync(`${dirs.home}/bots/box/skills/hello`, { recursive: true })
  if (!process.env.E2E_NO_LOCAL) fs.writeFileSync(`${dirs.home}/bots/box/skills/hello/SKILL.md`, "---\nname: hello\ndescription: greets people politely\n---\nSay hello politely.\n")
  fs.writeFileSync(`${dirs.home}/bots/box/bot.json`, JSON.stringify({ name: "box", instructions: "You are box.", model: "mock/mock-1", workdir: dirs.box, ...(process.env.E2E_NO_ALLOW ? {} : { skills: ["hello"] }), ...(process.env.E2E_NO_MCP ? {} : { mcps: { crm: { type: "local", command: ["node", path.join(repo, "test/helpers/mini-mcp.mjs")] } } }) }))
  const boxAgent = await until(async () => (await agents(dirs.box)).find((a) => a.id === "box"), 15000)
  const skillRules = (boxAgent?.permissions ?? []).filter((p) => p.action === "skill").map((p) => `${p.effect}:${p.resource}`)
  check("skills allowlist becomes permission rules", skillRules[0] === "deny:*" && skillRules.includes("allow:hello"), skillRules)
  const skillList = async (dir) => { const o = await c.skill.list({ location: { directory: dir } }); return (o.data ?? o).map((x) => x.name ?? x.id) }
  check("bot-local skill is registered in the bot's workdir instance (and only there)", (await until(async () => (await skillList(dirs.box)).includes("hello"), 15000)) && !(await skillList(dirs.project)).includes("hello"), { box: await skillList(dirs.box), project: await skillList(dirs.project) })
  let boxReq
  for (let i = 0; i < 4 && !/box-crm/.test(boxReq?.system ?? ""); i++) {
    mock.queue.push({ tool: "bot_say", args: { name: "box", message: `use your tools ${i}`, ...(process.env.E2E_NO_FRESH ? {} : { new_conversation: true }) } })
    mock.queue.push({ when: (r) => r.system.includes('You are "box"'), text: "ok" })
    const askRes = await ask(dirs.project, "talk to box", { timeout: 20000 })
    if (process.env.E2E_DEBUG) console.log("   [debug] main session tail:", JSON.stringify((await c.session.context({ sessionID: askRes.id })).slice(-3)).slice(0, 1500))
    boxReq = mock.requests.filter((r) => r.system.includes('You are "box"')).at(-1)
    if (process.env.E2E_DEBUG) console.log("   [debug] queue left:", mock.queue.length, mock.requests.slice(-4).map((r) => ({ aux: r.aux, afterTool: r.afterTool, last: r.lastText.slice(0, 70), step: r.step && (r.step.tool ?? r.step.text) })))
    if (!/box-crm/.test(boxReq?.system ?? "")) await sleep(1500)
  }
  if (process.env.E2E_DUMP) fs.writeFileSync(process.env.E2E_DUMP, JSON.stringify(boxReq, null, 2))
  if (process.env.E2E_DEBUG) console.log("   [debug] server log (box/error lines):\n" + serverOut.split("\n").filter((l) => /box|ERROR|WARN|skill/i.test(l)).slice(-25).map((l) => "     " + l.slice(0, 330)).join("\n"))
  check("bot's MCP server tools reach the bot's model", /box-crm/.test(boxReq?.system ?? "") && /echo/.test(boxReq?.system ?? ""), { tools: boxReq?.tools, lastToolResult: toolResultSeen() })
  const skillTool = JSON.stringify((boxReq?.toolDefs ?? []).find((t) => t.function?.name === "skill") ?? {})
  check("bot-local skill is offered to the bot's model (via the skill tool)", /greets people politely/.test(skillTool + (boxReq?.system ?? "")), { skillTool: skillTool.slice(0, 500) })

  console.log("\n[7] export, import under another name, delete")
  const bundle = `${T}/scout.openbot.json`
  mock.queue.push({ tool: "bot_export", args: { name: "scout", path: bundle } })
  await ask(dirs.project, "export scout")
  check("bundle written, no workdir inside", fs.existsSync(bundle) && !("workdir" in JSON.parse(fs.readFileSync(bundle, "utf8")).bot))
  mock.queue.push({ tool: "bot_import", args: { path: bundle, rename: "scout2" } })
  await ask(dirs.project, "import scout2")
  check("imported bot exists with its own default workspace", fs.existsSync(`${dirs.home}/bots/scout2/bot.json`) && botJson("scout2").workdir === `${dirs.home}/bots/scout2/workspace`, toolResultSeen())
  check("imported bot is a live agent", !!(await until(async () => (await agents(dirs.project)).find((a) => a.id === "scout2"), 15000)))
  mock.queue.push({ tool: "bot_delete", args: { name: "scout2", confirm: true } })
  await ask(dirs.project, "delete scout2")
  check("deleted bot is gone from disk and from the agent list", !fs.existsSync(`${dirs.home}/bots/scout2`) && !(await until(async () => !(await agents(dirs.project)).find((a) => a.id === "scout2"), 15000) === false), toolResultSeen())

  console.log("\n[8] inspect")
  mock.queue.push({ tool: "bot_history", args: { name: "scout", limit: 4 } })
  await ask(dirs.project, "history of scout")
  check("bot_history returns recent messages", /"messages"/.test(toolResultSeen()) && /idle|assistant/.test(toolResultSeen()), toolResultSeen())
  mock.queue.push({ tool: "bot_get", args: { name: "scout" } })
  await ask(dirs.project, "get scout")
  check("bot_get shows config and conversation stats", /"instructions"/.test(toolResultSeen()) && /"tokens"/.test(toolResultSeen()), toolResultSeen())
} catch (e) {
  fail++; console.log("  CRASH", e?.stack ?? e)
} finally {
  server.kill("SIGTERM"); await mock.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) { console.log("\n--- server output (tail) ---\n" + serverOut.split("\n").slice(-25).join("\n")) }
  process.exit(fail ? 1 : 0)
}
