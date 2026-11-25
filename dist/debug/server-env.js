import { MARKER_AGENT } from "../constants.js";
export function serverDiagEnv(ctx, base) {
    const here = ctx.location?.directory;
    const local = (dir, fn) => (dir === here ? fn() : undefined);
    return {
        ...base,
        appVersion: ctx.app?.version,
        location: here,
        async pluginLoadedAt(dir) {
            return local(dir, () => ctx.agent.list().some((a) => a.id === MARKER_AGENT));
        },
        async agentsAt(dir) {
            return local(dir, () => ctx.agent.list().map((a) => a.id));
        },
        async models() {
            return ctx.model.list().map((m) => `${m.providerID}/${m.id ?? m.modelID}`);
        },
        async defaultModel() {
            return undefined;
        },
        async skillsAt(dir) {
            return local(dir, () => ctx.skill.list().flatMap((s) => [s.name, s.id]));
        },
        async mcpAt(dir) {
            return local(dir, () => ctx.mcp.list().map(([name]) => ({ name })));
        },
        async sessionContext(sessionID) {
            return ctx.session.context({ sessionID });
        },
    };
}
