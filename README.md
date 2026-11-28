# openbot

Opencode bot : talk, configure, and act. Automation, alerts, skills, agents, working directory in one place.

openbot is a plugin for [opencode](https://opencode.ai) (v2.4+) that lets you create **named bots**. A bot is an
agent (its own model + master prompt) with its own working directory, its own conversations, and optionally its own
skills and MCP servers, packaged as one exportable entity. Think "tag @grok", but inside opencode and under your control.

> Status: **v0.3, proof of concept.** Everything below is tested against a real opencode 2.4.1 (unit tests, server
> end-to-end tests including a real scheduled run, and the real TUI driven in a terminal). Token budgets and Telegram
> are planned, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The one idea

**A bot is a loop: wake up, read your state, act, write your state.** Everything else is a plain file in the bot's folder:

| File | Role |
| --- | --- |
| `system.md` | who the bot is (its master prompt) |
| `bot.json` | configuration, including its `automations` (schedules) and its `status` |
| `state.md` | its **working memory**: goal, what is important, todo, what it waits for. Shown to the bot at every turn |
| `history/` | every conversation ever had with it, recorded append-only (independent of opencode's own database) |
| `inbox.json` | what the bot wants you to see: alerts and notes |

No separate "memory system": the state file *is* the memory, and the recorded history is the exact record of what happened.
Conversations are disposable; `state.md` is what survives them.

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
| `automations` | `true` | `false` = never create native opencode automations from `bot.json`. |
| `bell` | `true` | Ring the terminal bell when a bot raises an attention alert or asks you a question. |
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
  - **Inbox**: alerts and questions from the bot; read, reply, answer, open the conversation.
  - **Status**: stop, resume, finished. **State**: read it, add a todo or a note.
  - **Automations**: list (with next/last run), add, enable/disable, run now, remove.
  - **Conversations**: open a live one, or *read the recorded history*.
  - **Master prompt**: view, replace, or add an instruction.
  - **Working directory** and **Bot folder** (`system.md`, `state.md`, history, inbox): browse folders and read whole files
    in a scrollable viewer (arrows or `j`/`k`, Space/`b` for pages, `g`/`G` for top/bottom, Esc to close).
  - **Model**, **Permissions**, **Audit log**, **Configuration**, **Delete**; and with `debug`: **Diagnose**, **Generate report**.
- The sidebar shows each bot as `@name (actif|arrêté|terminé|en attente)`, plus `!n` open alerts and `?n` questions.
  `en attente` is shown instead of the lifecycle label while a question is waiting for your answer; it is not stored
  (automations still follow `active` / `stopped` / `finished`). New alerts raise a toast (and for
  `attention`: a desktop notification, a sound and the terminal bell). `Ctrl+P` → **Bots: inbox** (or `/bot-inbox`).

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
| `bot_create` | Create a bot (name, instructions, model, workdir, skills allowlist, MCP servers, permissions) |
| `bot_list` / `bot_get` | List bots / show a bot's config, effective permissions, file paths and conversation stats |
| `bot_update` | Change any field, including permissions; a bot may call it on itself to change its own prompt |
| `bot_say` | Send a message. Default from a conversation: background (answer arrives later). `wait: true` blocks |
| `bot_history` | Read a bot's recorded history (works after the session was deleted); `transcript: true` for readable text |
| `bot_state` | Read or update `state.md` (`read`, `write`, `append`, `replace`) |
| `bot_status` | `active`, `stopped`, `finished` (a bot may only finish itself) |
| `bot_notify` | Alert the user (inbox, toast, notification) without waiting |
| `bot_automation` | `list`, `add`, `update`, `remove`, `enable`, `disable`, `run` scheduled runs |
| `bot_conversations` | List a bot's conversations and where they started |
| `bot_files` | List a bot's working directory, or read a file in it |
| `bot_export` / `bot_import` | Portable bundle (config + prompt + local skills); MCP secrets redacted by default |
| `bot_delete` | Delete a bot (`confirm: true`; a custom workdir is never touched) |
| `bot_diagnose` | *debug only*: check everything a bot needs; `ping: true` sends a real test message; `report: true` writes a report |

### Permissions

Each bot has a permission preset and optional explicit lists, stored in `bot.json` under `capabilities`:

| Preset | Tools | MCP servers | Skills |
| --- | --- | --- | --- |
| `none` | only `bot_*` | none | none |
| `minimal` | `read`, `glob`, `grep`, `bot_*` | none | none |
| `standard` (default) | all | the bot's own | the bot's allowlist (unrestricted if omitted) |
| `full` | all | the bot's own | all |

Explicit `tools`, `denyTools` and `mcps` lists override the preset; `denyTools` always wins. `tools` and `denyTools` use opencode permission actions (`read`, `edit`, `shell`, `bot_*`, `<server>_<tool>`, ...), not tool labels. `mcps` accepts the bot's server keys or their host names (`scout-crm`); `"*"` means all.

The effective rules are injected into the bot's system prompt, its native agent file and the agent registered by openbot. MCP servers the bot may not use are not registered at all. Edit them in the TUI under **Permissions**, or with `bot_update`:

```json
"capabilities": { "preset": "minimal", "tools": ["read", "glob", "grep", "edit"], "mcps": ["crm"] }
```

Sensitive tool use (MCP, third-party plugin tools, `bot_say`) is recorded in `state/audit.jsonl`; read the newest entries in the TUI under **Audit log**, or in `bot_diagnose`.

## Working autonomously

### Status: active, stopped, finished

`bot.json` → `"status"`. Automations run **only while the bot is `active`**.

| Status | Meaning | Who sets it |
| --- | --- | --- |
| `active` | works; its automations are scheduled | you |
| `stopped` | paused by you: running work is interrupted, automations are removed | you |
| `finished` | the goal is achieved: automations are removed (reopen any time) | the bot (`bot_status finished`) or you |

`finished` is optional: a goal that runs forever simply never uses it. A bot can only finish itself; it can never stop or
reopen itself, those stay your decisions.

### Automations

Schedules live in `bot.json` (or are managed with the `bot_automation` tool, by you or by the bot itself, or in the TUI):

```jsonc
"automations": [
  { "id": "scan",    "every": "6 hours", "prompt": "focus on podcasts" },
  { "id": "morning", "cron": "0 9 * * 1-5", "tz": "Europe/Paris" },
  { "id": "once",    "at": "in 10 minutes", "enabled": false }
]
```

Exactly one of `every` ("30 minutes", "6 hours", "1 day"; at least 1 minute), `cron`, or `at` per automation. Each run
prompts the bot **in its own automation conversation** with a standard routine (read your state, do the next useful
thing, update your state, alert the user if needed) plus your `prompt`. openbot keeps native opencode automations in step
with `bot.json` and the bot's status: when the bot is stopped or finished they are removed, so they are simply ignored;
they come back when it is active again. Runs happen on the opencode server, with no terminal UI open.

### The state file

`state.md` is created from a template (Goal, Important, Todo, Waiting for the user, Notes). It is injected into the bot's
prompt at the start of every turn, so it always knows where it stands. The bot updates it with `bot_state`
(`read | write | append | replace`); you can edit the file by hand or add items from the TUI (Bot → State).

### History

Every conversation with a bot (replies to you, automation runs, other bots) is recorded in `history/<session>.jsonl` when
its run ends, and survives opencode deleting or compacting the session. Read it in the TUI (Bot → Conversations → *Read
the recorded history*), as a readable transcript with `bot_history` (`transcript: true`), or browse the files.

### Reaching you ("call me")

All inside opencode, nothing external:

| Mechanism | Use it for | What you get |
| --- | --- | --- |
| the native **`question` tool** | something it must ask and wait for | the run waits; a `?` badge in the sidebar, a notification, and you answer in the TUI (Bots: inbox, or inline in the conversation) |
| **`bot_notify`** (level `info` / `attention`) | tell you without waiting | an entry in the bot's inbox; a toast; `attention` also raises a desktop notification, a sound and the terminal bell |

The inbox is one small file per bot (`inbox.json`): the TUI is the first channel reading it, a Telegram bridge can be the next.
Open items show as `!n` next to the bot in the sidebar; `Ctrl+P` → **Bots: inbox** lists alerts and questions, lets you read,
reply, open the conversation, answer a question or dismiss.

## A bot on disk

```
<openbot home>/bots/scout/
  system.md              # the master prompt: plain markdown, edit it in any editor (the bot may edit it too)
  bot.json               # configuration: description, model, workdir, skills, mcps, capabilities, automations, status
  state.md               # working memory: goal, important, todo (shown to the bot every turn)
  inbox.json             # alerts and notes from the bot to you
  history/               # every conversation, recorded (jsonl + index.json)
  skills/<id>/SKILL.md   # skills that ship with the bot
  state/threads.json     # live conversations (per calling session, plus "auto" for automations)
  state/audit.jsonl      # sensitive tool use (MCP, third-party tools, bot_say), rotated
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
  "mcps": { "crm": { "type": "local", "command": ["node", "crm-server.js"] } },
  "capabilities": { "preset": "standard" }      // omit = standard; see "Permissions"
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
- **A bot has no `bot_state` / `bot_notify` tools, or its automations do not work**: the plugin must be loaded in the bot's
  working directory, which needs a **global** install. Diagnose reports it as an error for bots with automations.
- **Automations do not appear**: needs opencode 2.4+ with automations enabled; Diagnose shows the sync error from the host.
- **A bot's own MCP servers / local skills are missing**: they are registered only where the plugin runs in the bot's
  working directory. Install the plugin globally for bots that use them. Also check **Permissions**: a server not in the
  `mcps` allowlist is deliberately not registered.
- **A tool is denied**: check the bot's **Permissions**. `denyTools` wins over `tools` and the preset; `none` and
  `minimal` deny everything except their allowlist (and `bot_*`). Diagnose prints the effective rules.

## Develop and test

```bash
npm install
npm test               # build + typecheck (server and TSX) + 84 unit tests; no opencode needed
npm i --no-save @opencode/cli@2.4.1              # ~270 MB binary, for the next two only
npm run test:e2e       # real opencode server + plugin + scripted mock LLM; no internet needed
                       # (includes a real scheduled automation run, so it takes a few minutes)
pip install pyte && npm run test:tui             # the real TUI in a pseudo-terminal
```

`dist/` is committed so a clone works as a plugin directly. Rebuild with `npm run build`.

## Known limits (v0.3)

- Remote TUIs: the TUI part reads the bot folder from disk, so it must run on the same machine as the bots.
- `@bot` costs one turn of your own agent (it relays through `bot_say`); the host offers plugins no silent delivery.
- Skills allowlists travel with the native agent file; a bot's own MCP servers and local skills need the plugin loaded in its directory.
- Automation runs of one bot share one automation conversation (opencode compacts it when it grows); the durable memory is `state.md`.
- Scheduled prompt runs need at least 1 minute between them (an opencode limit); desktop notifications follow opencode's own notification settings.
- Not yet: token budgets and Telegram (see docs/ARCHITECTURE.md).
