# Discord bot — setup guide

The bot lets your Discord server manage the tracker's watchlist with slash commands, and posts
alerts about tracked **Hive** players: when they come online, a summary when they stop, milestones,
inactivity, and daily/weekly reports. It is part of the tracker service: there is nothing extra to
host, only a Discord application to create and a few settings to fill in.

| Command | Who | What it does |
|---|---|---|
| `/track player:` | Tracker or Tracker user | Start tracking a Hive player. Suggests gamertags from Hive's search once you type 4 letters. Tracker users are capped (see *Tracker user limit*). |
| `/untrack player:` | Tracker | Stop tracking and **delete their recorded history**. |
| `/alerts player: enabled:` | Tracker | Mute or unmute every alert for one player; they stay tracked. |
| `/watchlist [group:]` | Everyone | Who is tracked, what they last played, who is on right now; optionally one group. |
| `/online` | Everyone | Only the players in a session right now, with game and duration. |
| `/stats player: game: [period:]` | Everyone | Stat card for one game: all time, today, this week or this month. |
| `/sessions player:` | Everyone | Last 10 sessions, the hours they usually play, and who they often play with. |
| `/compare player1: player2: [game:]` | Everyone | Side by side: every shared game, or one game in detail. |
| `/report [period:]` | Everyone | Today so far, yesterday, or the last 7 days. |
| `/link code:` / `/unlink` | Everyone | Link your website account (see step 3). |

Every player and game option autocompletes: `game:` suggests the games that player actually played.

---

## 1. Create the application

<https://discord.com/developers/applications> → **New Application**, name it (e.g. *Mossad Tracker*).

**General Information**
- Name, icon, description: whatever you like — this is what people see.
- Copy the **Application ID**; the invite link in step 2 needs it.

**Installation**
- **Installation Contexts**: tick **Guild Install** only, untick **User Install**. The bot is meant
  for your server, not to be added to personal accounts.
- **Install Link**: set to **None**. (Required to make the bot private below — Discord refuses a
  private bot that has a default install link.)

**Bot**
- **Reset Token** → copy it once and keep it secret. Anyone with it controls the bot; if it ever
  leaks, reset it here and update the env file.
- **Public Bot**: **off**, so only you can add it to servers.
- **Requires OAuth2 Code Grant**: off.
- **Privileged Gateway Intents**: leave **all three off**. Slash commands do not need any.
  (Only the legacy `.addTracker` text commands need *Message Content*, see the end of this guide.)

## 2. Invite it to your server

Open this link, with your Application ID in place of `APP_ID`, and pick your server:

```
https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=19456
```

- `bot` adds the bot user; `applications.commands` lets it create slash commands. Without the second
  one the commands never appear.
- `19456` = **View Channels + Send Messages + Embed Links**, nothing more. It does not need Admin.

You can build the same link in **OAuth2 → URL Generator** by ticking those scopes and permissions.

## 3. Prepare the Discord server

Turn on **User Settings → Advanced → Developer Mode**, so right-click menus offer *Copy … ID*.

**Channels** — two is the cleanest:
- `#tracker` — where people run the commands.
- `#hive-online` — where the bot posts alerts. Make it read-only for members (deny *Send Messages*
  for @everyone) and allow the bot *View Channel*, *Send Messages*, *Embed Links*. Members can
  set it to *All Messages* notifications to get pinged when someone comes online.

One channel for both also works: leave `DISCORD_ALERT_CHANNEL_ID` empty and alerts go to the command
channel.

**Copy three IDs**: right-click the server icon → *Copy Server ID*; right-click each channel →
*Copy Channel ID*.

**Who may change the watchlist** — decided by the **website account** each member links:
1. On the website, open the account menu → *Members area* → **Get a link code**.
2. In Discord, type `/link code:XXXXXXXX` within 10 minutes. The reply is only visible to you.
3. From then on the bot gives you that account's tracker access: **Tracker** (or admin) = every
   command; **Tracker user** = read commands and `/track`, up to the limit; no tracker permission =
   read commands only. Changing someone's permissions on the Accounts page takes effect within a
   minute.

Members who never linked are treated as before: *Manage Server* = full access, everyone else = read
commands only. `/unlink` (or *Unlink* on the website) undoes it.

You can still hide commands per role or channel in **Server Settings → Integrations → Mossad
Tracker**; the bot also refuses commands outside `DISCORD_CHANNEL_ID` when that is set.

## 4. Configure the tracker

On the server, create `/etc/corlay/tracker.env`:

```bash
sudo tee /etc/corlay/tracker.env >/dev/null <<'EOF'
DISCORD_TOKEN=paste-the-bot-token
DISCORD_GUILD_ID=your-server-id
DISCORD_CHANNEL_ID=tracker-channel-id
DISCORD_ALERT_CHANNEL_ID=hive-online-channel-id
EOF
sudo chown root:www-data /etc/corlay/tracker.env
sudo chmod 640 /etc/corlay/tracker.env
sudo systemctl restart corlay-tracker
```

