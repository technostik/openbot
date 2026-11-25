import { MARKER_AGENT } from "../constants.js";
export { MARKER_AGENT } from "../constants.js";
const data = (o) => (Array.isArray(o) ? o : Array.isArray(o?.data) ? o.data : []);
export function clientDiagEnv(client, base) {
    const at = (directory) => (directory ? { location: { directory } } : undefined);
    return {
        ...base,
        async pluginLoadedAt(directory) {
            return data(await client.agent.list(at(directory))).some((a) => a.id === MARKER_AGENT);
        },
        async agentsAt(directory) {
            return data(await client.agent.list(at(directory))).map((a) => a.id);
        },
        async models() {
            return data(await client.model.list(at(base.location))).map((m) => `${m.providerID}/${m.modelID ?? m.id}`);
        },
        async defaultModel() {
            const d = (await client.model.default(at(base.location)))?.data;
            return d ? `${d.providerID}/${d.modelID ?? d.id}` : undefined;
        },
        async skillsAt(directory) {
            return data(await client.skill.list(at(directory))).flatMap((s) => [s.name, s.id]);
        },
        async mcpAt(directory) {
            return data(await client.mcp.list(at(directory))).map((m) => ({ name: m.name ?? m.id, status: m.status?.type ?? m.status, error: m.error }));
        },
        async sessionContext(sessionID) {
            return client.session.context({ sessionID });
        },
    };
}
