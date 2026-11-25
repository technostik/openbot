/** DiagEnv for the server plugin: only the current directory is visible from here. */
import type { BotStore } from "../store.js"
import type { DiagEnv } from "./diagnose.js"
import { MARKER_AGENT } from "../constants.js"

export function serverDiagEnv(ctx: any, base: { store: BotStore; pluginVersion: string; options?: Record<string, unknown>; materializeEnabled: boolean }): DiagEnv {
  const here = ctx.location?.directory as string
  const local = <T>(dir: string, fn: () => T): T | undefined => (dir === here ? fn() : undefined)
  return {
    ...base,
    appVersion: ctx.app?.version,
    location: here,
    async pluginLoadedAt(dir) {
      return local(dir, () => ctx.agent.list().some((a: any) => a.id === MARKER_AGENT))
    },
    async agentsAt(dir) {
      return local(dir, () => ctx.agent.list().map((a: any) => a.id as string))
    },
    async models() {
      return ctx.model.list().map((m: any) => `${m.providerID}/${m.id ?? m.modelID}`)
    },
    async defaultModel() {
      return undefined
    },
    async skillsAt(dir) {
      return local(dir, () => ctx.skill.list().flatMap((s: any) => [s.name, s.id]))
    },
    async mcpAt(dir) {
      return local(dir, () => ctx.mcp.list().map(([name]: [string, unknown]) => ({ name })))
    },
    async sessionContext(sessionID) {
      return ctx.session.context({ sessionID })
    },
  }
}
