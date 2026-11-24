/** `@botname` handling: detection in a prompt, and the delegation text that replaces it. */

export interface PromptLike {
  text: string
  agents?: readonly { name: string; mention?: { start: number; end: number; text: string } }[]
}

export interface Mention {
  bot: string
  /** The user's message with the mention removed. */
  message: string
}

const LEADING = /^\s*@([a-z][a-z0-9-]{1,31})\b[:,]?\s*/

export function findMention(prompt: PromptLike, isBot: (name: string) => boolean): Mention | undefined {
  for (const a of prompt.agents ?? []) {
    const name = a.name.toLowerCase()
    if (!isBot(name)) continue
    const m = a.mention
    const exact = m && prompt.text.slice(m.start, m.end) === m.text
    const message = exact
      ? prompt.text.slice(0, m.start) + prompt.text.slice(m.end)
      : prompt.text.replace(new RegExp(`@${a.name}\\b`, "i"), "")
    return { bot: name, message: tidy(message) }
  }
  const lead = LEADING.exec(prompt.text)
  if (lead && isBot(lead[1]!)) return { bot: lead[1]!, message: tidy(prompt.text.slice(lead[0].length)) }
  return undefined
}

const tidy = (s: string) => s.replace(/[ \t]{2,}/g, " ").replace(/^[\s,:]+/, "").trim()

/**
 * What the user's own agent receives instead of the raw `@bot ...` text.
 * The agent hands the message to the bot with bot_say and relays the answer.
 */
export function delegationText(mention: Mention): string {
  const body = mention.message || "(the user mentioned you without a message — greet them and ask what they need)"
  return [
    `[openbot] The user is addressing the bot "@${mention.bot}".`,
    `Do not answer yourself. Call the bot_say tool with name "${mention.bot}" and the message below, then relay the bot's answer to the user.`,
    "",
    `Message for @${mention.bot}:`,
    '"""',
    body,
    '"""',
  ].join("\n")
}
