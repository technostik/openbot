# openbot

Opencode bot : talk, configure, and act. Automation, alerts, skills, agents, working directory in one place.

openbot is a plugin for [opencode](https://opencode.ai) (v2.4+) that lets you create **named bots**. A bot is a
persistent agent (model + master prompt) with its own working directory, its own conversation, its own skills and
MCP servers, packaged as one exportable entity. Think "tag @grok", but inside opencode and under your control.

> Status: **proof of concept (v0.1)**. Create, configure, inspect and talk to bots works and is tested against a real
> opencode 2.4.1 server. Budgets, scheduled work, Telegram and TUI panels are planned, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

openbot must be installed **globally**: opencode runs a separate plugin instance per directory, and a bot's working
directory must know the bot too.

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": ["/absolute/path/to/openbot"]   // a clone of this repo, built (dist/ is committed)
}
```

Optional plugin options (object form): `{ "package": "/path/to/openbot", "options": { "root": "~/my-bots" } }`.
Bots are stored under `$OPENBOT_HOME`, else `$XDG_DATA_HOME/openbot`, else `~/.local/share/openbot`.

## Use

Ask any opencode agent in plain language, it calls the `bot_*` tools:

```
Create a bot named "scout" whose job is to find potential business partners on the web
and keep a simple CRM in crm.md. Use model anthropic/claude-sonnet-4-5.
```

Then:

```
@scout look for 5 podcast hosts in the agentic coding space and add them to the CRM
```

`@scout` hands your message to the bot. The bot works in **its own working directory**, in **its own persistent
conversation** (it remembers earlier messages), and its answer comes back to you. You can also pick the bot as the
active agent with Tab, or ask your agent to use `bot_say`.

The bot can reconfigure itself ("from now on, also track company size"): it calls `bot_update` on itself. A bot can
only change its own configuration, never another bot's.

| Tool | What it does |
| --- | --- |
| `bot_create` | Create a bot (name, instructions, model, workdir, skills allowlist, MCP servers) |
| `bot_list` / `bot_get` | List bots / show a bot's full config and conversation stats (tokens, cost) |
| `bot_update` | Change any field; a bot may call it on itself |
| `bot_say` | Send a message and get the answer; `wait:false` lets the bot work in the background |
| `bot_history` | Inspect the bot's recent conversation (messages, tools used, outcome) |
| `bot_export` / `bot_import` | Portable bundle (config + local skills); MCP secrets redacted by default |
| `bot_delete` | Delete a bot (requires `confirm: true`; a custom workdir is never touched) |

## A bot on disk

```
<openbot home>/bots/scout/
  bot.json          # the configuration (hand-editable, picked up within ~2 s)
  skills/<id>/SKILL.md   # skills that ship with the bot (visible only in the bot's workdir)
  state/session.json     # the bot's persistent conversation id
  workspace/             # default working directory (unless you chose another)
```

```jsonc
// bot.json (only "name" and "instructions" are required)
{
  "schema": 1,
  "name": "scout",
  "description": "Finds business partners",
  "model": "anthropic/claude-sonnet-4-5",      // omit = opencode's default model
  "instructions": "You find potential business partners... Keep a CRM in crm.md.",
  "workdir": "/home/me/crm",
  "skills": ["web-research"],                    // allowlist; omit = unrestricted, [] = none
  "mcps": { "crm": { "type": "local", "command": ["node", "crm-server.js"] } }
}
```

## Develop and test

```bash
npm install
npm test                 # build + 23 unit tests, no opencode needed
npm i --no-save @opencode/cli@2.4.1   # ~270 MB binary, only for the e2e test
npm run test:e2e         # real opencode server + plugin + scripted mock LLM, no internet needed
```

`dist/` is committed so the repo can be used as a plugin straight from a clone. Rebuild with `npm run build`.

## Known limits (v0.1)

- MCP servers and local skills of a bot are registered only in the bot's working-directory instance. Other agents running
  in that same directory can see them too (no hard isolation yet).
- A bot without a `model` needs a default model configured in opencode, otherwise its run has nothing to execute on
  (`bot_say` then times out after 5 minutes).
- `@bot` routing costs one turn of your own agent (it relays through `bot_say`); the host gives plugins no silent delivery.
- Installing through `opencode plugin add <git-url>` is untested; use the config path above.
