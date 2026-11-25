/**
 * Bot operations shared by the server tools and the TUI. Every change goes
 * through here so that the on-disk bot and its materialized agent file never
 * drift apart.
 */
import { dematerialize, materialize, type MaterializeEnv, type MaterializeResult } from "./materialize.js"
import { importBundle, importFromFile, type ImportOptions } from "./bundle.js"
import type { BotStore } from "./store.js"
import type { BotConfig, BotInput, BotPatch } from "./types.js"

export interface Service {
  store: BotStore
  /** Write native agent files into bot workdirs (default true). */
  materialize: boolean
  log: (event: string, data?: unknown) => void
}

export const makeService = (store: BotStore, opts: { materialize?: boolean; log?: Service["log"] } = {}): Service => ({
  store,
  materialize: opts.materialize !== false,
  log: opts.log ?? (() => {}),
})

export const materializeEnv = (store: BotStore): MaterializeEnv => ({
  skillsDir: (n) => store.skillsDir(n),
  systemFile: (n) => store.systemPath(n),
})

export function syncAgentFile(svc: Service, bot: BotConfig): MaterializeResult | undefined {
  if (!svc.materialize) return undefined
  const r = materialize(bot, materializeEnv(svc.store))
  if (r.status !== "unchanged") svc.log("materialize", { bot: bot.name, ...r })
  return r
}

export function createBot(svc: Service, input: BotInput): BotConfig {
  const bot = svc.store.create(input)
  syncAgentFile(svc, bot)
  return bot
}

export function updateBot(svc: Service, name: string, patch: BotPatch): { bot: BotConfig; before: BotConfig } {
  const before = svc.store.require(name)
  const bot = svc.store.update(name, patch)
  if (svc.materialize && bot.workdir !== before.workdir) dematerialize(before)
  syncAgentFile(svc, bot)
  return { bot, before }
}

export function deleteBot(svc: Service, name: string): BotConfig {
  const bot = svc.store.delete(name)
  if (svc.materialize) dematerialize(bot)
  return bot
}

export function importBot(svc: Service, source: { file: string } | { bundle: unknown }, opts: ImportOptions = {}) {
  const r = "file" in source ? importFromFile(svc.store, source.file, opts) : importBundle(svc.store, source.bundle, opts)
  syncAgentFile(svc, r.bot)
  return r
}

/** At startup / after an external change: migrate legacy bots and refresh every agent file. */
export function syncAll(svc: Service): { migrated: string[]; results: MaterializeResult[] } {
  const migrated = svc.store.migrate()
  const results = svc.materialize ? svc.store.list().map((b) => syncAgentFile(svc, b)!).filter(Boolean) : []
  return { migrated, results }
}
