import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type APIEmbed,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type SendableChannels
} from 'discord.js'
import { all, get } from '../db.ts'
import { searchPlayers } from '../hive/client.ts'
import { globalUsedLastMinute } from '../hive/limiter.ts'
import { setAlertSink } from '../notifier.ts'
import { getPlayer, listPlayers } from '../queries.ts'
import { addedBy, findTracked, setPlayerFlags, trackPlayer, untrackPlayer } from '../services/players.ts'
import { listGroups } from '../services/organise.ts'
import { linkedAccount, redeemLinkCode, unlinkDiscord } from '../accounts.ts'
import type { Actor } from '../audit.ts'
import { ACCENT, type Embed } from '../embeds.ts'
import type { PlayerRow, SearchResult } from '../../shared/types.ts'
import { commands, gameChoices, groupChoices, searchChoices, statusDot, trackedChoices, WRITE_COMMANDS } from './commands.ts'
import { ago, gameName } from './format.ts'
import { parseCommand, playerArg } from './parse.ts'
import { compareEmbed, onlineEmbed, reportReply, sessionsEmbed, statsEmbed } from './replies.ts'

/**
 * Discord control surface for the watchlist: slash commands with autocomplete, and an
 * embed in the alerts channel when a tracked Hive player starts playing.
 *
 * It runs inside the API process on purpose: a separate process would open the same
 * SQLite file and the two would block each other. Commands therefore call the same
 * service functions the HTTP routes use.
 */

/**
 * Legacy `.addTracker` text commands, off unless a prefix is set. They need the
 * privileged MESSAGE CONTENT intent; slash commands do not.
 */
const PREFIX = process.env.DISCORD_PREFIX ?? ''

let client: Client | null = null

export function startBot(): void {
  const token = process.env.DISCORD_TOKEN
  if (!token) return

  const intents = [GatewayIntentBits.Guilds]
  if (PREFIX) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent)
  client = new Client({ intents })

  client.once(Events.ClientReady, (ready) => {
    console.log(`[bot] connected as ${ready.user.tag}${PREFIX ? `, text prefix "${PREFIX}"` : ''}`)
    void registerCommands(ready)
    void startAlerts(ready)
  })

  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isAutocomplete()) {
      void autocomplete(interaction).catch((err) => console.error('[bot] autocomplete failed', err))
    } else if (interaction.isChatInputCommand()) {
      void slash(interaction).catch((err) => console.error('[bot] command failed', err))
    }
  })

  if (PREFIX) {
    client.on(Events.MessageCreate, (message) => {
      void handleText(message).catch((err) => console.error('[bot] command failed', err))
    })
  }

  client.login(token).catch((err) => console.error('[bot] login failed', err))
}

/**
 * Guild commands appear instantly; global ones can take a while to reach every
 * client, so DISCORD_GUILD_ID is the recommended setup for a single server.
 */
async function registerCommands(ready: Client<true>): Promise<void> {
  const guildId = process.env.DISCORD_GUILD_ID
  try {
    if (guildId) {
      await ready.application.commands.set(commands, guildId)
      // Drop global copies from an earlier setup, or every command would show twice.
      await ready.application.commands.set([])
      console.log(`[bot] slash commands registered in server ${guildId}`)
    } else {
      await ready.application.commands.set(commands)
      console.log('[bot] slash commands registered globally')
    }
  } catch (err) {
    console.error('[bot] could not register slash commands — was the bot invited with the applications.commands scope?', err)
  }
}

/**
 * Posts alerts: in a player's group channel when their group has one, otherwise in
 * DISCORD_ALERT_CHANNEL_ID, or the command channel when only that one is set.
 */
async function startAlerts(ready: Client<true>): Promise<void> {
  const id = process.env.DISCORD_ALERT_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID || null
  const channels = new Map<string, SendableChannels | null>()

  const channel = async (channelId: string): Promise<SendableChannels | null> => {
    if (channels.has(channelId)) return channels.get(channelId)!
    const found = await ready.channels.fetch(channelId).catch(() => null)
    const sendable = found?.isSendable() ? found : null
    if (!sendable) console.error(`[bot] cannot post in channel ${channelId}`)
    channels.set(channelId, sendable)
    return sendable
  }

  const fallback = id ? await channel(id) : null
  if (!id) console.log('[bot] no DISCORD_ALERT_CHANNEL_ID: only groups with their own channel get alerts')
  else if (fallback) console.log(`[bot] online alerts → #${'name' in fallback ? fallback.name : id}`)

  setAlertSink(async (embed, channelId) => {
    const target = (channelId ? await channel(channelId) : null) ?? fallback
    if (!target) return false
    await target.send({ embeds: [embed as APIEmbed] })
    return true
  })
}

