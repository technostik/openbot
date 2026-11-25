/**
 * DiagEnv built from an OpenCode client (the TUI's `context.client`, or the
 * generated client in tests). Every list call answers `{ location, data: [...] }`.
 */
import type { BotStore } from "../store.js"
import { MARKER_AGENT } from "../constants.js"
import type { DiagEnv } from "./diagnose.js"

export { MARKER_AGENT } from "../constants.js"

const data = (o: any): any[] => (Array.isArray(o) ? o : Array.isArray(o?.data) ? o.data : [])

export function clientDiagEnv(client: any, base: { store: BotStore; pluginVersion: string; appVersion?: string; location?: string; options?: Record<string, unknown>; materializeEnabled: boolean }): DiagEnv {
  const at = (directory?: string) => (directory ? { location: { directory } } : undefined)
  return {
    ...base,
    async pluginLoadedAt(directory) {
      return data(await client.agent.list(at(directory))).some((a) => a.id === MARKER_AGENT)
    },
    async agentsAt(directory) {
      return data(await client.agent.list(at(directory))).map((a) => a.id)
    },
    async models() {
      return data(await client.model.list(at(base.location))).map((m) => `${m.providerID}/${m.modelID ?? m.id}`)
    },
    async defaultModel() {
      const d = (await client.model.default(at(base.location)))?.data
      return d ? `${d.providerID}/${d.modelID ?? d.id}` : undefined
    },
    async skillsAt(directory) {
      return data(await client.skill.list(at(directory))).flatMap((s) => [s.name, s.id])
    },
    async mcpAt(directory) {
      return data(await client.mcp.list(at(directory))).map((m) => ({ name: m.name ?? m.id, status: m.status?.type ?? m.status, error: m.error }))
    },
    async sessionContext(sessionID) {
      return client.session.context({ sessionID })
    },
  }
}
