# openbot architecture

## Principle

**A bot is a directory, projected into opencode.** Everything about a bot lives in one folder (`bot.json`, local
skills, state), so it is exportable, hand-editable, and inspectable. The plugin only *projects* that folder onto
opencode primitives, which keeps the plugin thin and lets every later feature reuse native opencode machinery.

| Bot concept | opencode primitive |
| --- | --- |
| LLM + master prompt | an **agent** (`agent.transform`, mode `all`: selectable with Tab and mentionable) |
| Working directory | the **location** of the bot's session (`session.create({location})`) |
| Conversation | one **child session per calling conversation** (`state/threads.json`), created with `parentID`, then `session.move`d to the bot's workdir before its first run; `main` thread when there is no caller |
| Agent in the bot's workdir | a generated **native agent file** `<workdir>/.opencode/agents/<bot>.md` (works whether or not the plugin is loaded there) |
| Master prompt | `system.md` (plain markdown), composed with a short preamble into the agent's `system` |
| Skills access | permission rules on `skill` (allowlist), plus skills shipped in `skills/` registered via `skill.transform` |
| MCP | `mcp.transform`, namespaced `<bot>-<server>`, registered only where the bot works |
| Talk / configure / inspect | native tools `bot_*` (not Code Mode, so any model can call them) |
| `@bot` | `session.hook("prompt")` rewrites the mention into a `bot_say` delegation |
| TUI | package export `./tui` (TSX loaded by the host): `keymap.layer` commands, `ui.slot` sidebar, `ui.dialog.*`, `ui.router.navigate` |
| Debug | `src/debug/*`, loaded lazily behind one switch (`debug` option / `OPENBOT_DEBUG`) |
| Hand edits / other instances | 2 s signature poll of `bot.json` files, then `agent/mcp/skill.reload()` |

## Verified facts about opencode 2.4.1 (all checked against the real binary)

