/**
 * openbot — named, configurable bots for opencode.
 *
 * A bot is a directory on disk (bot.json + local skills + state) that this
 * plugin projects into opencode as an agent (so it has a model and a master
 * prompt), a persistent session in the bot's working directory, optional MCP
 * servers and skills, and a set of bot_* tools to create, configure, inspect
 * and talk to bots.
 *
 * Every opencode "location" (directory) runs its own copy of this plugin, so
 * install it globally: that way a bot's working directory also knows the bot.
 */
import type { Plugin } from "@opencode/plugin";
declare const openbot: Plugin.Plugin;
export default openbot;
