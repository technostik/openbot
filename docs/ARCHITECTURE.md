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

## Roadmap, and why the PoC is already shaped for it

1. **TUI**: done in v0.2 (Ctrl+P create/inspect, sidebar list, conversations, diagnose/report). Next: bot activity (busy/idle) and a stop button via `session.interrupt`, a usage column from session `tokens`/`cost`. For remote TUIs the plugin RPC (`./rpc`) would replace direct disk reads.
2. **Budget**: sessions report `tokens` and `cost`; add `budget` to `bot.json`, sum per bot, `session.interrupt` when exceeded. `bot_get` already surfaces the numbers.
3. **Automations**: do **not** build a scheduler. Use native automations targeting the bot's session or agent; openbot adds per-bot tagging, a view/edit surface and the "check progress" pattern. `bot.json` gets an optional `automations` section (additive, schema stays 1 or bumps to 2 with a migration).
4. **Telegram**: a server-side bridge in the same plugin (long polling, strict allowlist of user ids) that routes messages to `bot_say` and exposes `bot_notify`. Runs under `opencode serve` for 24/7.
5. **Bot-to-bot**: already works through `bot_say`, with a cycle guard. Next: depth limits, budgets per chain, and the `capabilities` field (reserved in `bot.json`) to grant `bots.create`, other plugins, etc.
6. **Learning / compaction**: a `memory.md` in the bot directory injected through the session compaction hook; the bot curates it at the end of runs.

Schema compatibility rule: `bot.json` only gains **optional** fields; a file with a newer `schema` is refused with a clear message.
