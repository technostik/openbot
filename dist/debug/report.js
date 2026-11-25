/** Markdown diagnostic report: what to attach to a bug report, or read to understand a failure. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentFilePath } from "../materialize.js";
import { renderTree } from "../files.js";
import { redactBot } from "../redact.js";
import { diagnose } from "./diagnose.js";
import { tailLog } from "./log.js";
const ICON = { ok: "✅", info: "ℹ️", warn: "⚠️", error: "❌" };
export { redactBot };
const fence = (s, lang = "") => "```" + lang + "\n" + s.replace(/```/g, "ʼʼʼ") + "\n```";
function checkLines(checks) {
    return checks.flatMap((c) => [`- ${ICON[c.level]} **${c.title}**`, ...(c.detail ? [`  - ${c.detail}`] : []), ...(c.fix ? [`  - 🔧 ${c.fix}`] : [])]);
}
export async function buildReport(env, opts = {}) {
    const result = await diagnose(env, opts.bot);
    const { store } = env;
    const L = [];
    L.push("# openbot diagnostic report", "");
    L.push(`- Generated: ${new Date().toISOString()}`, `- openbot: ${env.pluginVersion}`, `- opencode: ${env.appVersion ?? "unknown"}`, `- Platform: ${os.platform()} ${os.release()} (${os.arch()}), node ${process.version}`);
    L.push(`- Bot storage: \`${store.root}\``, `- Run from: \`${env.location ?? "unknown"}\``, `- Plugin options: \`${JSON.stringify({ ...env.options, debug: undefined })}\``, "");
    L.push(`## Summary`, "", `**${result.ok ? "No errors" : "There are errors"}** — ${result.counts.error} error(s), ${result.counts.warn} warning(s), ${result.counts.ok} ok`, "");
    const scopes = [...new Set(result.checks.map((c) => c.scope))];
    for (const scope of scopes) {
        L.push(scope === "global" ? "## Global checks" : `## Bot \`${scope}\``, "", ...checkLines(result.checks.filter((c) => c.scope === scope)), "");
        if (scope === "global")
            continue;
        const bot = store.get(scope);
        if (!bot)
            continue;
        L.push("### Configuration (bot.json, secrets redacted)", "", fence(JSON.stringify(redactBot(bot), null, 2), "json"), "");
        L.push("### Master prompt (system.md)", "", fence(bot.instructions.length > 4000 ? bot.instructions.slice(0, 4000) + "\n… (truncated)" : bot.instructions, "markdown"), "");
        L.push(`### Working directory \`${bot.workdir}\``, "", fence(renderTree(bot.workdir, { depth: 3, max: 60 })), "");
        const af = agentFilePath(bot);
        try {
            L.push(`### Native agent file \`${af}\``, "", fence(fs.readFileSync(af, "utf8").split("\n").slice(0, 25).join("\n"), "markdown"), "");
        }
        catch {
            L.push(`### Native agent file`, "", `(none at \`${af}\`)`, "");
        }
        const threads = store.listThreads(scope);
        if (threads.length) {
            L.push("### Conversations", "", "| thread | session | parent | last used |", "| --- | --- | --- | --- |", ...threads.map((t) => `| ${t.key} | ${t.sessionID} | ${t.parentID ?? "-"} | ${t.lastAt} |`), "");
            const ctx = await env.sessionContext(threads[0].sessionID).catch(() => undefined);
            if (ctx?.length) {
                const tail = ctx.slice(-6).map((m) => `${m.type}${m.outcome ? ":" + m.outcome : ""}${m.error?.message ? " — " + m.error.message : ""}${m.text ? " — " + String(m.text).slice(0, 120) : ""}`);
                L.push("Last messages of the most recent conversation:", "", fence(tail.join("\n")), "");
            }
        }
    }
    const log = tailLog(store.root, opts.logLines ?? 60);
    if (log.length)
        L.push("## Debug log (tail)", "", fence(log.join("\n")), "");
    else
        L.push("## Debug log", "", "(empty — enable the `debug` plugin option to record events)", "");
    return { markdown: L.join("\n"), result };
}
export function writeReport(root, markdown) {
    const dir = path.join(root, "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `openbot-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    fs.writeFileSync(file, markdown, "utf8");
    return file;
}
