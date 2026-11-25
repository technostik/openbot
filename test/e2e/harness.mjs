// Shared e2e harness: real opencode server + this plugin + scripted mock LLM (no internet needed).
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { startMock } from "../helpers/mock-llm.mjs"

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(fn, ms = 10000, step = 200) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return undefined; await sleep(step) } }

export function findBin() {
  const bin = process.env.OPENCODE_BIN ?? path.join(repo, "node_modules/.bin/opencode")
  if (!fs.existsSync(bin)) { console.error(`opencode binary not found at ${bin}. Set OPENCODE_BIN or run: npm i --no-save @opencode/cli@2.4.1`); process.exit(2) }
  return bin
}

/**
 * @param {{name:string, mockPort:number, serverPort:number, pluginScope:"global"|"project", env?:object, pluginOptions?:object}} o
 */
export async function startEnv(o) {
  const T = path.join(repo, ".tmp-e2e", `${o.name}-${Date.now()}`)
  const dirs = { T, project: `${T}/project`, scout: `${T}/work-scout`, box: `${T}/work-box`, xdg: `${T}/xdg`, home: `${T}/openbot` }
  for (const d of [dirs.project, dirs.scout, dirs.box, dirs.home, `${dirs.xdg}/config/opencode`]) fs.mkdirSync(d, { recursive: true })
  const mock = await startMock(o.mockPort)
  const provider = { mock: { name: "Mock", package: "@ai-sdk/openai-compatible", settings: { baseURL: mock.url, apiKey: "x" }, models: { "mock-1": { name: "Mock 1" } } } }
  const pluginEntry = o.pluginOptions ? { package: repo, options: o.pluginOptions } : repo
  fs.writeFileSync(`${dirs.xdg}/config/opencode/opencode.json`, JSON.stringify({ providers: provider, ...(o.pluginScope === "global" ? { plugins: [pluginEntry] } : {}) }, null, 2))
  if (o.pluginScope === "project") fs.writeFileSync(`${dirs.project}/opencode.json`, JSON.stringify({ plugins: [pluginEntry] }, null, 2))
  const env = { ...process.env, XDG_CONFIG_HOME: `${dirs.xdg}/config`, XDG_DATA_HOME: `${dirs.xdg}/data`, XDG_CACHE_HOME: `${dirs.xdg}/cache`, XDG_STATE_HOME: `${dirs.xdg}/state`, OPENBOT_HOME: dirs.home, ...(o.env ?? {}) }
  const server = spawn(findBin(), ["serve", "--port", String(o.serverPort), "--hostname", "127.0.0.1"], { env, stdio: ["pipe", "pipe", "pipe"] })
  let serverOut = ""
  server.stdout.on("data", (d) => (serverOut += d)); server.stderr.on("data", (d) => (serverOut += d))
  const fixed = o.env?.OPENCODE_SERVER_PASSWORD
  const password = fixed ? ((await until(() => /server listening/.test(serverOut), 30000)) ? fixed : undefined) : await until(() => /server password (\S+)/.exec(serverOut)?.[1], 30000)
  if (!password) { console.error("server did not start:\n" + serverOut); process.exit(2) }
  const c = OpenCode.make({ baseUrl: `http://127.0.0.1:${o.serverPort}`, headers: { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") } })

  let pass = 0, fail = 0
  const check = (name, ok, detail) => { if (ok) { pass++; console.log("  ok   " + name) } else { fail++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 700) : "")) } }
  const ctx = {
    T, dirs, mock, c, check, home: dirs.home, env, password, baseUrl: `http://127.0.0.1:${o.serverPort}`,
    toolResultSeen: () => mock.requests.filter((r) => r.afterTool).at(-1)?.lastText ?? "",
    botJson: (n) => JSON.parse(fs.readFileSync(`${dirs.home}/bots/${n}/bot.json`, "utf8")),
    agents: async (dir) => { const o2 = await c.agent.list({ location: { directory: dir } }); return o2.data ?? o2 },
    /** Sends a prompt in a new session (or `sessionID`), waits until that prompt's run is idle. */
    async ask(dir, text, { agents: ag, agent = "build", timeout = 60000, sessionID } = {}) {
      const s = sessionID ? { id: sessionID } : await c.session.create({ agent, model: { providerID: "mock", id: "mock-1" }, location: { directory: dir } })
      const idlesBefore = (await c.session.context({ sessionID: s.id })).filter((x) => x.type === "idle").length
      await c.session.prompt({ sessionID: s.id, text, ...(ag ? { agents: ag } : {}) })
      await until(async () => (await c.session.context({ sessionID: s.id })).filter((x) => x.type === "idle").length > idlesBefore, timeout, 300)
      return { id: s.id }
    },
    summary: () => ({ pass, fail }),
    async stop() {
      server.kill("SIGTERM"); await mock.close()
      console.log(`\n${pass} passed, ${fail} failed`)
      if (fail) console.log("\n--- server output (tail) ---\n" + serverOut.split("\n").slice(-20).join("\n"))
      return fail
    },
  }
  return ctx
}
