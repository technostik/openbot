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
  const runDriver = (session, mode) => new Promise((resolve) => {
    const p = spawn("python3", [driver, E.baseUrl, "tui-test-pw", session, E.dirs.project, E.home, mode], { stdio: "inherit", env: { ...E.env, OPENCODE_BIN: findBin(), OPENBOT_DEBUG: "1" } })
    p.on("exit", (c) => resolve(c ?? 1))
  })
  const c1 = process.env.TUI_ONLY === "convs" ? 0 : await runDriver(s.id, "basic")

  // Seed a real bot conversation (the bot answers a message sent from a normal session), then test the inspector on it.
  createBot(makeService(new BotStore(E.home)), { name: "seedbot", instructions: "You are seedbot. Answer briefly.", model: "mock/mock-1", workdir: E.dirs.scout })
  E.mock.queue.push({ tool: "bot_say", args: { name: "seedbot", message: "seed message" } })
  E.mock.queue.push({ when: (r) => r.system.includes('You are "seedbot"'), text: "seed reply from bot" })
  const since = E.mock.requests.length
  const seed = await E.ask(E.dirs.project, "seed a conversation")
  await until(() => E.mock.requests.slice(since).some((r) => r.lastText.includes("<background-result") && r.lastText.includes("seedbot")), 30000)
  const c2 = await runDriver(seed.id, "convs")
  code = c1 || c2
} finally {
  await E.stop()
  process.exit(code)
}