- A plugin is a **directory package** (`exports["."]`) whose default export is `{ id, setup(ctx) }`. `Plugin.define` is the identity function, so openbot imports **types only** and has zero runtime dependencies.
- `agent.transform(ed => ed.update(id, fn))` **creates** the agent if absent. `setup` can run several times with a cleanup in between: all state is on disk, registration is idempotent.
- Each directory is its own **instance** running its own plugin setup. Hence: global install; agents registered everywhere; MCP/skills only where the bot works.
- `@mention` reaches the prompt hook as structured `agents: [{name, mention}]`; the host does nothing else with it. The hook can mutate `prompt.text`; delivery is only `steer` or `queue` (no silent mode).
- Plugin tools run through **Code Mode by default**; `options.codemode: false` makes them native tools.
- Permission rules are ordered `{action, resource, effect}`, later wins; for `skill` the resource is matched against the skill **id**.
- `session.create` accepts `agent`, `model`, `location`, `metadata`, `permissions`, and returns per-session `tokens` and `cost`.
- opencode 2.4 ships native `automation_*` tools (create/list/pause/resume/delete) and a `subagent` tool.
- **Child sessions**: `session.create({parentID})` puts the child in the *parent's* directory (the `location` is ignored); `session.move({sessionID, directory})` relocates it before its first run (the model then sees `Working directory: <workdir>`), while `session.get` keeps reporting the old location until it has run, so openbot records the workdir in the thread instead of trusting it.
- **Background results**: when a child session finishes, the host delivers a `<background-result kind="subagent">` message to the parent automatically. A blocking `bot_say` from a conversation would deliver twice, hence `bot_say` is asynchronous by default there.
- **Native agent files**: `.opencode/agents/<id>.md` is a full agent definition (`description`, `mode`, `model`, `permissions`, body = system prompt); unknown frontmatter keys (our `x-openbot: managed` marker) are tolerated. A plugin instance in a directory is independent: a project-level install does not load the plugin in a bot's other directory.
- `plugin.list` does not report plugins configured by path, so "is the plugin loaded here?" is answered by a hidden marker agent (`openbot-marker`). Custom providers are not always in `model.list`, so an unlisted model is a warning, not an error. All client `list` calls return `{ location, data }`.
- Skill permission rules match the skill **id** (a bot's own skill is `<bot>.<name>`), so allowlists name both.
- Plugin options: `{ "package": "...", "options": {...} }` in `plugins`; they reach the server plugin (`ctx.options`) and the TUI plugin (`context.options`). Plugin domains inside the server plugin only see their own directory; cross-directory checks use the client (TUI, tests).
- TUI facts: a plugin's TSX is transpiled by the host; `theme.text.muted` is the muted color; the command palette does not open from inside a child-session view.

## v0.3: autonomy, memory, reaching the user

Design principle: **a bot is a loop (wake, read state, act, write state)** and every durable thing is a plain file.

- **Automations are native opencode automations**, reconciled from `bot.json` (`automations`) and `status` by `src/automation.ts`. They are named `openbot:<bot>:<id>` so openbot never touches anyone else's. Stopped and finished bots simply have none (removal, not pausing: the plugin domain only exposes create/list/delete). Reconciliation is idempotent, runs at plugin start, on every `bot.json` change and after status/automation tools, and is serialized across opencode instances by a directory lock.
- **Why prompts into the bot's own session, not a subagent**: a prompt automation targeting a subagent needs a parent session, and the child's result is delivered back to that parent as a background result, which would wake the bot a second time. Prompting the bot's automation conversation (created in its workdir) is one run per tick. A code action also needs a session, so a "script checks the state first" design is not possible.
- **State** is `state.md`, injected into the system prompt on every turn through the `context` hook (`system.push({type:"text"})`), plus the `bot_state` tool (a tool, not file edits, because an unattended run must not stop on an `external_directory` permission prompt).
- **History** is recorded when a bot's run ends (the `experimental.idle` hook, plus at the end of `bot_say`), incrementally by message-id cursor, so it survives compaction and session deletion.
- **Reaching the user**: the native `question` tool already blocks the run and surfaces a form (`form.list`, answered with `session.form.reply`); `bot_notify` writes to `inbox.json`; the TUI watcher turns both into toasts, `attention.notify` (OS notification and sound) and the bell. Telegram will read the same inbox.

Verified host facts for this version (real 2.4.1):
- Automation `create` takes `{ sessionID, name, trigger, action }`; `to` defaults to that session; the directory is the session's. A prompt `every` must be at least 1 minute (code actions 15 seconds); durations are written "90 seconds", "5 minutes", "2 hours". `list` returns a plain array (unlike other list calls). Prompt automations fire on the server with no TUI open; the info carries `status`, `runCount`, `lastOutcome`, `nextDueAt`.
- A `subagent`-targeted prompt and any code action require a session; `to: { session }` is the simple form.
- The host's TUI shows a child session's `question` form inline in the parent conversation you have open (a stray Enter answers it), so the sidebar `?` badge and inbox matter mostly when you are elsewhere. Form fields: `{ key, title (short header), description (the question), options: [{ value, label, description }], custom }`; reply with `answer: { [key]: value }`.
- `session.hook("experimental.idle")` gives `{ sessionID }` when a run ends; `session.hook("context")` exposes `system`, `agent`.
- TUI: `ctx.attention.notify({ title, message, notification, sound })` (top level, not under `ui`), `ui.dialog.show(render)` + `dialog.set({ size })` for custom dialogs, `<scrollbox>` with `scrollBy/scrollTo`, `useKeyboard`. Inside a pseudo-terminal, escape-sequence keys (PgUp/PgDn/End) close the dialog instead of scrolling, so the viewer also answers to plain keys; the scroll box accelerates rapid key repeats.

## Roadmap, and why the PoC is already shaped for it

1. **TUI**: done in v0.2 (Ctrl+P create/inspect, sidebar list, conversations, diagnose/report). Next: bot activity (busy/idle) and a stop button via `session.interrupt`, a usage column from session `tokens`/`cost`. For remote TUIs the plugin RPC (`./rpc`) would replace direct disk reads.
2. **Budget**: sessions report `tokens` and `cost`; add `budget` to `bot.json`, sum per bot, `session.interrupt` when exceeded. `bot_get` already surfaces the numbers.
3. **Automations**: done in v0.3 (native automations, status-gated, state-driven). Next: fresh-conversation-per-run option, run history in the TUI.
4. **Telegram**: a server-side bridge in the same plugin (long polling, strict allowlist of user ids) that reads the same `inbox.json` the TUI reads, routes your replies to `bot_say`, and answers pending questions with `session.form.reply`. Runs under `opencode serve` for 24/7.
5. **Bot-to-bot**: already works through `bot_say`, with a cycle guard. Next: depth limits, budgets per chain, and the `capabilities` field (reserved in `bot.json`) to grant `bots.create`, other plugins, etc.
6. **Learning**: `state.md` already is the curated memory; a possible extra is a notes file the bot consolidates from `history/` (only if state alone proves insufficient).

Schema compatibility rule: `bot.json` only gains **optional** fields; a file with a newer `schema` is refused with a clear message.
