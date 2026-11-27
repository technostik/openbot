// E2E (global install): automations, status gating, state, history, alerts, native questions. Real host + mock LLM.
import fs from "node:fs"
import path from "node:path"
import { startEnv, until, sleep } from "./harness.mjs"
import { BotStore } from "../../dist/store.js"
import { makeService, createBot } from "../../dist/service.js"

const E = await startEnv({ name: "life", mockPort: 18092, serverPort: 18192, pluginScope: "global", env: { OPENBOT_DEBUG: "1" } })
const { dirs, mock, c, check, home, ask } = E
const store = new BotStore(home)
const botSays = (re) => (r) => r.system.includes('You are "lifebot"') && re.test(r.lastText)
const unwrap = (o) => (Array.isArray(o) ? o : o?.data ?? [])
const nativeAutos = async () => unwrap(await c.experimental.automation.list({ location: { directory: dirs.project } })).filter((a) => a.name.startsWith("openbot:lifebot:"))
const botJson = () => JSON.parse(fs.readFileSync(`${home}/bots/lifebot/bot.json`, "utf8"))
const viaMain = async (mark, botMsg, botStep) => { // human -> main agent -> bot_say -> bot does botStep
  mock.queue.push({ when: (r) => r.lastText.includes(mark), tool: "bot_say", args: { name: "lifebot", message: botMsg } })
  if (botStep) mock.queue.push({ when: botSays(new RegExp(botMsg)), ...botStep })
  return ask(dirs.project, mark)
}
try {
  console.log("\n[L1] a bot with automations: native automations are created and match bot.json")
  createBot(makeService(store), { name: "lifebot", instructions: "You are lifebot.", model: "mock/mock-1", workdir: dirs.scout, description: "Find podcasts",
    automations: [{ id: "scan", every: "1 minute", prompt: "focus on podcasts" }, { id: "weekly", cron: "0 9 * * 1", tz: "Europe/Paris" }, { id: "parked", every: "1 day", enabled: false }] })
  await c.agent.list({ location: { directory: dirs.project } }) // loads the plugin instance
  const autos = await until(async () => { const a = await nativeAutos(); return a.length >= 2 ? a : undefined }, 25000)
  if (!autos || autos.length !== 2) console.log("   [debug] native list now:", JSON.stringify((await nativeAutos()).map((a) => ({ n: a.name, s: a.status }))))
  check("enabled automations exist natively (disabled one does not)", !!autos && autos.map((a) => a.name).sort().join() === "openbot:lifebot:scan,openbot:lifebot:weekly", autos?.map((a) => a.name))
  const scan = autos?.find((a) => a.name.endsWith(":scan"))
  const authSession = store.readThreads("lifebot").auto?.sessionID
  check("each prompts the bot's own automation conversation, with the standard routine and the custom text", scan?.action?.to?.session === authSession && /Scheduled run/.test(scan?.action?.prompt) && /focus on podcasts/.test(scan.action.prompt) && /bot_state/.test(scan.action.prompt), scan?.action)
  check("cron trigger kept its timezone", autos?.find((a) => a.name.endsWith(":weekly"))?.trigger?.cron === "0 9 * * 1")
  check("state.md was created from the template", /## Todo/.test(store.readStateFile("lifebot")) && /Find podcasts/.test(store.readStateFile("lifebot")))

  console.log("\n[L2] status gates the automations: stopped / active / finished / hand edit")
  mock.queue.push({ when: (r) => r.lastText.includes("MARK-stop"), tool: "bot_status", args: { name: "lifebot", status: "stopped", note: "vacation" } }); await ask(dirs.project, "MARK-stop")
  check("stopped: status saved with its note", botJson().status === "stopped" && botJson().statusNote === "vacation")
  check("stopped: native automations are removed (ignored)", !!(await until(async () => (await nativeAutos()).length === 0, 20000)), (await nativeAutos()).map((a) => a.name))
  mock.queue.push({ when: (r) => r.lastText.includes("MARK-go"), tool: "bot_status", args: { name: "lifebot", status: "active" } }); await ask(dirs.project, "MARK-go")
  check("active again: automations come back", !!(await until(async () => (await nativeAutos()).length === 2, 20000)))
  fs.writeFileSync(`${home}/bots/lifebot/bot.json`, JSON.stringify({ ...botJson(), status: "stopped" }, null, 2))
  check("hand-editing bot.json to stopped removes them within seconds", !!(await until(async () => (await nativeAutos()).length === 0, 20000)))
  fs.writeFileSync(`${home}/bots/lifebot/bot.json`, JSON.stringify({ ...botJson(), status: "active" }, null, 2))
  check("...and back to active restores them", !!(await until(async () => (await nativeAutos()).length === 2, 20000)))

  console.log("\n[L3] a scheduled run really fires (no TUI open): the bot sees its state, updates it, and it is recorded")
  store.writeStateFile("lifebot", "# State\n## Goal\nFind podcasts\n## Todo\n- [ ] contact Ada Lovelace\n")
  mock.queue.push({ when: (r) => r.system.includes('You are "lifebot"') && /automation "scan"/.test(r.lastText), tool: "bot_state", args: { op: "append", text: "- [x] scan done at tick" } })
  const fired = await until(() => mock.requests.find((r) => r.system.includes('You are "lifebot"') && /automation "scan"/.test(r.lastText)), 100000, 1000)
  check("the automation fired on schedule into the bot's session", !!fired)
  check("the prompt carried the routine + custom instruction", /focus on podcasts/.test(fired?.lastText ?? "") && /bot_state/.test(fired?.lastText ?? ""))
  check("the bot sees its current state in its system prompt (injected every turn)", /## Your current state/.test(fired?.system ?? "") && /contact Ada Lovelace/.test(fired?.system ?? "") && /Lifecycle status: active/.test(fired?.system ?? ""), (fired?.system ?? "").slice(-500))
  check("the bot updated state.md through bot_state", !!(await until(async () => /scan done at tick/.test(store.readStateFile("lifebot")), 20000)))
  const rec = await until(async () => { const f = path.join(home, "bots/lifebot/history"); return fs.existsSync(f) && fs.readdirSync(f).some((n) => n.endsWith(".jsonl")) ? fs.readdirSync(f) : undefined }, 30000)
  const idx = fs.existsSync(`${home}/bots/lifebot/history/index.json`) ? JSON.parse(fs.readFileSync(`${home}/bots/lifebot/history/index.json`, "utf8")) : {}
  check("the run was recorded in history/ (jsonl + index)", !!rec && Object.values(idx).some((m) => m.count >= 2), idx)
  const autoRec = fs.readFileSync(`${home}/bots/lifebot/history/${authSession}.jsonl`, "utf8")
  check("the record contains the automation prompt and the bot's tool call", /automation \\"scan\\"/.test(autoRec) && /bot_state/.test(autoRec))

  console.log("\n[L4] the bot alerts the user (bot_notify) and asks a question (native question tool)")
  await viaMain("MARK-notify", "BOTMARK-notify", { tool: "bot_notify", args: { message: "Found 3 podcast hosts, need your pick", level: "attention", title: "Pick one" } })
  const inbox = await until(() => { try { const i = JSON.parse(fs.readFileSync(`${home}/bots/lifebot/inbox.json`, "utf8")).items; return i.length ? i : undefined } catch { return undefined } }, 40000)
  check("the alert is in the bot's inbox with its level, title and conversation", inbox?.[0]?.level === "attention" && inbox[0].title === "Pick one" && /^ses_/.test(inbox[0].sessionID ?? "") && inbox[0].status === "open", inbox)
  await viaMain("MARK-ask", "BOTMARK-ask", { tool: "question", args: { questions: [{ question: "Which podcast first?", header: "Pick", options: [{ label: "Alpha", description: "first" }, { label: "Beta", description: "second" }] }] } })
  const form = await until(async () => ((await c.form.list({ location: { directory: dirs.scout } })).data ?? []).find((f) => /Which podcast first/.test(JSON.stringify(f))), 40000)
  check("a pending question appears (native form) for the bot's session", !!form && form.fields?.[0]?.options?.length === 2, form)
  if (form) await c.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer: { q0: "Beta" } })
  check("answering it lets the bot continue with the answer", !!(await until(() => mock.requests.find((r) => r.afterTool && r.system.includes('You are "lifebot"') && /Beta/.test(r.lastText)), 40000)))

  console.log("\n[L5] finished: the bot ends its own goal; automations are ignored; only the user can reopen")
  await viaMain("MARK-finish", "BOTMARK-finish", { tool: "bot_status", args: { status: "finished", note: "all contacted" } })
  check("the bot set itself to finished (with its note)", !!(await until(async () => botJson().status === "finished" && botJson().statusNote === "all contacted", 40000)), botJson())
  check("finished: native automations removed", !!(await until(async () => (await nativeAutos()).length === 0, 20000)))
  await viaMain("MARK-reopen", "BOTMARK-reopen", { tool: "bot_status", args: { status: "active" } })
  check("a finished bot cannot reopen itself", !!(await until(() => mock.requests.find((r) => r.afterTool && r.system.includes('You are "lifebot"') && /only set itself to "finished"/.test(r.lastText)), 40000)) && botJson().status === "finished")
  mock.queue.push({ when: (r) => r.lastText.includes("MARK-user-reopen"), tool: "bot_status", args: { name: "lifebot", status: "active" } }); await ask(dirs.project, "MARK-user-reopen")
  check("the user can reopen it: automations return", botJson().status === "active" && !!(await until(async () => (await nativeAutos()).length === 2, 20000)))

  console.log("\n[L6] history outlives opencode's own sessions")
  const sessIds = Object.keys(JSON.parse(fs.readFileSync(`${home}/bots/lifebot/history/index.json`, "utf8")))
  check("several conversations were recorded (automation, bot_say threads)", sessIds.length >= 3, sessIds)
  const victim = store.listThreads("lifebot").find((t) => t.key !== "auto" && fs.existsSync(`${home}/bots/lifebot/history/${t.sessionID}.jsonl`))
  if (victim) { await c.session.remove({ sessionID: victim.sessionID }).catch(() => {}) }
  mock.queue.push({ when: (r) => r.lastText.includes("MARK-hist"), tool: "bot_history", args: { name: "lifebot", thread: victim?.sessionID, transcript: true } }); await ask(dirs.project, "MARK-hist")
  const hist = mock.requests.filter((r) => r.afterTool).at(-1)?.lastText ?? ""
  check("bot_history still returns the recorded transcript after the session was deleted", !!victim && /you \/ caller/.test(hist) && /BOTMARK/.test(hist), hist.slice(0, 300))
} catch (e) {
  E.check("scenario ran to the end", false, e?.stack ?? String(e))
} finally {
  process.exit((await E.stop()) ? 1 : 0)
}