| Variable | Required | Meaning |
|---|---|---|
| `DISCORD_TOKEN` | yes | Bot token from step 1. No token, no bot; the tracker itself runs regardless. |
| `DISCORD_GUILD_ID` | recommended | Registers the commands in your server, where they appear **instantly**. Without it they are registered globally and can take a while to show up. |
| `DISCORD_CHANNEL_ID` | no | Only accept commands in this channel. |
| `DISCORD_ALERT_CHANNEL_ID` | no | Where online alerts go. Falls back to `DISCORD_CHANNEL_ID`; with neither, no alerts. |
| `DISCORD_PREFIX` | no | Turns on the legacy text commands, see below. Leave unset. |

Check the log:

```bash
journalctl -u corlay-tracker -n 20
```

You want to see:

```
[bot] connected as Mossad Tracker#1234
[bot] slash commands registered in server 123456789012345678
[bot] online alerts → #hive-online
```

## 5. Alert settings, groups, muting

On `/tracker/`, accounts with **Tracker** access see two extra panels:
- **Discord bot** — tick which posts the bot makes (online, session summary, milestones,
  inactivity, daily report, weekly report), the hour reports go out, after how many days someone
  counts as inactive, and how many players each *Tracker user* may have on the watchlist.
- **Groups** — create clans/friend groups. A group can have its **own Discord channel ID**: alerts
  for its members go there instead of `DISCORD_ALERT_CHANNEL_ID` (give the bot *View Channel*,
  *Send Messages*, *Embed Links* in it). Put players in a group from their page.

Per-player mute is on each player's page (Alerts on/off) or `/alerts` in Discord; a muted player
triggers none of the alerts.

## How the alerts behave

- **Online**: one alert when a player **starts a session**, not one per match. A new alert needs
  roughly 30 minutes of inactivity first. It names other tracked players in the same game
  (*Probably with*) and says when someone is back after a long absence.
- **Session summary**: about 30 minutes after their last detected match — duration, matches, wins,
  kills and level-ups per game.
- **Milestones**: every 5th level, the maximum level, any prestige, and win streaks of 5, 10, 15…
  Streaks are only counted when every match between two checks was a win, so they are a lower bound.
- **Inactivity**: once, when someone has not played for the configured number of days. They are
  then checked every 2 hours instead of every 20 minutes, until they play again.
- **Reports**: daily (yesterday) at the configured hour, weekly (last week) on Mondays — most active
  players, longest session, biggest level-ups, most played game.
- Hive has no "online" endpoint: the tracker notices someone when their stats change, i.e. after
  they **finish** a match. Expect 7–20 minutes of delay; the embed shows the time window it was
  detected in, in each reader's own timezone.
- A newly tracked player's first check is only a baseline, so their first alert comes after the
  next one.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No slash commands in Discord | Invite link lacked `applications.commands` — re-invite with the link in step 2 (no need to kick the bot). Check `DISCORD_GUILD_ID` is the server's ID, then press Ctrl+R in Discord. |
| Commands show up twice | An old global registration; restarting with `DISCORD_GUILD_ID` set removes it. |
| "The application did not respond" | The bot is offline: check `journalctl -u corlay-tracker` for a login error (wrong token). |
| "Link your website account first" | That member has not run `/link` and lacks *Manage Server* (step 3). |
| "can only add players" | Their linked account is a *Tracker user*; give it *Tracker* on the Accounts page. |
| `/link` says the code is wrong | Codes expire after 10 minutes and work once; make a new one. "Unreachable" means corlay-auth is down. |
| `/track` only suggests what you typed | Fewer than 4 letters, no Hive match, or the tracker is using its API budget at that moment — press Enter anyway, it still works. |
| Log says `cannot post in channel …` | Wrong channel ID (default or a group's), or the bot can't see / send / embed in it. Fix the channel permissions, then restart. |
| Log says `Used disallowed intents` | `DISCORD_PREFIX` is set without the *Message Content* intent. Unset it, or enable the intent. |
| No alerts though people play | Player muted (`/watchlist` shows 🔕), that alert type is off in the *Discord bot* panel, or the session isn't detected yet. |

## Legacy text commands (optional)

The original `.addTracker player:"name"`, `.removeTracker`, `.trackerList` and `.trackerHelp` still
exist. To use them: enable **Bot → Message Content Intent** in the portal, add
`DISCORD_PREFIX=.` to the env file, re-invite with `permissions=84992` (adds *Read Message History*,
needed to reply), and restart. Slash commands keep working alongside them.
