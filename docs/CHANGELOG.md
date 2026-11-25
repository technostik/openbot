# Changelog

## 0.2.0
- Fix: `bot_say` no longer fails with `Agent not found` when the plugin is only installed at project level: every bot writes a native agent file into its working directory.
- Bot conversations are child sessions of the conversation that used the bot (one per calling conversation), running in the bot's working directory with its own model; the answer comes back as a background result. `bot_say` is asynchronous by default from a conversation (`wait: true` to block).
- Master prompt moved to an editable `system.md` (v0.1 bots migrate automatically); the bot is told where it lives and may edit it.
- New tools: `bot_conversations`, `bot_files`; `bot_history` can read any conversation.
- Terminal UI: Ctrl+P create/inspect, sidebar list, conversations, master prompt, working directory browser, model change, delete.
- Optional debug package (off by default): `bot_diagnose` (with `ping`/`report`), TUI diagnose and report generator, debug log.

## 0.1.0
- First proof of concept: bots as agents, `bot_*` tools, `@bot` routing, export/import, hand-editable `bot.json`.
