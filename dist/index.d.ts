/**
 * openbot — named, configurable bots for opencode.
 *
 * A bot is a directory on disk (bot.json + system.md + local skills + state)
 * that this plugin projects into opencode as an agent (model + master prompt),
 * a native agent file in the bot's working directory, persistent conversations
 * that appear as child sessions of where the bot was used, optional MCP
 * servers and skills, and bot_* tools to create, configure, inspect and talk to bots.
 */
import type { Plugin } from "@opencode/plugin";
declare const openbot: Plugin.Plugin;
export default openbot;
