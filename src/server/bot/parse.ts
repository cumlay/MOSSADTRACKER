/**
 * Command parsing for the prefix bot.
 *
 * Kept as a pure function so the grammar can be tested without a Discord connection.
 * Bedrock gamertags contain spaces ("tuff corlay"), so a bare trailing value is taken
 * whole rather than split on whitespace.
 */

export interface ParsedCommand {
  command: string
  /** Named arguments, e.g. `player:"tuff corlay"` -> { player: 'tuff corlay' }. */
  args: Record<string, string>
  /** Everything after the command that was not a named argument. */
  rest: string
}

const NAMED = /(\w+)\s*:\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g

export function parseCommand(content: string, prefix = '.'): ParsedCommand | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith(prefix)) return null

  const body = trimmed.slice(prefix.length)
  const match = /^(\w+)\s*([\s\S]*)$/.exec(body)
  if (!match) return null

  const [, command, tail = ''] = match
  const args: Record<string, string> = {}

  const rest = tail
    .replace(NAMED, (_full, key: string, dq?: string, sq?: string, bare?: string) => {
      args[key.toLowerCase()] = dq ?? sq ?? bare ?? ''
      return ''
    })
    .trim()

  return { command: command!.toLowerCase(), args, rest: unquote(rest) }
}

function unquote(value: string): string {
  const m = /^"([^"]*)"$|^'([^']*)'$/.exec(value.trim())
  return (m ? (m[1] ?? m[2] ?? '') : value).trim()
}

/**
 * The player a command targets: the `player:` argument when present, otherwise
 * whatever else was typed — so `.addTracker player:"x"` and `.addTracker x` both work.
 */
export function playerArg(parsed: ParsedCommand): string {
  return (parsed.args.player ?? parsed.args.name ?? parsed.rest).trim()
}