export function stopBot(): void {
  setAlertSink(null)
  void client?.destroy()
  client = null
}

/* -------------------------------------------------------------- autocomplete */

/** Recent Hive searches, so typing "tuff c" → "tuff co" does not cost a request per key. */
const searchCache = new Map<string, { at: number; hits: SearchResult[] }>()
const SEARCH_TTL_MS = 5 * 60 * 1000
/** Leave most of the global budget to the scheduler: suggestions are a nicety. */
const SEARCH_BUDGET = 60
/** Discord drops an autocomplete answer after 3 s. */
const SEARCH_TIMEOUT_MS = 2_000

async function hiveSuggestions(q: string): Promise<SearchResult[] | null> {
  const key = q.toLowerCase()
  const cached = searchCache.get(key)
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.hits
  if (globalUsedLastMinute() >= SEARCH_BUDGET) return null

  const res = await Promise.race([
    searchPlayers(q),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SEARCH_TIMEOUT_MS))
  ])
  if (!res?.ok) return null

  const tracked = new Set(all<{ uuid: string }>('SELECT uuid FROM players').map((r) => r.uuid))
  const hits = res.data.map((h) => ({ uuid: h.UUID, username: h.username, username_cc: h.username_cc, tracked: tracked.has(h.UUID) }))
  if (searchCache.size > 500) searchCache.clear()
  searchCache.set(key, { at: Date.now(), hits })
  return hits
}

/** A tracked player from an option value: the UUID a suggestion carries, or a typed name. */
function resolveTracked(value: string | null): PlayerRow | null {
  if (!value) return null
  return getPlayer(value) ?? findTracked(value)
}

async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true)
  const typed = String(focused.value)

  if (interaction.commandName === 'track') {
    const q = typed.trim()
    const hits = q.length >= 4 ? await hiveSuggestions(q) : null
    await interaction.respond(searchChoices(hits, typed))
  } else if (focused.name === 'game') {
    const p = resolveTracked(interaction.options.getString('player') ?? interaction.options.getString('player1'))
    const played = p
      ? all<{ game: string; played: number }>(
          "SELECT game, played FROM game_state WHERE uuid = ? AND played > 0 AND game NOT IN ('main', 'unknown') ORDER BY played DESC",
          [p.uuid]
        )
      : null
    await interaction.respond(gameChoices(played, typed))
  } else if (focused.name === 'group') {
    await interaction.respond(groupChoices(listGroups(), typed))
  } else {
    await interaction.respond(trackedChoices(listPlayers(), typed))
  }
}

/* ------------------------------------------------------------ slash commands */

/** Optional channel lock, so the bot only answers where it is meant to. */
function allowedChannel(channelId: string | null): boolean {
  const channel = process.env.DISCORD_CHANNEL_ID
  return !channel || channelId === channel
}

type Access = 'full' | 'user' | 'none'

interface Who {
  actor: Actor
  access: Access
  linked: boolean
}

/**
 * What this Discord member may do: their linked website account decides; members who
 * never linked fall back to Discord's Manage Server permission.
 */
async function whoIs(userId: string, username: string, manageGuild: boolean): Promise<Who> {
  const account = await linkedAccount(userId)
  if (account) {
    const access = account.access
    return { actor: { name: account.username, source: 'discord', access: access === 'full' ? 'full' : 'user' }, access, linked: true }
  }
  const access: Access = manageGuild ? 'full' : 'none'
  return { actor: { name: `@${username}`, source: 'discord', access: 'full' }, access, linked: false }
}

function denied(who: Who, need: 'user' | 'full'): string | null {
  if (who.access === 'full' || (need === 'user' && who.access === 'user')) return null
  if (who.linked) {
    return need === 'user'
      ? `Your website account **${who.actor.name}** has no tracker access.`
      : `Your website account **${who.actor.name}** can only add players — this needs full Tracker access.`
  }
  return 'Link your website account first with `/link` (get the code on the Members page), or ask someone with Manage Server.'
}

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral }) as const

