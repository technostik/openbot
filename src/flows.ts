/**
 * The TUI's interactions (dialogs and commands), as plain functions over the
 * TUI plugin context. Kept out of the JSX file so they compile with the rest
 * and can be tested with a fake context.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { listTree, readInside, renderTree } from "./files.js"
import { nameProblem } from "./names.js"
import { redactBot } from "./redact.js"
import { createBot, deleteBot, updateBot, type Service } from "./service.js"
import type { BotStore } from "./store.js"
import { VERSION } from "./version.js"

type Context = Plugin.Context

export interface FlowDeps {
  ctx: Context
  store: BotStore
  service: Service
  /** Debug tools (diagnose, report) are only offered when this is true. */
  debug: boolean
  options: Record<string, unknown>
}

const clip = (s: string, n = 2600) => (s.length > n ? s.slice(0, n) + "\n… (clipped)" : s)
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`
}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const unwrap = (o: any): any[] => (Array.isArray(o) ? o : Array.isArray(o?.data) ? o.data : [])
const at = (d: FlowDeps, directory?: string) => (directory ? { location: { directory } } : d.ctx.location ? { location: d.ctx.location } : undefined)

/** Model picker. Resolves to "" for opencode's default, a "provider/model" id, or undefined when cancelled. */
export async function pickModel(d: FlowDeps, title: string, current?: string): Promise<string | undefined> {
  const options: Array<{ title: string; value: string; description?: string; category?: string }> = [{ title: "Default model", value: "", description: "use whatever opencode uses by default" }]
  const cur = d.ctx.ui.model.current()
  if (cur) options.push({ title: `Same as the current model (${cur.providerID}/${cur.modelID})`, value: `${cur.providerID}/${cur.modelID}` })
  try {
    const models = unwrap(await d.ctx.client.model.list(at(d) as any))
    for (const m of models) {
      const id = `${m.providerID}/${m.modelID ?? m.id}`
      options.push({ title: m.name ?? String(m.modelID ?? m.id), value: id, description: id, category: m.providerID })
    }
  } catch {
    /* model list is best effort */
  }
  return d.ctx.ui.dialog.select<string>({ title, options, current: current ?? "" })
}

export async function createBotFlow(d: FlowDeps): Promise<void> {
  const { dialog, toast } = d.ctx.ui
  let name = ""
  for (;;) {
    const input = await dialog.prompt({ title: "Create bot: name", description: "Lowercase letters, digits and dashes. You will talk to it with @name.", placeholder: "scout" })
    if (input === undefined) return
    name = input.trim().toLowerCase()
    const problem = nameProblem(name) ?? (d.store.exists(name) ? `A bot named "${name}" already exists.` : undefined)
    if (!problem) break
    await dialog.alert({ title: "Invalid name", message: problem })
  }
  const role = await dialog.prompt({ title: "Create bot: role", description: "Its master prompt: role, goal, rules. You can edit it later (system.md).", placeholder: "You find potential business partners on the web and keep a CRM in crm.md" })
  if (!role?.trim()) return
  const model = await pickModel(d, "Create bot: model")
  if (model === undefined) return
  const def = d.store.defaultWorkdir(name)
  const wd = await dialog.prompt({ title: "Create bot: working directory", description: "Where it works and keeps its files. Empty = its private workspace.", placeholder: def })
  if (wd === undefined) return
  try {
    createBot(d.service, { name, instructions: role, ...(model ? { model } : {}), ...(wd.trim() ? { workdir: wd.trim() } : {}) })
    toast.show({ title: "Bot created", message: `@${name} is ready. Mention it in a prompt, or open it from the sidebar.`, variant: "success" })
  } catch (e) {
    await dialog.alert({ title: "Could not create the bot", message: message(e) })
  }
}

/** Pick one of the bots, then open its menu. */
export async function botsFlow(d: FlowDeps): Promise<void> {
  const bots = d.store.list()
  if (!bots.length) {
    if (await d.ctx.ui.dialog.confirm({ title: "No bots yet", message: "Create your first bot now?", label: { confirm: "Create bot" } })) await createBotFlow(d)
    return
  }
  const name = await d.ctx.ui.dialog.select<string>({
    title: "Bots",
    options: bots.map((b) => ({ title: `@${b.name}`, value: b.name, description: b.description ?? b.model ?? "default model", footer: `${d.store.listThreads(b.name).length} conversation(s)` })),
    actions: [{ bind: "ctrl+n", title: "new bot", selection: "none", onTrigger: () => void createBotFlow(d) }],
  })
  if (name) await botMenuFlow(d, name)
}

export async function botMenuFlow(d: FlowDeps, name: string): Promise<void> {
  const { dialog } = d.ctx.ui
  for (;;) {
    const bot = d.store.get(name)
    if (!bot) return
    const n = d.store.listThreads(name).length
    const choice = await dialog.select<string>({
      title: `@${name}`,
      options: [
        { title: "Conversations", value: "conv", description: `${n} conversation(s): open where the bot was used` },
        { title: "Master prompt", value: "prompt", description: "view or edit what the bot is told to be" },
        { title: "Working directory", value: "files", description: bot.workdir },
        { title: "Model", value: "model", description: bot.model ?? "default model" },
        { title: "Configuration", value: "config", description: "bot.json (secrets hidden)" },
        ...(d.debug ? [{ title: "Diagnose", value: "diag", description: "check everything this bot needs", category: "Debug" }, { title: "Generate report", value: "report", description: "write a full markdown report", category: "Debug" }] : []),
        { title: "Delete bot", value: "delete", description: "removes its config; the working directory is kept", category: "Danger" },
      ],
    })
    if (!choice) return
    if (choice === "conv") { if (await conversationsFlow(d, name)) return }
    else if (choice === "prompt") await promptFlow(d, name)
    else if (choice === "files") await filesFlow(d, name)
    else if (choice === "model") await modelFlow(d, name)
    else if (choice === "config") await dialog.alert({ title: `@${name}: bot.json`, message: clip(JSON.stringify(redactBot(bot), null, 2)) })
    else if (choice === "diag") await diagnoseFlow(d, name, false)
    else if (choice === "report") await diagnoseFlow(d, name, true)
    else if (choice === "delete") {
      if (await dialog.confirm({ title: `Delete @${name}?`, message: "Its configuration, local skills and conversation links are removed. The working directory is not touched.", label: { confirm: "Delete" } })) {
        try {
          deleteBot(d.service, name)
          d.ctx.ui.toast.show({ message: `@${name} deleted`, variant: "info" })
        } catch (e) {
          await dialog.alert({ title: "Could not delete", message: message(e) })
        }
        return
      }
    }
  }
}

async function modelFlow(d: FlowDeps, name: string): Promise<void> {
  const bot = d.store.require(name)
  const model = await pickModel(d, `@${name}: model`, bot.model)
  if (model === undefined) return
  try {
    updateBot(d.service, name, { model: model || null })
    d.ctx.ui.toast.show({ message: `@${name} now uses ${model || "the default model"}`, variant: "success" })
  } catch (e) {
    await d.ctx.ui.dialog.alert({ title: "Could not change the model", message: message(e) })
  }
}

async function promptFlow(d: FlowDeps, name: string): Promise<void> {
  const { dialog } = d.ctx.ui
  const bot = d.store.require(name)
  const file = d.store.systemPath(name)
  const act = await dialog.select<string>({
    title: `@${name}: master prompt`,
    options: [
      { title: "View", value: "view", description: file },
      { title: "Replace", value: "replace", description: "edit the whole text here" },
      { title: "Add an instruction", value: "append", description: "append a line to the prompt" },
    ],
  })
  try {
    if (act === "view") await dialog.alert({ title: `@${name}: ${file}`, message: clip(bot.instructions, 3000) + `\n\n(edit this file in any editor; changes apply within seconds)` })
    else if (act === "replace") {
      const text = await dialog.prompt({ title: `@${name}: master prompt`, description: `Stored in ${file}`, value: bot.instructions })
      if (text?.trim()) updateBot(d.service, name, { instructions: text })
    } else if (act === "append") {
      const text = await dialog.prompt({ title: `@${name}: add an instruction`, placeholder: "Always answer in French." })
      if (text?.trim()) updateBot(d.service, name, { instructions: bot.instructions + "\n\n" + text.trim() })
    }
  } catch (e) {
    await dialog.alert({ title: "Could not save", message: message(e) })
  }
}

async function filesFlow(d: FlowDeps, name: string): Promise<void> {
  const { dialog } = d.ctx.ui
  const bot = d.store.require(name)
  const { entries, exists } = listTree(bot.workdir, { depth: 3, max: 80 })
  if (!exists) return void (await dialog.alert({ title: `@${name}: working directory`, message: `${bot.workdir}\n\n(does not exist yet; it is created when the bot first works)` }))
  const files = entries.filter((e) => e.type === "file")
  if (!files.length) return void (await dialog.alert({ title: `@${name}: working directory`, message: `${bot.workdir}\n\n${renderTree(bot.workdir, { depth: 3 })}` }))
  const picked = await dialog.select<string>({
    title: `@${name}: ${bot.workdir}`,
    placeholder: "Pick a file to read",
    options: files.map((f) => ({ title: f.path, value: f.path, description: `${f.size ?? 0} B` })),
  })
  if (!picked) return
  const r = readInside(bot.workdir, picked, 8000)
  await dialog.alert({ title: picked, message: r.ok ? clip(r.content, 3000) : r.error })
}

/** Lists a bot's conversations; picking one opens it. Returns true when it navigated away. */
export async function conversationsFlow(d: FlowDeps, name: string): Promise<boolean> {
  const bot = d.store.require(name)
  const known = d.store.listThreads(name)
  const options: Array<{ title: string; value: string; description: string; footer?: string }> = known.map((t) => ({
    title: t.key === "main" ? "Main conversation (no caller)" : `Used from session ${t.key.slice(0, 18)}…`,
    value: t.sessionID,
    description: `last used ${ago(t.lastAt)}`,
    footer: t.sessionID,
  }))
  try {
    for (const s of unwrap(await d.ctx.client.session.list({ directory: bot.workdir } as any))) {
      if (s.agent === name && !known.some((k) => k.sessionID === s.id)) options.push({ title: s.title ?? s.id, value: s.id, description: "other session using this bot", footer: s.id })
    }
  } catch {
    /* listing is best effort */
  }
  if (!options.length) return void (await d.ctx.ui.dialog.alert({ title: `@${name}: conversations`, message: "No conversation yet. Mention the bot in a prompt (@" + name + " ...) to start one." })), false
  const id = await d.ctx.ui.dialog.select<string>({ title: `@${name}: conversations`, placeholder: "Pick one to open it", options })
  if (!id) return false
  d.ctx.ui.dialog.clear()
  d.ctx.ui.router.navigate({ type: "session", sessionID: id })
  return true
}

/** Debug: diagnose one bot (or everything) from the TUI, optionally writing a report. */
export async function diagnoseFlow(d: FlowDeps, name: string | undefined, report: boolean): Promise<void> {
  if (!d.debug) return
  const { dialog, toast } = d.ctx.ui
  try {
    const [{ diagnose, renderChecks }, { clientDiagEnv }, { buildReport, writeReport }] = await Promise.all([import("./debug/diagnose.js"), import("./debug/client-env.js"), import("./debug/report.js")])
    const env = clientDiagEnv(d.ctx.client, {
      store: d.store,
      pluginVersion: VERSION,
      appVersion: (d.ctx.app as any)?.version,
      location: (d.ctx.location as any)?.directory,
      options: d.options,
      materializeEnabled: d.service.materialize,
    })
    if (report) {
      const { markdown, result } = await buildReport(env, { bot: name })
      const file = writeReport(d.store.root, markdown)
      toast.show({ title: "Report written", message: file, variant: result.ok ? "success" : "warning", duration: 8000 })
      await dialog.alert({ title: result.ok ? "Report written (no errors)" : "Report written (there are errors)", message: `${file}\n\n${clip(renderChecks(result, { onlyProblems: true }), 2000)}` })
    } else {
      await dialog.alert({ title: name ? `Diagnose @${name}` : "Diagnose openbot", message: clip(renderChecks(await diagnose(env, name))) })
    }
  } catch (e) {
    await dialog.alert({ title: "Diagnose failed", message: message(e) })
  }
}
