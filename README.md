# openbot

Opencode bot : talk, configure, and act. Automation, alerts, skills, agents, working directory in one place.

openbot is a plugin for [opencode](https://opencode.ai) (v2.4+) that lets you create **named bots**. A bot is an
agent (its own model + master prompt) with its own working directory, its own conversations, and optionally its own
skills and MCP servers, packaged as one exportable entity. Think "tag @grok", but inside opencode and under your control.

> Status: **v0.2, proof of concept.** Everything below is tested against a real opencode 2.4.1 (unit tests, server
> end-to-end tests, and the real TUI driven in a terminal). Budgets, scheduled work and Telegram are planned,
> see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

Add the plugin to an `opencode.json`. **Global** (`~/.config/opencode/opencode.json`) is the recommended scope; a
project-level install also works for talking to bots (see Troubleshooting).

```jsonc
{
  "plugins": ["/absolute/path/to/openbot"]          // a clone of this repo; dist/ is committed, no build needed
}
```

With options (all optional):

```jsonc
{
  "plugins": [
    { "package": "/absolute/path/to/openbot", "options": { "debug": true } }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `debug` | `false` | Turns on the debug package: `bot_diagnose` tool, TUI diagnose/report commands, debug log. Also `OPENBOT_DEBUG=1`. |
| `materialize` | `true` | Write each bot's native agent file into its working directory (see below). |
| `root` | see below | Where bots are stored. |

Bots live in `$OPENBOT_HOME`, else `$XDG_DATA_HOME/openbot`, else `~/.local/share/openbot`. The terminal UI reads the
same folder, so make sure both see the same value (set `root` in the plugin options to be certain).

The same entry also loads the **terminal part** (Ctrl+P commands, sidebar): opencode picks up the package's `./tui`
export automatically. Restart opencode (or `/reload`) after editing the config.

## Use

**In the terminal UI**

- `Ctrl+P` → **Create bot**: name, role (master prompt), model, working directory.
- The session sidebar lists your bots under **Bots**. `Ctrl+P` → **Bots: inspect, edit, conversations** (or `/bots`):
  - **Conversations**: every place the bot was used. Pick one to open it.
  - **Master prompt**: view, replace, or add an instruction.
  - **Working directory**: browse the files and read them.
  - **Model**, **Configuration**, **Delete**; and with `debug`: **Diagnose**, **Generate report**.

**In a prompt**

```
@scout find 5 podcast hosts in the agentic coding space and add them to crm.md
```

Your own agent hands the message to the bot and tells you it is in progress. The bot works in the background, in its own
directory and with its own model; its answer arrives in your conversation when it finishes. You can also ask any agent
in plain language ("create a bot named scout that…"): it uses the `bot_*` tools below.

### How talking to a bot works (and how it relates to opencode's `subagent` tool)

Both end up as **a separate conversation running the bot's agent, so with the bot's own model**, shown as a child
session of the conversation that used it, with the answer delivered back automatically as a background result.

| | opencode's built-in `subagent` tool | openbot's `bot_say` (what `@bot` uses) |
| --- | --- | --- |
| Runs in | the directory you are in | **the bot's own working directory** |
| Conversation | new one each time (unless you pass its session id) | **one per calling conversation, continued next time** |
| Callable without a conversation (automations, Telegram later) | no | yes (a "main" conversation) |
| The bot's skills allowlist / own MCP / local skills | partly | yes, where the plugin runs in the bot's directory |

You can use either; bots are normal agents, so `subagent` with `agent: "scout"` also works.

### Tools

| Tool | What it does |
| --- | --- |
| `bot_create` | Create a bot (name, instructions, model, workdir, skills allowlist, MCP servers) |
| `bot_list` / `bot_get` | List bots / show a bot's config, file paths and conversation stats |
| `bot_update` | Change any field; a bot may call it on itself to change its own prompt |
| `bot_say` | Send a message. Default from a conversation: background (answer arrives later). `wait: true` blocks |
| `bot_history` | Read a bot's conversation (messages, tools used, outcome) |
| `bot_conversations` | List a bot's conversations and where they started |
| `bot_files` | List a bot's working directory, or read a file in it |
| `bot_export` / `bot_import` | Portable bundle (config + prompt + local skills); MCP secrets redacted by default |
| `bot_delete` | Delete a bot (`confirm: true`; a custom workdir is never touched) |
| `bot_diagnose` | *debug only*: check everything a bot needs; `ping: true` sends a real test message; `report: true` writes a report |

## A bot on disk

```
<openbot home>/bots/scout/
  system.md              # the master prompt: plain markdown, edit it in any editor (the bot may edit it too)
  bot.json               # configuration: description, model, workdir, skills, mcps
  skills/<id>/SKILL.md   # skills that ship with the bot
  state/threads.json     # the bot's conversations
  workspace/             # default working directory
<its working directory>/.opencode/agents/scout.md   # generated native agent file (do not edit)
```

```jsonc
// bot.json (only "name" is required in the file; the prompt is system.md)
{
  "schema": 1,
  "name": "scout",
  "description": "Finds business partners",
  "model": "anthropic/claude-sonnet-4-5",     // omit = opencode's default model
  "workdir": "/home/me/crm",
  "skills": ["web-research"],                   // allowlist; omit = unrestricted, [] = none
  "mcps": { "crm": { "type": "local", "command": ["node", "crm-server.js"] } }
}
```

Edits to `system.md` or `bot.json` (by you, a bot, or the TUI) are picked up within about 2 seconds. Bots created by v0.1
(prompt inside `bot.json`) are migrated to `system.md` automatically.

**Why the generated agent file?** opencode treats a bot's working directory as a separate instance, and the plugin is
not necessarily loaded there (depends on where you installed it). A plain native agent file in the bot's directory
makes the bot work there regardless. openbot only ever writes or deletes files carrying its marker.

## Debugging

Set `debug: true` (or `OPENBOT_DEBUG=1`). Then:

- **`bot_diagnose`** (tool) and **Bots: diagnose** (Ctrl+P): checks the model, master prompt, working directory, agent
  file, agent visibility in the bot's directory, skills, MCP commands, and the last run's outcome, each with a fix.
- **Bots: generate diagnostic report** (Ctrl+P) or `bot_diagnose` with `report: true`: a markdown file under
  `<openbot home>/reports/` with versions, checks, each bot's config (secrets redacted), prompt, files, conversations
  and the debug-log tail. Attach it to a bug report.
- **Debug log**: `<openbot home>/logs/openbot.log` (JSON lines: setup, reloads, tool calls, mentions).
- `bot_diagnose` with `ping: true` sends one real message to the bot: the end-to-end test.

With `debug` off (default) none of this exists: the code is in `src/debug/` and is only loaded when switched on.

## Troubleshooting

- **`Agent not found: "<bot>"`**: the bot's agent is unknown where it runs. Keep `materialize` on (default) and `/reload`;
  run Diagnose to see which check fails. Fixed since v0.2 for project-only installs.
- **The bot never answers / `bot_say` times out**: the bot has no model and opencode has no default model. Diagnose says
  so; set a model (TUI → Model, or `bot_update`).
- **No "Bots" in the sidebar**: the plugin is not in the config the TUI uses, or `root` differs between the server and the
  TUI. Check Diagnose, and set `root` explicitly.
- **A bot's own MCP servers / local skills are missing**: they are registered only where the plugin runs in the bot's
  working directory. Install the plugin globally for bots that use them.

## Develop and test

```bash
npm install
npm test               # build + typecheck (server and TSX) + 49 unit tests; no opencode needed
npm i --no-save @opencode/cli@2.4.1              # ~270 MB binary, for the next two only
npm run test:e2e       # real opencode server + plugin + scripted mock LLM; no internet needed
pip install pyte && npm run test:tui             # the real TUI in a pseudo-terminal
```

`dist/` is committed so a clone works as a plugin directly. Rebuild with `npm run build`.

## Known limits (v0.2)

- Remote TUIs: the TUI part reads the bot folder from disk, so it must run on the same machine as the bots.
- `@bot` costs one turn of your own agent (it relays through `bot_say`); the host offers plugins no silent delivery.
- Skills allowlists travel with the native agent file; a bot's own MCP servers and local skills need the plugin loaded in its directory.
- Not yet: budgets, automations, Telegram (see docs/ARCHITECTURE.md).
