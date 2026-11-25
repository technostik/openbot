// E2E for the install scope that broke for a real user: the plugin is configured ONLY in the project's
// opencode.json, so the bot's working directory instance does NOT load openbot. The bot must still work.
import fs from "node:fs"
import { startEnv, until } from "./harness.mjs"
import { clientDiagEnv } from "../../dist/debug/client-env.js"
import { diagnose } from "../../dist/debug/diagnose.js"
import { BotStore } from "../../dist/store.js"

const E = await startEnv({ name: "project", mockPort: 18098, serverPort: 18198, pluginScope: "project", pluginOptions: { debug: true } })
const { dirs, mock, c, check, toolResultSeen, agents, ask, home } = E
try {
  console.log("\n[P1] plugin only in the project config; bot created through the tool")
  mock.queue.push({ tool: "bot_create", args: { name: "testbot", instructions: "You are testbot. Answer briefly.", model: "mock/mock-1" } })
  await ask(dirs.project, "create testbot")
  check("debug switched on through the plugin OPTION (object form in opencode.json): debug tools exist", (mock.requests.find((r) => !r.aux)?.tools ?? []).includes("bot_diagnose"))
  const bot = JSON.parse(fs.readFileSync(`${home}/bots/testbot/bot.json`, "utf8"))
  check("bot created in its default workspace", /created/.test(toolResultSeen()) && bot.workdir === `${home}/bots/testbot/workspace`, toolResultSeen())
  const inWorkdir = await until(async () => { const l = await agents(bot.workdir); return l.some((a) => a.id === "build") ? l : undefined }, 30000)
  check("the plugin is NOT loaded in the bot's workdir (the user's situation)", !!inWorkdir && !inWorkdir.some((a) => a.id === "openbot-marker"), inWorkdir?.map((a) => a.id))
  const withBot = await until(async () => { const l = await agents(bot.workdir); return l.some((a) => a.id === "testbot") ? l : undefined }, 20000)
  check("...but the bot's agent still exists there, from the native agent file", !!withBot, (await agents(bot.workdir)).map((a) => a.id))

  console.log("\n[P2] bot_say works even so (this used to fail with: Agent not found)")
  mock.queue.push({ tool: "bot_say", args: { name: "testbot", message: "hello testbot" } })
  mock.queue.push({ when: (r) => r.system.includes('You are "testbot"'), text: "Hello from testbot." })
  const since = mock.requests.length
  const caller = await ask(dirs.project, "say hello to testbot")
  const bg = await until(() => mock.requests.slice(since).map((r) => r.lastText).find((t) => t.includes("<background-result") && t.includes("bot:testbot")), 25000)
  if (process.env.E2E_DEBUG) { console.log("   [debug] requests:", JSON.stringify(mock.requests.slice(-5).map((r) => ({ aux: r.aux, afterTool: r.afterTool, sys: r.system.slice(0, 30), last: r.lastText.slice(0, 90), step: r.step && (r.step.tool ?? r.step.text) })))); console.log("   [debug] main ctx:", JSON.stringify((await c.session.context({ sessionID: caller.id })).slice(-4)).slice(0, 900)) }
  check("answer came back as a background result, no 'Agent not found'", /Hello from testbot/.test(bg ?? "") && !/Agent not found/.test(bg ?? "") && !/Agent not found/.test(toolResultSeen()), { bg, tool: toolResultSeen() })
  const th = JSON.parse(fs.readFileSync(`${home}/bots/testbot/state/threads.json`, "utf8")).threads[caller.id]
  const sess = await c.session.get({ sessionID: th.sessionID })
  const botReq = mock.requests.find((r) => r.system.includes('You are "testbot"'))
  check("the bot's conversation is a child of the caller, with the bot's agent", sess.agent === "testbot" && sess.parentID === caller.id, { agent: sess.agent, parentID: sess.parentID, caller: caller.id })
  check("the bot really works in ITS OWN directory (host says so), not in the project", !!botReq && botReq.system.includes(`Working directory: ${bot.workdir}`) && !botReq.system.includes(`Working directory: ${dirs.project}`), /Working directory:[^\n]*/.exec(botReq?.system ?? "")?.[0])

  console.log("\n[P3] diagnose explains the situation and what is (not) a problem")
  const store = new BotStore(home)
  const r = await diagnose(clientDiagEnv(c, { store, pluginVersion: "test", location: dirs.project, materializeEnabled: true }))
  const by = Object.fromEntries(r.checks.filter((x) => x.scope === "testbot").map((x) => [x.id, x]))
  check("diagnose: agent exists in workdir via the native file (plugin not loaded there)", by["agent-workdir"]?.level === "ok" && /not loaded there/.test(by["agent-workdir"].detail ?? ""), by["agent-workdir"])
  check("diagnose: last run succeeded", by["last-run"]?.level === "ok", by["last-run"])
  check("diagnose finds no errors", r.ok, r.checks.filter((x) => x.level === "error"))

  console.log("\n[P4] if the agent file is deleted, diagnose says so, and the plugin heals it")
  fs.rmSync(`${bot.workdir}/.opencode`, { recursive: true })
  const r2 = await diagnose(clientDiagEnv(c, { store, pluginVersion: "test", location: dirs.project, materializeEnabled: true }))
  check("diagnose reports the missing agent file", r2.checks.some((x) => x.scope === "testbot" && x.id === "agent-file" && x.level === "warn"))
  fs.appendFileSync(`${home}/bots/testbot/system.md`, "\nBe extra brief.\n")
  check("the next reload rewrites the agent file", !!(await until(async () => fs.existsSync(`${bot.workdir}/.opencode/agents/testbot.md`) && fs.readFileSync(`${bot.workdir}/.opencode/agents/testbot.md`, "utf8").includes("extra brief"), 15000)))
} catch (e) {
  E.check("scenario ran to the end", false, e?.stack ?? String(e))
} finally {
  process.exit((await E.stop()) ? 1 : 0)
}