async function slash(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.commandName

  // Linking is personal: it works anywhere, and the answer is only shown to the user.
  if (name === 'link') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const res = await redeemLinkCode(interaction.options.getString('code', true), interaction.user.id, interaction.user.tag)
    await interaction.editReply(
      res.ok
        ? `Linked to website account **${res.account.username}** — ${
            res.account.access === 'full'
              ? 'you can use every tracker command.'
              : res.account.access === 'user'
                ? 'you can view the tracker and add players.'
                : 'that account has no tracker access yet, so you can only use the read commands.'
          }`
        : res.error
    )
    return
  }
  if (name === 'unlink') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    await interaction.editReply((await unlinkDiscord(interaction.user.id)) ? 'Unlinked.' : 'Nothing to unlink, or the website is unreachable.')
    return
  }

  if (!allowedChannel(interaction.channelId)) {
    await interaction.reply(ephemeral(`Tracker commands live in <#${process.env.DISCORD_CHANNEL_ID}>.`))
    return
  }

  const need = WRITE_COMMANDS[name]
  let who: Who | null = null
  if (need) {
    // Resolving the account and (for /track) Hive can exceed Discord's 3 s reply window.
    await interaction.deferReply()
    who = await whoIs(interaction.user.id, interaction.user.username, interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false)
    const refusal = denied(who, need)
    if (refusal) {
      await interaction.deleteReply().catch(() => undefined)
      await interaction.followUp(ephemeral(refusal))
      return
    }
  }

  switch (name) {
    case 'track':
      await interaction.editReply(await trackReply(interaction.options.getString('player', true), who!.actor))
      return
    case 'untrack':
      await interaction.editReply(untrackReply(interaction.options.getString('player', true), who!.actor))
      return
    case 'alerts':
      await interaction.editReply(
        alertsReply(interaction.options.getString('player', true), interaction.options.getBoolean('enabled', true), who!.actor)
      )
      return
    case 'watchlist': {
      const group = interaction.options.getString('group')
      await interaction.reply(watchlistReply(group ? Number(group) : null))
      return
    }
    case 'online':
      await interaction.reply(embedReply(onlineEmbed()))
      return
    case 'stats': {
      const p = resolveTracked(interaction.options.getString('player', true))
      if (!p) return void (await interaction.reply(ephemeral('That player is not on the watchlist.')))
      await interaction.deferReply()
      const period = (interaction.options.getString('period') ?? 'all') as 'all' | 'day' | 'week' | 'month'
      await interaction.editReply(embedReply(await statsEmbed(p, interaction.options.getString('game', true), period)))
      return
    }
    case 'sessions': {
      const p = resolveTracked(interaction.options.getString('player', true))
      if (!p) return void (await interaction.reply(ephemeral('That player is not on the watchlist.')))
      await interaction.reply(embedReply(sessionsEmbed(p)))
      return
    }
    case 'compare': {
      const a = resolveTracked(interaction.options.getString('player1', true))
      const b = resolveTracked(interaction.options.getString('player2', true))
      if (!a || !b) return void (await interaction.reply(ephemeral('Both players must be on the watchlist.')))
      if (a.uuid === b.uuid) return void (await interaction.reply(ephemeral('Pick two different players.')))
      await interaction.deferReply()
      await interaction.editReply(embedReply(await compareEmbed(a, b, interaction.options.getString('game'))))
      return
    }
    case 'report': {
      await interaction.deferReply()
      const period = (interaction.options.getString('period') ?? 'today') as 'today' | 'yesterday' | 'week'
      await interaction.editReply(embedReply(await reportReply(period)))
      return
    }
  }
}

/* ------------------------------------------------------- shared reply bodies */

interface Reply {
  content: string
  embeds: Array<EmbedBuilder | APIEmbed>
}

const text = (content: string): Reply => ({ content, embeds: [] })
const embedReply = (e: Embed | string): Reply => (typeof e === 'string' ? text(e) : { content: '', embeds: [e as APIEmbed] })

async function trackReply(identifier: string, actor: Actor): Promise<Reply> {
  const name = identifier.trim()
  if (!name) return text('Give a Hive gamertag.')

  const result = await trackPlayer(name, actor)
  if (!result.ok) {
    return text(
      result.reason === 'not_found'
        ? `No Hive player called **${name}**.`
        : result.reason === 'already_tracked'
          ? `**${name}** is already on the watchlist.`
          : result.reason === 'rate_limited'
            ? `Hive's per-player quota is spent for **${name}**. Try again in about an hour.`
            : result.reason === 'limit'
              ? `**${actor.name}** already has ${result.limit} players on the watchlist, the limit for this account. Ask a Tracker admin to raise it or remove one.`
              : `Could not reach Hive for **${name}**.`
    )
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
      text:
        'Activity shows up after the next check — the first fetch is only a baseline.' +
        (actor.access === 'user' ? ` · ${actor.name}: ${addedBy(actor.name)} added` : '')
    })
  return { content: '', embeds: [embed] }
}

