// TUI smoke test: the real opencode TUI in a pseudo-terminal, attached to a test server that has openbot installed globally.
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startEnv, findBin, until } from "../e2e/harness.mjs"
import { BotStore } from "../../dist/store.js"
import { makeService, createBot } from "../../dist/service.js"

const E = await startEnv({ name: "tui", mockPort: 18096, serverPort: 18196, pluginScope: "global", env: { OPENBOT_DEBUG: "1", OPENCODE_SERVER_PASSWORD: "tui-test-pw" } })
let code = 1
try {
  E.mock.queue.push({ text: "ready" })
  const s = await E.ask(E.dirs.project, "hello")
  const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), "driver.py")
  const runDriver = (session, mode, extra = []) => new Promise((resolve) => {
    const p = spawn("python3", [driver, E.baseUrl, "tui-test-pw", session, E.dirs.project, E.home, mode, ...extra], { stdio: "inherit", env: { ...E.env, OPENCODE_BIN: findBin(), OPENBOT_DEBUG: "1" } })
    p.on("exit", (c) => resolve(c ?? 1))
  })
  const only = process.env.TUI_ONLY
  const c1 = only ? 0 : await runDriver(s.id, "basic")

  // Seed a real bot conversation (the bot answers a message sent from a normal session), then test the inspector on it.
  createBot(makeService(new BotStore(E.home)), { name: "seedbot", instructions: "You are seedbot. Answer briefly.", model: "mock/mock-1", workdir: E.dirs.scout })
  E.mock.queue.push({ tool: "bot_say", args: { name: "seedbot", message: "seed message" } })
  E.mock.queue.push({ when: (r) => r.system.includes('You are "seedbot"'), text: "seed reply from bot" })
  const since = E.mock.requests.length
  const seed = await E.ask(E.dirs.project, "seed a conversation")
  await until(() => E.mock.requests.slice(since).some((r) => r.lastText.includes("<background-result") && r.lastText.includes("seedbot")), 30000)
  const c2 = only && only !== "convs" ? 0 : await runDriver(seed.id, "convs")
  code = c1 || c2

  // Third run: a bot with memory, an alert, a pending question and a long file.
  if (!only || only === "life") {
    const fs = await import("node:fs")
    createBot(makeService(new BotStore(E.home)), { name: "lifebot", instructions: "You are lifebot. Answer briefly.", model: "mock/mock-1", workdir: E.dirs.box, description: "Find podcasts", automations: [{ id: "scan", every: "1 day", prompt: "focus on podcasts" }] })
    new BotStore(E.home).writeStateFile("lifebot", "# State\n## Goal\nFind podcasts\n## Important\n- budget is small\n## Todo\n- [ ] contact Ada Lovelace\n## Waiting for the user\n- (nothing)\n")
    fs.writeFileSync(`${E.dirs.box}/long.txt`, Array.from({ length: 120 }, (_, i) => `line ${String(i + 1).padStart(3, "0")} of a long file`).join("\n"))
    const bsay = (mark, step) => {
      E.mock.queue.push({ when: (r) => r.lastText.includes(mark), tool: "bot_say", args: { name: "lifebot", message: "BOT-" + mark } })
      E.mock.queue.push({ when: (r) => r.system.includes('You are "lifebot"') && r.lastText.includes("BOT-" + mark), ...step })
    }
    bsay("alert-seed", { tool: "bot_notify", args: { message: "Found 3 podcast hosts, need your pick", level: "attention", title: "Pick one" } })
    const seed1 = await E.ask(E.dirs.project, "alert-seed")
    await until(() => fs.existsSync(`${E.home}/bots/lifebot/inbox.json`), 40000)
    bsay("question-seed", { tool: "question", args: { questions: [{ question: "Which podcast first?", header: "Pick", options: [{ label: "Alpha", description: "first" }, { label: "Beta", description: "second" }] }] } })
    const seed2 = await E.ask(E.dirs.project, "question-seed")
    await until(async () => ((await E.c.form.list({ location: { directory: E.dirs.box } })).data ?? []).length > 0, 40000)
    const c3 = await runDriver(seed1.id, "life", [E.dirs.box]) // a conversation unrelated to the pending question
    const answered = E.mock.requests.some((r) => r.afterTool && r.system.includes('You are "lifebot"') && /Beta/.test(r.lastText))
    console.log(answered ? "  ok   the question answered in the TUI reached the bot (it saw: Beta)" : "  FAIL the bot never received the answer given in the TUI")
    code = code || c3 || (answered ? 0 : 1)
  }
} finally {
  await E.stop()
  process.exit(code)
}
