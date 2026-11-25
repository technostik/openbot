// With debug OFF (the default for a public release) no debug tool, log or report may exist.
import fs from "node:fs"
import { startEnv } from "./harness.mjs"
const E = await startEnv({ name: "debugoff", mockPort: 18095, serverPort: 18195, pluginScope: "global" })
const { dirs, mock, check, toolResultSeen, home } = E
try {
  mock.queue.push({ tool: "bot_create", args: { name: "quiet", instructions: "You are quiet.", model: "mock/mock-1" } })
  await E.ask(dirs.project, "create quiet")
  const tools = mock.requests.find((r) => !r.aux)?.tools ?? []
  check("the regular bot_* tools are there", ["bot_create", "bot_say", "bot_files", "bot_conversations"].every((t) => tools.includes(t)), tools)
  check("bot_diagnose is NOT exposed when debug is off", !tools.includes("bot_diagnose"), tools)
  check("bot was created normally", /created/.test(toolResultSeen()), toolResultSeen())
  check("no debug log is written", !fs.existsSync(`${home}/logs`))
  check("no report folder exists", !fs.existsSync(`${home}/reports`))
} catch (e) {
  E.check("scenario ran to the end", false, e?.stack ?? String(e))
} finally {
  process.exit((await E.stop()) ? 1 : 0)
}
