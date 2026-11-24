import { applyAgents, applyWorkdirMcp, applyWorkdirSkills, newOwned } from "./host.js";
import { delegationText, findMention } from "./mention.js";
import { resolveRoot } from "./paths.js";
import { BotStore } from "./store.js";
import { buildTools } from "./tools.js";
const POLL_MS = 2000;
const openbot = {
    id: "openbot",
    setup: async (ctx) => {
        const store = new BotStore(resolveRoot(ctx.options));
        const location = ctx.location.directory;
        const owned = newOwned();
        const env = { skillsDir: (name) => store.skillsDir(name) };
        const disposers = [];
        disposers.push(await ctx.agent.transform((ed) => applyAgents(ed, store.list(), owned, env)));
        disposers.push(await ctx.mcp.transform((ed) => applyWorkdirMcp(location, store.list(), ed, owned)));
        disposers.push(await ctx.skill.transform((ed) => applyWorkdirSkills(location, store.list(), ed, owned, env)));
        const reload = async () => {
            await ctx.agent.reload();
            await ctx.mcp.reload();
            await ctx.skill.reload();
        };
        disposers.push(await ctx.tool.transform((ed) => {
            for (const tool of buildTools({ store, session: ctx.session, reload }))
                ed.add(tool);
        }));
        // `@bot ...` in the user's prompt becomes an instruction to hand the message to the bot.
        disposers.push(await ctx.session.hook("prompt", (p) => {
            const mention = findMention(p.prompt, (n) => store.exists(n));
            if (!mention)
                return;
            if (store.readState(mention.bot).sessionID === p.sessionID)
                return; // already inside the bot's own conversation
            p.prompt.text = delegationText(mention);
            p.metadata = { ...(p.metadata ?? {}), openbot: { mention: mention.bot } };
        }));
        // Hand edits of bot.json (or edits from another instance) are picked up here.
        let signature = store.signature();
        const timer = setInterval(() => {
            const now = store.signature();
            if (now === signature)
                return;
            signature = now;
            void reload().catch(() => { });
        }, POLL_MS);
        timer.unref?.();
        return async () => {
            clearInterval(timer);
            for (const d of disposers)
                await d.dispose();
        };
    },
};
export default openbot;
