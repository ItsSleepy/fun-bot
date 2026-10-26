# Fun Bot

A Discord economy and minigame bot I built for two friend servers that share one economy. Coins, XP, jobs, gambling games, collectible pets and a co-op boss, built in eight phases around real progression and coin sinks rather than instant rewards.

## Features

**Economy:** `/balance`, `/pay`, `/leaderboard`, and `/daily`, `/monthly`, `/yearly` claims. Weekly `/quests` pay bonus coins and candy.

**Levelling:** passive XP for chatting, level-ups with role rewards, `/rank`, `/xp-leaderboard`, and `/prestige` (reset at the cap for a permanent badge and a small multiplier).

**Jobs:** `/fish`, `/mine`, `/hunt`. Each tool has three tiers bought from the `/shop`; higher tiers mean shorter cooldowns and better loot. Tools wear down with use and cost coins to repair.

**Games:** `/blackjack`, `/slots`, `/roulette`, `/coinflip`, `/duel`, `/trivia` with a prize for first and second place.

**Pets:** gacha `/pet-pull`, normal and premium chests, `/pet-feed` with candy (a currency only jobs and chests give), `/pet-equip` (two active slots, and buffs stack), `/pet-evolve` at max level, `/pet-battle` with an optional wager, `/pet-trade`, `/pet-sell` for duplicates, and cosmetic `/pet-skin`s with their own rarities.

**Server-wide:** a co-op `/boss` fight with a shared reward split, rare unannounced double-loot windows, collective `/milestone` goals that reward everyone, `/achievements` with titles, and a general `/trade` for items, candy and chests.

Everything is button-driven where it makes sense: the shop and inventory live in a single message each.

## Run it

```bash
npm install
cp .env.example .env      # add your bot token and server ID(s)
node index.js
```

Data is stored in SQLite (`economy.db`, via better-sqlite3). `fun-bot.service` is the systemd unit I run it with.

## Tests

```bash
node test/run_tests.js
```

139 checks against a fresh test database: payouts, cooldowns, trading, pet slots, battles and wagers, blackjack edge cases and prestige.

Built with Node.js, discord.js 14 and better-sqlite3.
