/**
 * Bot automations. bot.json lists them (`automations`); while the bot is
 * `active` each enabled one exists as a native opencode automation that
 * prompts the bot's own automation conversation. When the bot is stopped or
 * finished they are removed, so nothing runs ("simply ignored"); they come
 * back when it is active again. All reconciliation is idempotent.
 */
import fs from "node:fs"
import path from "node:path"
import type { BotStore } from "./store.js"
import type { AutomationSpec, BotConfig } from "./types.js"

export const AUTO_PREFIX = "openbot:"
export const nativeName = (bot: string, id: string) => `${AUTO_PREFIX}${bot}:${id}`

export const isScheduled = (bot: BotConfig, spec: AutomationSpec): boolean => (bot.status ?? "active") === "active" && spec.enabled !== false

/** The prompt each scheduled run starts with. */
export function standardPrompt(bot: Pick<BotConfig, "name">, spec: AutomationSpec): string {
  return [
    `[openbot automation "${spec.id}"] Scheduled run for ${bot.name}. Nobody is watching right now.`,
    "1. Your state (state.md) is shown in your context: review it first.",
    "2. Do the next most useful work toward your goals, in your working directory.",
    "3. Update your state with bot_state: what you did, what comes next, what is waiting.",
    '4. If you need the user: bot_notify to alert them, or the question tool to ask and wait for an answer. If your goal is fully achieved, call bot_status with status "finished" (skip this if the goal never ends).',
    ...(spec.prompt ? ["", spec.prompt] : []),
  ].join("\n")
}

export function toNativeInput(bot: BotConfig, spec: AutomationSpec, sessionID: string) {
  const trigger = spec.every ? { type: "every", every: spec.every } : spec.cron ? { type: "cron", cron: spec.cron } : { type: "at", at: spec.at! }
  return {
    sessionID,
    name: nativeName(bot.name, spec.id),
    trigger: { ...trigger, ...(spec.tz ? { tz: spec.tz } : {}) },
    action: { type: "prompt", prompt: standardPrompt(bot, spec) },
    ...(spec.expires ? { expires: spec.expires } : {}),
  }
}

const triggerValue = (t: any): string => `${t?.type}:${t?.every ?? t?.cron ?? t?.at ?? ""}`

/** Is an existing native automation the same as what we would create? */
export function sameAutomation(info: any, input: ReturnType<typeof toNativeInput>): boolean {
  return (
    triggerValue(info?.trigger) === triggerValue(input.trigger) &&
    info?.action?.type === "prompt" &&
    info?.action?.prompt === input.action.prompt &&
    (info?.action?.to?.session ?? info?.sessionID) === input.sessionID
  )
}

export interface NativeAutomations {
  list(): Promise<any[]>
  create(input: any): Promise<any>
  remove(id: string): Promise<void>
}

export interface ReconcileDeps {
  store: BotStore
  native: NativeAutomations
  /** The bot's automation conversation (created in its workdir when missing). */
  ensureAutoSession(bot: BotConfig): Promise<string>
  log?: (event: string, data?: unknown) => void
}

export interface ReconcileReport {
  created: string[]
  removed: string[]
  kept: string[]
  errors: Array<{ name: string; error: string }>
  skipped?: "locked"
}

/** Cross-instance lock (every opencode directory runs its own copy of the plugin). */
export function withLock<T>(store: BotStore, fn: () => Promise<T>): Promise<T | undefined> {
  const lock = path.join(store.root, "state", "automation.lock")
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  try {
    fs.mkdirSync(lock)
  } catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
        fs.rmSync(lock, { recursive: true, force: true })
        fs.mkdirSync(lock)
      } else return Promise.resolve(undefined)
    } catch {
      return Promise.resolve(undefined)
    }
  }
  return fn().finally(() => fs.rmSync(lock, { recursive: true, force: true }))
}

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { created: [], removed: [], kept: [], errors: [] }
  const run = await withLock(deps.store, async () => {
    const bots = deps.store.list()
    const desired = new Map<string, { bot: BotConfig; spec: AutomationSpec }>()
    for (const bot of bots) for (const spec of bot.automations ?? []) if (isScheduled(bot, spec)) desired.set(nativeName(bot.name, spec.id), { bot, spec })

    const existing = (await deps.native.list()).filter((a) => typeof a?.name === "string" && a.name.startsWith(AUTO_PREFIX))
    const byName = new Map<string, any[]>()
    for (const a of existing) byName.set(a.name, [...(byName.get(a.name) ?? []), a])

    const sessions = new Map<string, string>()
    const sessionFor = async (bot: BotConfig) => {
      if (!sessions.has(bot.name)) sessions.set(bot.name, await deps.ensureAutoSession(bot))
      return sessions.get(bot.name)!
    }
    const remove = async (a: any) => {
      try {
        await deps.native.remove(a.id)
        report.removed.push(a.name)
      } catch (e) {
        report.errors.push({ name: a.name, error: (e as Error).message })
      }
    }

    for (const [name, list] of byName) {
      const want = desired.get(name)
      if (!want) { for (const a of list) await remove(a); continue }
      try {
        const input = toNativeInput(want.bot, want.spec, await sessionFor(want.bot))
        const keep = list.find((a) => sameAutomation(a, input))
        if (!keep) { for (const a of list) await remove(a); continue }
        for (const extra of list.filter((a) => a !== keep)) await remove(extra)
        report.kept.push(name)
      } catch (e) {
        report.errors.push({ name, error: (e as Error).message })
      }
    }
    for (const [name, { bot, spec }] of desired) {
      if (report.kept.includes(name)) continue
      try {
        await deps.native.create(toNativeInput(bot, spec, await sessionFor(bot)))
        report.created.push(name)
      } catch (e) {
        report.errors.push({ name, error: (e as Error).message })
      }
    }
    return true
  })
  if (run === undefined) report.skipped = "locked"
  if (!report.skipped) {
    deps.log?.("automations", report)
    for (const bot of deps.store.list()) {
      const mine = report.errors.filter((e) => e.name.startsWith(`${AUTO_PREFIX}${bot.name}:`))
      const f = path.join(deps.store.botDir(bot.name), "state", "automation.json")
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), errors: mine }, null, 2) + "\n")
      } catch {
        /* best effort */
      }
    }
  }
  return report
}

/** Native automations of one bot, for display (next run, run count, last outcome). */
export async function describeAutomations(native: Pick<NativeAutomations, "list">, bot: BotConfig) {
  let infos: any[] = []
  try {
    infos = await native.list()
  } catch {
    /* host may have automations off */
  }
  return (bot.automations ?? []).map((spec) => {
    const info = infos.find((a) => a?.name === nativeName(bot.name, spec.id))
    return {
      ...spec,
      scheduled: isScheduled(bot, spec),
      native: info ? { status: info.status, nextDueAt: info.nextDueAt, runCount: info.runCount, lastRunAt: info.lastRunAt, lastOutcome: info.lastOutcome } : null,
    }
  })
}
