import { Client, EmbedBuilder, Events, GatewayIntentBits, type Message } from 'discord.js'
import { listPlayers } from '../queries.ts'
import { findTracked, trackPlayer, untrackPlayer } from '../services/players.ts'
import { ago, gameName } from './format.ts'
import { parseCommand, playerArg } from './parse.ts'

/**
 * Discord control surface for the watchlist.
 *
 * It runs inside the API process on purpose: a separate process would open the same
 * SQLite file and the two would block each other. Commands therefore call the same
 * service functions the HTTP routes use.
 */

const PREFIX = process.env.DISCORD_PREFIX ?? '.'
const ACCENT = 0xf5c518

let client: Client | null = null

export function startBot(): void {
  const token = process.env.DISCORD_TOKEN
  if (!token) return

  client = new Client({
    // MessageContent is a privileged intent: enable it for the application in the
    // Discord developer portal, otherwise every message arrives empty.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  })

  client.once(Events.ClientReady, (ready) => {
    console.log(`[bot] connected as ${ready.user.tag}, prefix "${PREFIX}"`)
  })

  client.on(Events.MessageCreate, (message) => {
    void handle(message).catch((err) => console.error('[bot] command failed', err))
  })

  client.login(token).catch((err) => console.error('[bot] login failed', err))
}

export function stopBot(): void {
  void client?.destroy()
  client = null
}

/** Optional channel lock, so the bot only answers where it is meant to. */
function allowed(message: Message): boolean {
  const channel = process.env.DISCORD_CHANNEL_ID
  return !channel || message.channelId === channel
}

async function handle(message: Message): Promise<void> {
  if (message.author.bot || !allowed(message)) return

  const parsed = parseCommand(message.content, PREFIX)
  if (!parsed) return

  switch (parsed.command) {
    case 'addtracker':
      return void (await addTracker(message, playerArg(parsed)))
    case 'removetracker':
    case 'deltracker':
      return void removeTracker(message, playerArg(parsed))
    case 'trackerlist':
    case 'trackers':
      return void trackerList(message)
    case 'trackerhelp':
      return void help(message)
  }
}

async function addTracker(message: Message, identifier: string): Promise<void> {
  if (!identifier) {
    await message.reply(`Usage: \`${PREFIX}addTracker player:"gamertag"\``)
    return
  }

  const pending = await message.reply(`Looking up **${identifier}** on Hive…`)
  const result = await trackPlayer(identifier)

  if (!result.ok) {
    const reason =
      result.reason === 'not_found'
        ? `No Hive player called **${identifier}**.`
        : result.reason === 'already_tracked'
          ? `**${identifier}** is already on the watchlist.`
          : result.reason === 'rate_limited'
            ? `Hive's per-player quota is spent for **${identifier}**. Try again in about an hour.`
            : `Could not reach Hive for **${identifier}**.`
    await pending.edit({ content: reason })
    return
  }

  const p = result.player
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`Now tracking ${p.username_cc ?? p.username}`)
    .setDescription(
      p.rank
        ? `Rank **${p.rank}**${p.first_played ? ` · playing since ${new Date(p.first_played * 1000).getFullYear()}` : ''}`
        : 'Baseline recorded.'
    )
    .setFooter({
      // Managing expectations: one observation cannot show activity yet.
      text: 'Activity shows up after the next check — the first fetch is only a baseline.'
    })

  await pending.edit({ content: '', embeds: [embed] })
}

function removeTracker(message: Message, identifier: string): void {
  if (!identifier) {
    void message.reply(`Usage: \`${PREFIX}removeTracker player:"gamertag"\``)
    return
  }

  const player = findTracked(identifier)
  if (!player) {
    void message.reply(`**${identifier}** is not on the watchlist.`)
    return
  }

  untrackPlayer(player.uuid)
  void message.reply(`Removed **${player.username_cc ?? player.username}** and their recorded history.`)
}

function trackerList(message: Message): void {
  const players = listPlayers()
  if (players.length === 0) {
    void message.reply(`Nothing tracked yet. Add someone with \`${PREFIX}addTracker player:"gamertag"\`.`)
    return
  }

  const dot = (status: string) =>
    status === 'live' ? '🟢' : status === 'recent' ? '🟡' : status === 'today' ? '🟠' : status === 'unknown' ? '⚪' : '⚫'

  // Discord caps an embed description at 4096 characters.
  const lines: string[] = []
  for (const p of players) {
    const line = `${dot(p.status)} **${p.username_cc ?? p.username}** — ${
      p.last_game ? gameName(p.last_game) : 'no match detected yet'
    }${p.last_seen_at ? ` · ${ago(p.last_seen_at)}` : ''}${p.enabled === 0 ? ' · paused' : ''}`
    if (lines.join('\n').length + line.length > 3900) {
      lines.push(`…and ${players.length - lines.length} more`)
      break
    }
    lines.push(line)
  }

  const live = players.filter((p) => p.status === 'live').length
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`Watchlist · ${players.length} tracked`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: live > 0 ? `${live} playing right now` : 'Nobody playing right now' })

  void message.reply({ embeds: [embed] })
}

function help(message: Message): void {
  void message.reply(
    [
      `\`${PREFIX}addTracker player:"gamertag"\` — start tracking someone`,
      `\`${PREFIX}removeTracker player:"gamertag"\` — stop tracking and delete their history`,
      `\`${PREFIX}trackerList\` — show the watchlist`
    ].join('\n')
  )
}
