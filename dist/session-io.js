const textOf = (m) => Array.isArray(m?.content)
    ? m.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("")
    : typeof m?.text === "string"
        ? m.text
        : "";
/** Reads what happened in `messages` after the message `afterId`. */
export function extractReply(messages, afterId) {
    const i = messages.findIndex((m) => m?.id === afterId);
    const tail = i >= 0 ? messages.slice(i + 1) : messages.filter((m) => typeof m?.id === "string" && m.id > afterId);
    const idle = tail.find((m) => m?.type === "idle");
    const assistants = tail.filter((m) => m?.type === "assistant");
    const withText = [...assistants].reverse().find((m) => textOf(m).trim());
    return {
        done: Boolean(idle),
        outcome: idle?.outcome,
        error: idle?.error?.message,
        text: withText ? textOf(withText).trim() : "",
        steps: assistants.length,
    };
}
/** Compact, model-friendly view of the last `limit` messages. */
export function summarizeMessages(messages, limit, maxChars = 400) {
    const clip = (s) => (s.length > maxChars ? s.slice(0, maxChars) + "…" : s);
    return messages.slice(-limit).map((m) => {
        const at = m?.time?.created;
        if (m?.type === "user")
            return { type: "user", text: clip(String(m.text ?? "")), at };
        if (m?.type === "idle")
            return { type: "idle", outcome: m.outcome, ...(m.error?.message ? { error: m.error.message } : {}), at };
        if (m?.type === "assistant") {
            const tools = Array.isArray(m.content)
                ? m.content.filter((p) => p?.type && p.type !== "text" && p.type !== "reasoning").map((p) => String(p.name ?? p.tool ?? p.type))
                : [];
            const text = textOf(m);
            return { type: "assistant", ...(text ? { text: clip(text) } : {}), ...(tools.length ? { tools } : {}), at };
        }
        return { type: String(m?.type ?? "unknown"), at };
    });
}
/** Returns the id of the bot's live session, creating one in its workdir if needed. */
export async function ensureSession(port, store, bot, opts = {}) {
    const state = store.readState(bot.name);
    if (state.sessionID && !opts.fresh) {
        try {
            const s = await port.get({ sessionID: state.sessionID });
            const dir = s?.location?.directory;
            if (!dir || dir === bot.workdir)
                return state.sessionID;
        }
        catch {
            /* session was deleted: fall through and create a new one */
        }
    }
    const s = await port.create({
        agent: bot.name,
        title: `bot:${bot.name}`,
        location: { directory: bot.workdir },
        metadata: { openbot: { bot: bot.name } },
    });
    store.writeState(bot.name, { sessionID: s.id, sessionCreatedAt: new Date().toISOString() });
    return s.id;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function say(port, store, bot, message, opts = {}) {
    const sessionID = await ensureSession(port, store, bot, { fresh: opts.fresh });
    const sent = await port.prompt({ sessionID, text: message, delivery: "queue" });
    if (opts.wait === false)
        return { sessionID, status: "started", text: "" };
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    const pollMs = opts.pollMs ?? 400;
    let aborted = false;
    const onAbort = () => {
        aborted = true;
        void port.interrupt({ sessionID }).catch(() => { });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
        while (Date.now() < deadline) {
            if (aborted)
                return { sessionID, status: "interrupted", text: "" };
            const left = deadline - Date.now();
            await Promise.race([port.wait({ sessionID }).catch(() => { }), sleep(Math.min(left, 5_000))]);
            const reply = extractReply(await port.context({ sessionID }), sent.id);
            if (reply.done) {
                const failed = reply.outcome === "failed";
                return {
                    sessionID,
                    status: failed ? "failed" : "done",
                    text: reply.text,
                    steps: reply.steps,
                    ...(failed ? { error: reply.error ?? "the run failed" } : {}),
                };
            }
            await sleep(pollMs);
        }
        return { sessionID, status: "timeout", text: "" };
    }
    finally {
        opts.signal?.removeEventListener("abort", onAbort);
    }
}