function untrackReply(identifier: string, actor: Actor): Reply {
  const player = findTracked(identifier) ?? getPlayer(identifier)
  if (!player) return text(`**${identifier}** is not on the watchlist.`)

  untrackPlayer(player.uuid, actor)
  return text(`Removed **${player.username_cc ?? player.username}** and their recorded history.`)
}

function alertsReply(identifier: string, enabled: boolean, actor: Actor): Reply {
  const found = getPlayer(identifier) ?? findTracked(identifier)
  if (!found) return text(`**${identifier}** is not on the watchlist.`)

  setPlayerFlags(found.uuid, { notify: enabled }, actor)
  const name = found.username_cc ?? found.username
  return text(enabled ? `🔔 Alerts on for **${name}**.` : `🔕 Alerts off for **${name}** — still tracked, just quiet.`)
}

function watchlistReply(groupId: number | null = null): Reply {
  const everyone = listPlayers()
  const players = groupId === null ? everyone : everyone.filter((p) => p.group?.id === groupId)
  const groupName = groupId === null ? null : (get<{ name: string }>('SELECT name FROM player_groups WHERE id = ?', [groupId])?.name ?? null)
  if (players.length === 0) {
    return text(groupName ? `Nobody in **${groupName}** yet.` : 'Nothing tracked yet. Add someone with `/track`.')
  }

  // Discord caps an embed description at 4096 characters.
  const lines: string[] = []
  for (const p of players) {
    const tags = p.tags.length > 0 ? ` · ${p.tags.map((t) => `\`${t}\``).join(' ')}` : ''
    const line = `${statusDot(p.status)} **${p.username_cc ?? p.username}** — ${
      p.last_game ? gameName(p.last_game) : 'no match detected yet'
    }${p.last_seen_at ? ` · ${ago(p.last_seen_at)}` : ''}${p.enabled === 0 ? ' · paused' : ''}${p.notify === 0 ? ' · 🔕' : ''}${p.inactive ? ' · 💤' : ''}${tags}`
    if (lines.join('\n').length + line.length > 3900) {
      lines.push(`…and ${players.length - lines.length} more`)
      break
    }
    lines.push(line)
  }

  const live = players.filter((p) => p.status === 'live').length
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(`${groupName ? `${groupName} · ` : 'Watchlist · '}${players.length} tracked`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: live > 0 ? `${live} playing right now` : 'Nobody playing right now' })
  return { content: '', embeds: [embed] }
}

/* --------------------------------------------------------- legacy text bot */

async function handleText(message: Message): Promise<void> {
  if (message.author.bot || !allowedChannel(message.channelId)) return

  const parsed = parseCommand(message.content, PREFIX)
  if (!parsed) return

  const need = parsed.command === 'addtracker' ? 'user' : ['removetracker', 'deltracker'].includes(parsed.command) ? 'full' : null
  let who: Who | null = null
  if (need) {
    who = await whoIs(message.author.id, message.author.username, message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false)
    const refusal = denied(who, need)
    if (refusal) return void (await message.reply(refusal))
  }

  switch (parsed.command) {
    case 'addtracker': {
      const identifier = playerArg(parsed)
      if (!identifier) return void (await message.reply(`Usage: \`${PREFIX}addTracker player:"gamertag"\``))
      const pending = await message.reply(`Looking up **${identifier}** on Hive…`)
      await pending.edit(await trackReply(identifier, who!.actor))
      return
    }
    case 'removetracker':
    case 'deltracker': {
      const identifier = playerArg(parsed)
      if (!identifier) return void (await message.reply(`Usage: \`${PREFIX}removeTracker player:"gamertag"\``))
      await message.reply(untrackReply(identifier, who!.actor))
      return
    }
    case 'trackerlist':
    case 'trackers':
      await message.reply(watchlistReply())
      return
    case 'trackerhelp':
      await message.reply(
        [
          `\`${PREFIX}addTracker player:"gamertag"\` — start tracking someone`,
          `\`${PREFIX}removeTracker player:"gamertag"\` — stop tracking and delete their history`,
          `\`${PREFIX}trackerList\` — show the watchlist`,
          'Slash commands do more, with autocomplete: `/track`, `/untrack`, `/alerts`, `/watchlist`, `/online`, `/stats`, `/sessions`, `/compare`, `/report`, `/link`.'
        ].join('\n')
      )
      return
  }
}
