// E2E, plugin installed GLOBALLY, debug on. Real opencode server + plugin + scripted mock LLM.
import fs from "node:fs"
import path from "node:path"
import { startEnv, until, sleep, repo } from "./harness.mjs"
import { clientDiagEnv } from "../../dist/debug/client-env.js"
import { diagnose } from "../../dist/debug/diagnose.js"
import { buildReport } from "../../dist/debug/report.js"
import { BotStore } from "../../dist/store.js"

const E = await startEnv({ name: "global", mockPort: 18099, serverPort: 18199, pluginScope: "global", env: { OPENBOT_DEBUG: "1" } })
const { dirs, mock, c, check, toolResultSeen, botJson, agents, ask, home } = E
const scoutSays = (re) => (r) => r.system.includes('You are "scout"') && (!re || re.test(r.lastText))
const agentFile = (dir, n) => `${dir}/.opencode/agents/${n}.md`
// A child (bot) session reports back to the calling conversation as a background result (host behaviour).
const bgResult = (bot, since) => mock.requests.slice(since).map((r) => r.lastText).find((t) => t.includes("<background-result") && t.includes(`bot:${bot}`))
const settle = async (bot, since) => { const t = await until(() => bgResult(bot, since), 25000); await sleep(1500); return t }
try {
  console.log("\n[1] create a bot through the bot_create tool")
  mock.queue.push({ tool: "bot_create", args: { name: "scout", instructions: "You find business partners. Keep a CRM in crm.md.", description: "Partner scout", model: "mock/mock-1", workdir: dirs.scout } })
  await ask(dirs.project, "please create a bot")
  const tools0 = mock.requests.find((r) => !r.aux)?.tools ?? []
  check("bot_* tools (incl. new + debug ones) are native tools", ["bot_list", "bot_get", "bot_create", "bot_update", "bot_delete", "bot_say", "bot_history", "bot_conversations", "bot_files", "bot_export", "bot_import", "bot_diagnose"].every((t) => tools0.includes(t)), tools0)
  check("master prompt is in system.md, not in bot.json", fs.readFileSync(`${home}/bots/scout/system.md`, "utf8").includes("CRM") && !("instructions" in botJson("scout")) && botJson("scout").workdir === dirs.scout)
  check("tool reported success and the editable prompt path", /created/.test(toolResultSeen()) && toolResultSeen().includes(`${home}/bots/scout/system.md`), toolResultSeen())
  const a1 = await until(async () => (await agents(dirs.project)).find((a) => a.id === "scout"))
  check("bot is a registered agent with prompt, mode all, model", !!a1 && a1.system.includes("find business partners") && a1.mode === "all" && a1.model?.id === "mock-1", a1)
  check("hidden marker agent shows the plugin is loaded", (await agents(dirs.project)).some((a) => a.id === "openbot-marker" && a.hidden))
  check("native agent file written into the bot's workdir", fs.existsSync(agentFile(dirs.scout, "scout")) && /x-openbot: managed/.test(fs.readFileSync(agentFile(dirs.scout, "scout"), "utf8")))

  console.log("\n[2] talk to the bot: child conversation in its workdir, own model")
  mock.queue.push({ tool: "bot_say", args: { name: "scout", message: "hello scout, who are you?" } })
  mock.queue.push({ when: scoutSays(/who are you/), text: "I am scout, ready to hunt partners." })
  let since = mock.requests.length
  const caller = await ask(dirs.project, "talk to scout")
  check("bot_say returned immediately: handed over, answer comes later", !!(await until(() => mock.requests.slice(since).some((r) => r.afterTool && /Message handed to scout/.test(r.lastText)), 25000)), toolResultSeen())
  const bg2 = await settle("scout", since)
  check("the bot's answer is delivered to the caller as a background result", /I am scout, ready to hunt partners/.test(bg2 ?? ""), bg2)
  const sr = mock.requests.filter((r) => r.system.includes('You are "scout"')).at(-1)
  check("bot LLM call has master prompt, workdir and the path of its own system.md", sr?.system.includes("Keep a CRM in crm.md") && sr.system.includes(dirs.scout) && sr.system.includes(`${home}/bots/scout/system.md`), sr?.system.slice(0, 400))
  const threads = JSON.parse(fs.readFileSync(`${home}/bots/scout/state/threads.json`, "utf8")).threads
  const th = threads[caller.id]
  check("conversation is registered as a thread of the calling session", !!th && th.parentID === caller.id, threads)
  const sess = await c.session.get({ sessionID: th.sessionID })
  check("bot session uses the bot's agent and is a CHILD of the calling session (visible under it in the UI)", sess.agent === "scout" && sess.parentID === caller.id, { agent: sess.agent, parentID: sess.parentID, caller: caller.id })
  check("the bot really works in ITS OWN directory (host says so), not in the project", sr.system.includes(`Working directory: ${dirs.scout}`) && !sr.system.includes(`Working directory: ${dirs.project}`), /Working directory:[^\n]*/.exec(sr?.system ?? "")?.[0])

  console.log("\n[3] same caller continues the conversation; another caller gets its own")
  mock.queue.push({ tool: "bot_say", args: { name: "scout", message: "second message" } })
  mock.queue.push({ when: scoutSays(/second message/), text: "Noted." })
  since = mock.requests.length
  await ask(dirs.project, "talk again", { sessionID: caller.id }); await settle("scout", since)
  const sr2 = mock.requests.filter((r) => r.system.includes('You are "scout"')).at(-1)
  check("same session reused: earlier exchange is in the bot's context", JSON.stringify(sr2.messages).includes("hello scout, who are you?"))
  check("still one bot session for this caller", JSON.parse(fs.readFileSync(`${home}/bots/scout/state/threads.json`, "utf8")).threads[caller.id].sessionID === th.sessionID)
  mock.queue.push({ tool: "bot_say", args: { name: "scout", message: "hi from elsewhere" } })
  mock.queue.push({ when: scoutSays(/elsewhere/), text: "Hello other conversation." })
  since = mock.requests.length
  const caller2 = await ask(dirs.project, "talk from another conversation"); await settle("scout", since)
  const t2 = JSON.parse(fs.readFileSync(`${home}/bots/scout/state/threads.json`, "utf8")).threads
  check("another calling session gets a separate conversation", t2[caller2.id] && t2[caller2.id].sessionID !== th.sessionID, Object.keys(t2))

  console.log("\n[4] @scout in the user's prompt is routed to the bot")
  mock.queue.push({ when: (r) => r.lastText.includes("[openbot]"), tool: "bot_say", args: { name: "scout", message: "status report please" } })
  mock.queue.push({ when: scoutSays(/status report/), text: "Status: all good." })
  since = mock.requests.length
  await ask(dirs.project, "@scout status report please", { agents: [{ name: "scout", mention: { start: 0, end: 6, text: "@scout" } }] })
  const bg4 = await settle("scout", since)
  const mainReq = mock.requests.find((r) => !r.aux && !r.afterTool && r.lastText.includes("[openbot]"))
  check("the user's agent received the delegation instruction (hook rewrote the prompt)", !!mainReq && /bot_say/.test(mainReq.lastText) && /status report please/.test(mainReq.lastText))
  check("bot's reply is delivered back", /Status: all good/.test(bg4 ?? ""), bg4)

  console.log("\n[5] editable system prompt: by hand, by bot_update, by the bot itself")
  fs.writeFileSync(`${home}/bots/scout/system.md`, "You are now edited BY HAND in system.md.\n")
  const a5 = await until(async () => (await agents(dirs.project)).find((a) => a.id === "scout" && a.system.includes("edited BY HAND")), 15000)
  check("hand edit of system.md reaches the live agent without restart", !!a5)
  check("...and the native agent file in the workdir", await until(async () => fs.readFileSync(agentFile(dirs.scout, "scout"), "utf8").includes("edited BY HAND"), 10000))
  mock.queue.push({ tool: "bot_say", args: { name: "scout", message: "please change your role" } })
  mock.queue.push({ when: scoutSays(/change your role/), tool: "bot_update", args: { instructions: "You are now a CRM keeper." } })
  await ask(dirs.project, "reconfigure scout via itself")
  check("bot_update (self) rewrote system.md", !!(await until(async () => fs.readFileSync(`${home}/bots/scout/system.md`, "utf8").trim() === "You are now a CRM keeper.", 25000)))
  check("live agent reflects the self-change", !!(await until(async () => (await agents(dirs.project)).find((a) => a.id === "scout" && a.system.includes("CRM keeper")), 15000)))
  fs.mkdirSync(`${home}/bots/other`, { recursive: true }); fs.writeFileSync(`${home}/bots/other/bot.json`, JSON.stringify({ name: "other", instructions: "I am hand-written.", model: "mock/mock-1" }))
  check("a hand-written legacy bot.json is picked up and migrated to system.md", !!(await until(async () => (await agents(dirs.project)).find((a) => a.id === "other"), 15000)) && !!(await until(async () => fs.existsSync(`${home}/bots/other/system.md`), 10000)))
  mock.queue.push({ tool: "bot_say", args: { name: "scout", message: "try to hijack other" } })
  mock.queue.push({ when: scoutSays(/hijack/), tool: "bot_update", args: { name: "other", instructions: "pwned" } })
  await ask(dirs.project, "hijack attempt")
  check("a bot cannot modify another bot", !!(await until(async () => /not allowed/.test(mock.requests.filter((r) => r.afterTool && r.system.includes('You are "scout"')).at(-1)?.lastText ?? ""), 25000)) && fs.readFileSync(`${home}/bots/other/system.md`, "utf8").includes("hand-written"))

  console.log("\n[6] skills allowlist, local skills and MCP packaged with a bot")
  fs.mkdirSync(`${home}/bots/box/skills/hello`, { recursive: true })
  fs.writeFileSync(`${home}/bots/box/skills/hello/SKILL.md`, "---\nname: hello\ndescription: greets people politely\n---\nSay hello politely.\n")
  fs.writeFileSync(`${home}/bots/box/bot.json`, JSON.stringify({ name: "box", instructions: "You are box.", model: "mock/mock-1", workdir: dirs.box, skills: ["hello"], mcps: { crm: { type: "local", command: ["node", path.join(repo, "test/helpers/mini-mcp.mjs")] } } }))
  const boxAgent = await until(async () => (await agents(dirs.box)).find((a) => a.id === "box"), 15000)
  const rules = (boxAgent?.permissions ?? []).filter((p) => p.action === "skill").map((p) => `${p.effect}:${p.resource}`)
  check("skills allowlist becomes permission rules (by name and id)", rules[0] === "deny:*" && rules.includes("allow:hello") && rules.includes("allow:box.hello"), rules)
  const skillList = async (dir) => ((await c.skill.list({ location: { directory: dir } })).data).map((x) => x.name ?? x.id)
  check("bot-local skill is registered in the bot's workdir only", !!(await until(async () => (await skillList(dirs.box)).includes("hello"), 15000)) && !(await skillList(dirs.project)).includes("hello"))
  let boxReq
  for (let i = 0; i < 4 && !/box-crm/.test(boxReq?.system ?? ""); i++) {
    mock.queue.push({ tool: "bot_say", args: { name: "box", message: `use your tools ${i}`, new_conversation: true } })
    mock.queue.push({ when: (r) => r.system.includes('You are "box"'), text: "ok" })
    const sinceBox = mock.requests.length
    await ask(dirs.project, "talk to box", { timeout: 20000 }); await settle("box", sinceBox)
    boxReq = mock.requests.filter((r) => r.system.includes('You are "box"')).at(-1)
    if (!/box-crm/.test(boxReq?.system ?? "")) await sleep(1500)
  }
  check("bot's MCP server tools reach the bot's model", /box-crm/.test(boxReq?.system ?? "") && /echo/.test(boxReq?.system ?? ""))
  const skillTool = JSON.stringify((boxReq?.toolDefs ?? []).find((t) => t.function?.name === "skill") ?? {})
  check("bot-local skill is offered to the bot's model", /greets people politely/.test(skillTool + (boxReq?.system ?? "")), { skillTool: skillTool.slice(0, 600), toolNames: boxReq?.tools, systemHasSkillsSection: /Skills provide/.test(boxReq?.system ?? "") })

  console.log("\n[7] export, import, delete (agent file cleaned up)")
  const bundle = `${E.T}/scout.openbot.json`
  mock.queue.push({ tool: "bot_export", args: { name: "scout", path: bundle } }); await ask(dirs.project, "export scout")
  const b = JSON.parse(fs.existsSync(bundle) ? fs.readFileSync(bundle, "utf8") : "{}")
  check("bundle written, no workdir, prompt included", !!b.bot && !("workdir" in b.bot) && /CRM keeper/.test(b.bot.instructions))
  mock.queue.push({ tool: "bot_import", args: { path: bundle, rename: "scout2" } }); await ask(dirs.project, "import scout2")
  check("imported bot has its own workspace, system.md and agent file", botJson("scout2").workdir === `${home}/bots/scout2/workspace` && fs.existsSync(`${home}/bots/scout2/system.md`) && fs.existsSync(agentFile(`${home}/bots/scout2/workspace`, "scout2")), toolResultSeen())
  mock.queue.push({ tool: "bot_delete", args: { name: "scout2", confirm: true } }); await ask(dirs.project, "delete scout2")
  check("deleted: gone from disk and agent list", !fs.existsSync(`${home}/bots/scout2`) && !!(await until(async () => !(await agents(dirs.project)).find((a) => a.id === "scout2"), 15000)))

  console.log("\n[8] inspect: history, conversations, files, get")
  fs.writeFileSync(`${dirs.scout}/crm.md`, "# CRM\n- Ada Lovelace — podcast host\n")
  mock.queue.push({ tool: "bot_history", args: { name: "scout", limit: 4 } }); await ask(dirs.project, "history of scout")
  check("bot_history returns recent messages", /"messages"/.test(toolResultSeen()), toolResultSeen())
  mock.queue.push({ tool: "bot_conversations", args: { name: "scout" } }); await ask(dirs.project, "conversations of scout")
  const convs = toolResultSeen()
  check("bot_conversations lists the threads with where they started", convs.includes(caller.id) && convs.includes(th.sessionID) && /startedFrom/.test(convs), convs.slice(0, 400))
  mock.queue.push({ tool: "bot_files", args: { name: "scout" } }); await ask(dirs.project, "files of scout")
  check("bot_files lists the working directory", /crm\.md/.test(toolResultSeen()), toolResultSeen())
  mock.queue.push({ tool: "bot_files", args: { name: "scout", path: "crm.md" } }); await ask(dirs.project, "read crm")
  check("bot_files reads a file of the working directory", /Ada Lovelace/.test(toolResultSeen()))
  mock.queue.push({ tool: "bot_get", args: { name: "scout" } }); await ask(dirs.project, "get scout")
  check("bot_get shows paths, agent file state and conversation count", /systemPromptFile/.test(toolResultSeen()) && /agentFileState/.test(toolResultSeen()) && /"count"/.test(toolResultSeen()), toolResultSeen().slice(0, 300))

  console.log("\n[9] debug tools: diagnose, ping, report, log")
  mock.queue.push({ tool: "bot_diagnose", args: { name: "scout", ping: true, report: true } })
  mock.queue.push({ when: scoutSays(/Diagnostic ping/), text: "OK" })
  await ask(dirs.project, "diagnose scout")
  const diag = toolResultSeen()
  check("bot_diagnose reports checks for the bot", /\[bot scout\]/.test(diag) && /Working directory is ready/.test(diag), diag.slice(0, 500))
  check("ping reached the bot's model and came back", /\[ping\] done: OK/.test(diag), diag.slice(-300))
  const reportFile = /Report written: (\S+)/.exec(diag)?.[1]
  check("report file written", !!reportFile && fs.existsSync(reportFile) && /# openbot diagnostic report/.test(fs.readFileSync(reportFile, "utf8")), diag.slice(-200))
  const logLines = fs.existsSync(`${home}/logs/openbot.log`) ? fs.readFileSync(`${home}/logs/openbot.log`, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []
  check("debug log recorded setup, tool calls and mentions", ["setup", "tool", "mention", "reload"].every((ev) => logLines.some((l) => l.event === ev)), [...new Set(logLines.map((l) => l.event))])
  const storeView = new BotStore(home)
  const diagEnv = clientDiagEnv(c, { store: storeView, pluginVersion: "test", location: dirs.project, materializeEnabled: true })
  const full = await diagnose(diagEnv)
  const byId = Object.fromEntries(full.checks.filter((x) => x.scope === "scout").map((x) => [x.id, x]))
  check("client-based diagnose sees the bot's agent in its working directory", byId["agent-workdir"]?.level === "ok" && /openbot is loaded there too/.test(byId["agent-workdir"].detail ?? ""), byId["agent-workdir"])
  check("client-based diagnose: plugin loaded here, agent file ok", full.checks.some((x) => x.id === "plugin-here" && x.level === "ok") && byId["agent-file"]?.level === "ok")
  const rep = await buildReport(diagEnv)
  check("client-based report has a section per bot and the debug log", /## Bot `scout`/.test(rep.markdown) && /Debug log \(tail\)/.test(rep.markdown))
} catch (e) {
  E.check("scenario ran to the end", false, e?.stack ?? String(e))
} finally {
  process.exit((await E.stop()) ? 1 : 0)
}
