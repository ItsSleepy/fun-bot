require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const {
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require('discord.js');

const CURRENCY_NAME = process.env.CURRENCY_NAME || 'Coins';
const CURRENCY_EMOJI = process.env.CURRENCY_EMOJI || '🪙';
const DAILY_AMOUNT = parseInt(process.env.DAILY_AMOUNT || '100', 10);
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MONTHLY_AMOUNT = parseInt(process.env.MONTHLY_AMOUNT || '1000', 10);
const MONTHLY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const YEARLY_AMOUNT = parseInt(process.env.YEARLY_AMOUNT || '3000', 10);
const YEARLY_COOLDOWN_MS = 365 * 24 * 60 * 60 * 1000;

const XP_MIN = parseInt(process.env.XP_MIN || '15', 10);
const XP_MAX = parseInt(process.env.XP_MAX || '25', 10);
const XP_COOLDOWN_MS = parseInt(process.env.XP_COOLDOWN_SECONDS || '60', 10) * 1000;
const LEVEL_UP_BONUS_COINS = parseInt(process.env.LEVEL_UP_BONUS_COINS || '50', 10);

const TRIVIA_REWARD_FIRST = parseInt(process.env.TRIVIA_REWARD_FIRST || '100', 10);
const TRIVIA_REWARD_SECOND = parseInt(process.env.TRIVIA_REWARD_SECOND || '30', 10);

const PET_PULL_COST = parseInt(process.env.PET_PULL_COST || '200', 10);
const CANDY_TO_PET_XP = parseInt(process.env.CANDY_TO_PET_XP || '10', 10); // candy is scarcer than coins were, so each unit counts for more

// Any guild the bot is actually in gets commands registered to it.
// Not being in GUILD_ID_2 yet is fine — that one is just skipped for now.
const GUILD_IDS = [process.env.GUILD_ID_1, process.env.GUILD_ID_2].filter(Boolean);

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'economy.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    last_daily INTEGER NOT NULL DEFAULT 0
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS pets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    pet_key TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    xp INTEGER NOT NULL DEFAULT 0,
    obtained_at INTEGER NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS active_pets (
    user_id TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    pet_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, slot_index)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS owned_tools (
    user_id TEXT NOT NULL,
    job_key TEXT NOT NULL,
    tier INTEGER NOT NULL,
    PRIMARY KEY (user_id, job_key)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS active_boosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    boost_key TEXT NOT NULL,
    stat TEXT NOT NULL,
    value INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS job_cooldowns (
    user_id TEXT NOT NULL,
    job_key TEXT NOT NULL,
    last_used INTEGER NOT NULL,
    PRIMARY KEY (user_id, job_key)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_quests (
    week_key TEXT PRIMARY KEY,
    quest_keys TEXT NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS quest_progress (
    user_id TEXT NOT NULL,
    week_key TEXT NOT NULL,
    quest_key TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    claimed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, week_key, quest_key)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS server_milestone (
    key TEXT PRIMARY KEY,
    progress INTEGER NOT NULL DEFAULT 0,
    target INTEGER NOT NULL,
    reward_coin INTEGER NOT NULL,
    reward_candy INTEGER NOT NULL,
    achieved INTEGER NOT NULL DEFAULT 0
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS milestone_contributions (
    milestone_key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (milestone_key, user_id)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS pet_skins (
    user_id TEXT NOT NULL,
    skin_key TEXT NOT NULL,
    PRIMARY KEY (user_id, skin_key)
  );
`);

function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    console.log(`Added column ${table}.${column}`);
  }
}
ensureColumn('users', 'xp', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'level', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'last_xp_ts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'active_pet_id', 'INTEGER');
ensureColumn('users', 'pet_slots', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('pets', 'bonus_xp', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('pets', 'bonus_coin', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('pets', 'bonus_win', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('pets', 'booster_used', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'perm_daily_bonus', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'perm_xp_cd_reduction', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'pending_luck_charm', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'candy', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'blackjack_wins', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'battle_wins', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'achievements', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('users', 'active_title', 'TEXT');
ensureColumn('users', 'last_monthly', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'last_yearly', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'prestige', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('pets', 'skin_key', 'TEXT');
ensureColumn('owned_tools', 'durability', 'INTEGER NOT NULL DEFAULT 100');
ensureColumn('pets', 'evolved', 'INTEGER NOT NULL DEFAULT 0');

function getUser(userId) {
  let row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO users (user_id, balance, last_daily, xp, level, last_xp_ts) VALUES (?, 0, 0, 0, 0, 0)').run(userId);
    row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId); // re-select so every column default (incl. ones added later) is populated
  }
  return row;
}

function addBalance(userId, amount) {
  getUser(userId);
  db.prepare('UPDATE users SET balance = balance + ? WHERE user_id = ?').run(amount, userId);
  return getUser(userId).balance;
}

function setLastDaily(userId, ts) {
  db.prepare('UPDATE users SET last_daily = ? WHERE user_id = ?').run(ts, userId);
}

function fmt(amount) {
  return `${CURRENCY_EMOJI} **${amount.toLocaleString()}** ${CURRENCY_NAME}`;
}
function fmt2(amount) {
  return `${amount.toLocaleString()} ${CURRENCY_EMOJI} ${CURRENCY_NAME}`;
}
const CANDY_EMOJI = process.env.CANDY_EMOJI || "🍬";
function fmtCandy(amount) {
  return `${CANDY_EMOJI} **${amount.toLocaleString()}** Candy`;
}
function addCandy(userId, amount) {
  getUser(userId);
  db.prepare("UPDATE users SET candy = candy + ? WHERE user_id = ?").run(amount, userId);
  return getUser(userId).candy;
}

// ---------- XP / leveling ----------
function xpForNextLevel(level) {
  return 5 * (level ** 2) + 50 * level + 100;
}
function levelFromTotalXp(totalXp) {
  let level = 0;
  let remaining = totalXp;
  while (remaining >= xpForNextLevel(level)) {
    remaining -= xpForNextLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForThisLevel: xpForNextLevel(level) };
}
function progressBar(current, max, size = 14) {
  const filled = Math.round((current / max) * size);
  return '▰'.repeat(Math.max(0, Math.min(size, filled))) + '▱'.repeat(size - Math.max(0, Math.min(size, filled)));
}
function awardXp(userId) {
  const row = getUser(userId);
  const now = Date.now();
  const effectiveCooldown = Math.max(30000, XP_COOLDOWN_MS - (row.perm_xp_cd_reduction || 0));
  if (now - row.last_xp_ts < effectiveCooldown) return null;

  const baseGain = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
  const buff = getActiveBuff(userId);
  const gained = applyBuff(baseGain, buff.xp);
  const newTotalXp = row.xp + gained;
  const before = levelFromTotalXp(row.xp);
  const after = levelFromTotalXp(newTotalXp);

  db.prepare('UPDATE users SET xp = ?, level = ?, last_xp_ts = ? WHERE user_id = ?')
    .run(newTotalXp, after.level, now, userId);

  if (after.level > before.level) {
    addBalance(userId, LEVEL_UP_BONUS_COINS);
    checkAchievements(userId);
    return { newLevel: after.level, bonus: LEVEL_UP_BONUS_COINS };
  }
  return null;
}

// ---------- Cards (blackjack) ----------
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function cardValue(rank) {
  if (rank === 'A') return 11;
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  return parseInt(rank, 10);
}
function handValue(cards) {
  let total = cards.reduce((s, c) => s + cardValue(c.rank), 0);
  let aces = cards.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function renderCard(c) { return `${c.rank}${c.suit}`; }
function renderHand(cards) { return cards.map(renderCard).join(' '); }

const blackjackGames = new Map(); // userId -> game state

function buildBlackjackEmbed(game, { reveal = false, result = null } = {}) {
  const playerVal = handValue(game.playerHand);
  const dealerCards = reveal ? game.dealerHand : [game.dealerHand[0], { rank: '?', suit: '' }];
  const dealerVal = reveal ? handValue(game.dealerHand) : cardValue(game.dealerHand[0].rank);

  const embed = new EmbedBuilder()
    .setTitle('🃏 Blackjack')
    .setColor(result === 'win' ? 0x4CAF50 : result === 'lose' ? 0xE53935 : 0xFFC107)
    .addFields(
      { name: `Your hand (${playerVal})`, value: renderHand(game.playerHand), inline: false },
      { name: reveal ? `Dealer (${dealerVal})` : 'Dealer (? showing)', value: renderHand(dealerCards), inline: false },
      { name: 'Bet', value: fmt(game.bet), inline: true },
    );
  if (result) {
    const label = result === 'win' ? '🎉 You win!' : result === 'push' ? '🤝 Push — bet returned' : '💥 You lose';
    embed.setFooter({ text: label });
  }
  return embed;
}
function buildBlackjackRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bj_hit').setLabel('Hit').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('bj_stand').setLabel('Stand').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

async function resolveBlackjack(game, interaction, playerBusted = false) {
  clearTimeout(game.timeout);
  let result;
  if (playerBusted) {
    result = 'lose';
  } else {
    while (handValue(game.dealerHand) < 17) game.dealerHand.push(game.deck.pop());
    const p = handValue(game.playerHand);
    const d = handValue(game.dealerHand);
    if (d > 21 || p > d) result = 'win';
    else if (p === d) result = 'push';
    else result = 'lose';
  }

  const buff = getActiveBuff(game.userId);
  if (result === 'win') {
    addBalance(game.userId, applyBuff(game.bet * 2, buff.win));
    db.prepare('UPDATE users SET blackjack_wins = blackjack_wins + 1 WHERE user_id = ?').run(game.userId);
    trackQuest(game.userId, 'blackjack_win');
    checkAchievements(game.userId);
  } else if (result === 'push') addBalance(game.userId, game.bet);
  // lose: bet already deducted up front, nothing more to do

  blackjackGames.delete(game.userId);
  const embed = buildBlackjackEmbed(game, { reveal: true, result });
  await interaction.update({ embeds: [embed], components: [buildBlackjackRow(true)] });
}

// ---------- Slots ----------
const SLOT_SYMBOLS = [
  { emoji: '🍒', weight: 30, payout: 2 },
  { emoji: '🍋', weight: 25, payout: 3 },
  { emoji: '🍇', weight: 20, payout: 4 },
  { emoji: '🔔', weight: 15, payout: 6 },
  { emoji: '⭐', weight: 7, payout: 10 },
  { emoji: '💎', weight: 3, payout: 20 },
];
function spinReel() {
  const total = SLOT_SYMBOLS.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const sym of SLOT_SYMBOLS) {
    if (r < sym.weight) return sym;
    r -= sym.weight;
  }
  return SLOT_SYMBOLS[0];
}

// ---------- Trivia ----------
const TRIVIA_QUESTIONS = [
  { q: 'What year was the first Minecraft version released?', choices: ['2009', '2011', '2013', '2015'], answer: 0 },
  { q: 'What does "TPS" stand for in a Minecraft server context?', choices: ['Ticks Per Second', 'Total Player Score', 'Time Per Spawn', 'Transfer Protocol Service'], answer: 0 },
  { q: 'In F1, how many points does a race winner get (standard race, no fastest lap bonus)?', choices: ['20', '25', '30', '10'], answer: 1 },
  { q: 'What company makes the CS2 game?', choices: ['Epic Games', 'Riot Games', 'Valve', 'Blizzard'], answer: 2 },
  { q: 'What does "RCON" stand for?', choices: ['Remote Console', 'Rapid Connection', 'Recursive Config', 'Runtime Constant'], answer: 0 },
  { q: 'What HTTP status code means "Not Found"?', choices: ['500', '403', '404', '301'], answer: 2 },
  { q: 'What language is Minecraft (Java Edition) written in?', choices: ['C++', 'Python', 'Java', 'Rust'], answer: 2 },
  { q: 'What does "DNS" stand for?', choices: ['Domain Name System', 'Data Network Service', 'Direct Node Sync', 'Dynamic Naming Standard'], answer: 0 },
  { q: 'In blackjack, what\'s the best possible hand called?', choices: ['Royal Flush', 'Blackjack', 'Full House', 'Straight'], answer: 1 },
  { q: 'What does "WOL" stand for (as in /wakepc)?', choices: ['Wide Open LAN', 'Wake-on-LAN', 'Wireless Online Link', 'Wait On Login'], answer: 1 },
];
const triviaSessions = new Map(); // messageId -> { answer, resolved, attempts: Map<userId, count> }

// ---------- Pets / collectibles ----------
const PET_CATALOG = [
  // Common (10) — ~61% combined — small single-stat buffs (+3%)
  { key: 'puppy', name: 'Puppy', emoji: '🐶', rarity: 'Common', weight: 122, buff: { xp: 3, coin: 0, win: 0 } },
  { key: 'kitten', name: 'Kitten', emoji: '🐱', rarity: 'Common', weight: 122, buff: { xp: 0, coin: 3, win: 0 } },
  { key: 'hamster', name: 'Hamster', emoji: '🐹', rarity: 'Common', weight: 122, buff: { xp: 0, coin: 0, win: 3 } },
  { key: 'bunny', name: 'Bunny', emoji: '🐰', rarity: 'Common', weight: 122, buff: { xp: 3, coin: 0, win: 0 } },
  { key: 'chick', name: 'Chick', emoji: '🐤', rarity: 'Common', weight: 122, buff: { xp: 0, coin: 3, win: 0 } },
  { key: 'piglet', name: 'Piglet', emoji: '🐷', rarity: 'Common', weight: 122, buff: { xp: 0, coin: 0, win: 3 } },
  { key: 'duckling', name: 'Duckling', emoji: '🦆', rarity: 'Common', weight: 122, buff: { xp: 3, coin: 0, win: 0 } },
  { key: 'turtle', name: 'Turtle', emoji: '🐢', rarity: 'Common', weight: 122, buff: { xp: 0, coin: 3, win: 0 } },
  { key: 'frog', name: 'Frog', emoji: '🐸', rarity: 'Common', weight: 122, buff: { xp: 0, coin: 0, win: 3 } },
  { key: 'mouse', name: 'Mouse', emoji: '🐭', rarity: 'Common', weight: 122, buff: { xp: 3, coin: 0, win: 0 } },
  // Rare (5) — ~28.5% combined — single-stat buffs (+6%)
  { key: 'fox', name: 'Fox', emoji: '🦊', rarity: 'Rare', weight: 114, buff: { xp: 6, coin: 0, win: 0 } },
  { key: 'panda', name: 'Panda', emoji: '🐼', rarity: 'Rare', weight: 114, buff: { xp: 0, coin: 6, win: 0 } },
  { key: 'owl', name: 'Owl', emoji: '🦉', rarity: 'Rare', weight: 114, buff: { xp: 0, coin: 0, win: 6 } },
  { key: 'otter', name: 'Otter', emoji: '🦦', rarity: 'Rare', weight: 114, buff: { xp: 6, coin: 0, win: 0 } },
  { key: 'penguin', name: 'Penguin', emoji: '🐧', rarity: 'Rare', weight: 114, buff: { xp: 0, coin: 6, win: 0 } },
  // Epic (3) — ~10% combined — single-stat buffs (+12%)
  { key: 'baby_dragon', name: 'Baby Dragon', emoji: '🐉', rarity: 'Epic', weight: 67, buff: { xp: 0, coin: 12, win: 0 } },
  { key: 'unicorn', name: 'Unicorn', emoji: '🦄', rarity: 'Epic', weight: 67, buff: { xp: 12, coin: 0, win: 0 } },
  { key: 'kraken', name: 'Kraken', emoji: '🐙', rarity: 'Epic', weight: 66, buff: { xp: 0, coin: 0, win: 12 } },
  // Legendary (2) — ~0.5% combined — best in the game, buffs ALL three stats
  { key: 'ancient_dragon', name: 'Ancient Dragon', emoji: '🐲', rarity: 'Legendary', weight: 5, buff: { xp: 25, coin: 15, win: 10 } },
  { key: 'celestial_wolf', name: 'Celestial Wolf', emoji: '🌟', rarity: 'Legendary', weight: 5, buff: { xp: 15, coin: 25, win: 10 } },
];
const RARITY_COLOR = { Common: 0xB0BEC5, Rare: 0x42A5F5, Epic: 0xAB47BC, Legendary: 0xFFD54F };
const RARITY_ORDER = { Legendary: 0, Epic: 1, Rare: 2, Common: 3 };

function petTotalWeight() {
  return PET_CATALOG.reduce((s, p) => s + p.weight, 0);
}

function petByKey(key) {
  return PET_CATALOG.find(p => p.key === key);
}
function petXpForLevel(level) {
  return level * 100; // flat, simple curve — feeding is the only source of pet XP
}
function addPetToUser(userId, petKey) {
  const result = db.prepare(
    'INSERT INTO pets (user_id, pet_key, level, xp, obtained_at) VALUES (?, ?, 1, 0, ?)'
  ).run(userId, petKey, Date.now());
  return result.lastInsertRowid;
}
function getUserPets(userId) {
  return db.prepare('SELECT * FROM pets WHERE user_id = ? ORDER BY id').all(userId);
}
function getPet(petId) {
  return db.prepare('SELECT * FROM pets WHERE id = ?').get(petId);
}
function feedPet(petId, coinsSpent) {
  const pet = getPet(petId);
  if (!pet) return null;
  let xp = pet.xp + coinsSpent; // 1 coin fed = 1 XP
  let level = pet.level;
  while (xp >= petXpForLevel(level)) {
    xp -= petXpForLevel(level);
    level++;
  }
  db.prepare('UPDATE pets SET xp = ?, level = ? WHERE id = ?').run(xp, level, petId);
  return { ...pet, xp, level, leveledUp: level > pet.level };
}

function getActivePets(userId) {
  const rows = db.prepare('SELECT * FROM active_pets WHERE user_id = ? ORDER BY slot_index').all(userId);
  return rows.map(r => ({ ...r, pet: getPet(r.pet_id) })).filter(r => r.pet);
}
function setActivePet(userId, petId, slot = 1) {
  const user = getUser(userId);
  const maxSlot = Math.max(1, Math.min(slot, user.pet_slots));
  // a pet can only occupy one slot — otherwise equipping it twice would double its buff
  db.prepare('DELETE FROM active_pets WHERE user_id = ? AND pet_id = ? AND slot_index != ?').run(userId, petId, maxSlot);
  db.prepare('INSERT INTO active_pets (user_id, slot_index, pet_id) VALUES (?, ?, ?) ON CONFLICT(user_id, slot_index) DO UPDATE SET pet_id = excluded.pet_id')
    .run(userId, maxSlot, petId);
}
function getActiveBoosts(userId) {
  const now = Date.now();
  db.prepare('DELETE FROM active_boosts WHERE expires_at <= ?').run(now); // sweep expired, cheap
  return db.prepare('SELECT * FROM active_boosts WHERE user_id = ? AND expires_at > ?').all(userId, now);
}
const PRESTIGE_LEVEL_CAP = 50;
const PRESTIGE_BUFF_PER_LEVEL = 1; // flat % added to all three stats per prestige

function getActiveBuff(userId) {
  const totals = { xp: 0, coin: 0, win: 0 };
  const prestige = getUser(userId).prestige || 0;
  if (prestige > 0) {
    totals.xp += prestige * PRESTIGE_BUFF_PER_LEVEL;
    totals.coin += prestige * PRESTIGE_BUFF_PER_LEVEL;
    totals.win += prestige * PRESTIGE_BUFF_PER_LEVEL;
  }
  for (const { pet } of getActivePets(userId)) {
    const catalog = petByKey(pet.pet_key);
    if (!catalog) continue;
    const mult = pet.evolved ? EVOLVE_MULTIPLIER : 1;
    totals.xp += Math.round(((catalog.buff.xp || 0) + (pet.bonus_xp || 0)) * mult);
    totals.coin += Math.round(((catalog.buff.coin || 0) + (pet.bonus_coin || 0)) * mult);
    totals.win += Math.round(((catalog.buff.win || 0) + (pet.bonus_win || 0)) * mult);
  }
  for (const boost of getActiveBoosts(userId)) {
    totals[boost.stat] = (totals[boost.stat] || 0) + boost.value;
  }
  return totals;
}
function applyBuff(base, percent) {
  return Math.round(base * (1 + percent / 100));
}
function describeBuff(buff) {
  const parts = [];
  if (buff.xp) parts.push(`+${buff.xp}% XP`);
  if (buff.coin) parts.push(`+${buff.coin}% daily coins`);
  if (buff.win) parts.push(`+${buff.win}% gambling winnings`);
  return parts.length ? parts.join(', ') : 'No buff';
}

// ---------- Shop / Inventory ----------
const JOB_LABELS = { fish: 'Fishing', mine: 'Mining', hunt: 'Hunting' };
const TOOL_LABELS = { fish: 'Rod', mine: 'Pickaxe', hunt: 'Bow' };
const JOB_COOLDOWNS = { 1: 20 * 60 * 1000, 2: 10 * 60 * 1000, 3: 5 * 60 * 1000 }; // by tier

const SHOP_CATEGORIES = ['Tools', 'Boosts', 'Pet Chests', 'Pet Items', 'Upgrades', 'Cosmetics'];

const SHOP_ITEMS = {
  Tools: [
    { key: 'rod_1', name: 'Fishing Rod I', price: 750, job: 'fish', tier: 1 },
    { key: 'rod_2', name: 'Fishing Rod II', price: 3000, job: 'fish', tier: 2 },
    { key: 'rod_3', name: 'Fishing Rod III', price: 9000, job: 'fish', tier: 3 },
    { key: 'pick_1', name: 'Pickaxe I', price: 750, job: 'mine', tier: 1 },
    { key: 'pick_2', name: 'Pickaxe II', price: 3000, job: 'mine', tier: 2 },
    { key: 'pick_3', name: 'Pickaxe III', price: 9000, job: 'mine', tier: 3 },
    { key: 'bow_1', name: 'Bow I', price: 750, job: 'hunt', tier: 1 },
    { key: 'bow_2', name: 'Bow II', price: 3000, job: 'hunt', tier: 2 },
    { key: 'bow_3', name: 'Bow III', price: 9000, job: 'hunt', tier: 3 },
  ],
  Boosts: [
    { key: 'boost_coin', name: 'Coin Boost (15m, +25% daily coins)', price: 300, stat: 'coin', value: 25, durationMs: 900000 },
    { key: 'boost_luck', name: 'Luck Boost (15m, +25% gambling win)', price: 300, stat: 'win', value: 25, durationMs: 900000 },
    { key: 'boost_xp', name: 'XP Boost (15m, +25% XP)', price: 300, stat: 'xp', value: 25, durationMs: 900000 },
  ],
  'Pet Chests': [
    { key: 'chest_normal', name: 'Normal Chest', price: PET_PULL_COST, premium: false },
    { key: 'chest_premium', name: 'Premium Chest (5x luck)', price: 2000, premium: true },
  ],
  'Pet Items': [
    { key: 'buff_booster', name: 'Buff Booster (+2% permanent, pick a pet)', price: 1000, effect: 'booster', boost: 2 },
    { key: 'major_booster', name: 'Major Buff Booster (+5% permanent, pick a pet)', price: 3000, effect: 'booster', boost: 5 },
    { key: 'xp_elixir', name: 'XP Elixir (+200 pet XP instantly, pick a pet)', price: 500, effect: 'xp_elixir', xpAmount: 200 },
    { key: 'luck_charm', name: 'Luck Charm (better odds on your NEXT chest)', price: 400, effect: 'luck_charm' },
  ],
  Upgrades: [
    { key: 'slot2', name: 'Second Pet Slot (one-time)', price: 5000 },
    { key: 'slot3', name: 'Third Pet Slot (one-time, requires 2nd slot first)', price: 15000 },
    { key: 'daily_upgrade', name: 'Daily Booster (one-time, permanent +10% daily coins)', price: 4000 },
    { key: 'xp_cd_upgrade', name: 'Faster Grind (one-time, -15s off your XP cooldown)', price: 4000 },
  ],
};

const SKIN_CATALOG = [
  { key: 'golden', name: 'Golden', emoji: '✨', rarity: 'Common', price: 300 },
  { key: 'shadow', name: 'Shadow', emoji: '🌑', rarity: 'Common', price: 300 },
  { key: 'rainbow', name: 'Rainbow', emoji: '🌈', rarity: 'Rare', price: 800 },
  { key: 'crystal', name: 'Crystal', emoji: '💠', rarity: 'Rare', price: 800 },
  { key: 'inferno', name: 'Inferno', emoji: '🔥', rarity: 'Epic', price: 2000 },
  { key: 'cosmic', name: 'Cosmic', emoji: '🌌', rarity: 'Legendary', price: 5000 },
];
SHOP_ITEMS.Cosmetics = SKIN_CATALOG.map(s => ({
  key: `skin_${s.key}`, name: `${s.name} Skin (${s.rarity})`, price: s.price, effect: 'skin', skinKey: s.key,
}));
function skinByKey(key) {
  return SKIN_CATALOG.find(s => s.key === key);
}
function ownsSkin(userId, skinKey) {
  return !!db.prepare('SELECT 1 FROM pet_skins WHERE user_id = ? AND skin_key = ?').get(userId, skinKey);
}

function findShopItem(key) {
  for (const cat of SHOP_CATEGORIES) {
    const item = SHOP_ITEMS[cat].find(i => i.key === key);
    if (item) return { ...item, category: cat };
  }
  return null;
}

// Premium chest skews the odds toward rarer pets by reweighting the pool.
// A Luck Charm applies a second, smaller multiplier on top of whichever
// chest tier was used (works on Normal or Premium).
const PREMIUM_MULTIPLIER = { Common: 0.3, Rare: 1.2, Epic: 4, Legendary: 10 };
const CHARM_MULTIPLIER = { Common: 0.7, Rare: 1.3, Epic: 2, Legendary: 3 };
function rollPet(premium = false, charm = false) {
  const pool = PET_CATALOG.map(p => {
    let weight = p.weight;
    if (premium) weight *= PREMIUM_MULTIPLIER[p.rarity];
    if (charm) weight *= CHARM_MULTIPLIER[p.rarity];
    return { ...p, weight };
  });
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of pool) {
    if (r < p.weight) return p;
    r -= p.weight;
  }
  return pool[0];
}

function getOwnedTools(userId) {
  return db.prepare('SELECT * FROM owned_tools WHERE user_id = ?').all(userId);
}
function getToolTier(userId, jobKey) {
  const row = db.prepare('SELECT tier FROM owned_tools WHERE user_id = ? AND job_key = ?').get(userId, jobKey);
  return row ? row.tier : 0;
}
function getTool(userId, jobKey) {
  return db.prepare('SELECT * FROM owned_tools WHERE user_id = ? AND job_key = ?').get(userId, jobKey);
}
function setToolTier(userId, jobKey, tier) {
  db.prepare(
    'INSERT INTO owned_tools (user_id, job_key, tier, durability) VALUES (?, ?, ?, 100) ON CONFLICT(user_id, job_key) DO UPDATE SET tier = excluded.tier, durability = 100'
  ).run(userId, jobKey, tier);
}
function addBoost(userId, boostKey, stat, value, durationMs) {
  db.prepare('INSERT INTO active_boosts (user_id, boost_key, stat, value, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, boostKey, stat, value, Date.now() + durationMs);
}

// ---------- Jobs ----------
const JOB_LOOT = {
  fish: [
    { name: 'Old Boot', emoji: '👢', weight: 30, coinMin: 5, coinMax: 15, candyChance: 0, candyAmt: 0 },
    { name: 'Common Fish', emoji: '🐟', weight: 40, coinMin: 20, coinMax: 40, candyChance: 0.10, candyAmt: 1 },
    { name: 'Rare Fish', emoji: '🐠', weight: 22, coinMin: 60, coinMax: 100, candyChance: 0.30, candyAmt: 2 },
    { name: 'Big Catch', emoji: '🦈', weight: 8, coinMin: 150, coinMax: 300, candyChance: 0.60, candyAmt: 5 },
  ],
  mine: [
    { name: 'Rubble', emoji: '🪨', weight: 30, coinMin: 5, coinMax: 15, candyChance: 0, candyAmt: 0 },
    { name: 'Common Ore', emoji: '⛏️', weight: 40, coinMin: 20, coinMax: 40, candyChance: 0.10, candyAmt: 1 },
    { name: 'Gem', emoji: '💎', weight: 22, coinMin: 60, coinMax: 100, candyChance: 0.30, candyAmt: 2 },
    { name: 'Rare Gem', emoji: '🔮', weight: 8, coinMin: 150, coinMax: 300, candyChance: 0.60, candyAmt: 5 },
  ],
  hunt: [
    { name: 'Nothing', emoji: '🚫', weight: 30, coinMin: 5, coinMax: 15, candyChance: 0, candyAmt: 0 },
    { name: 'Small Game', emoji: '🐇', weight: 40, coinMin: 20, coinMax: 40, candyChance: 0.10, candyAmt: 1 },
    { name: 'Big Game', emoji: '🦌', weight: 22, coinMin: 60, coinMax: 100, candyChance: 0.30, candyAmt: 2 },
    { name: 'Trophy', emoji: '🏆', weight: 8, coinMin: 150, coinMax: 300, candyChance: 0.60, candyAmt: 5 },
  ],
};
const JOB_VERBS = { fish: 'fished up', mine: 'mined', hunt: 'hunted down' };
let doubleLootUntil = 0; // set by the random double-loot event loop below

function rollJobLoot(jobKey) {
  const table = JOB_LOOT[jobKey];
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const e of table) {
    if (r < e.weight) return e;
    r -= e.weight;
  }
  return table[0];
}
function getJobCooldownRemaining(userId, jobKey, cooldownMs) {
  const row = db.prepare('SELECT last_used FROM job_cooldowns WHERE user_id = ? AND job_key = ?').get(userId, jobKey);
  if (!row) return 0;
  const elapsed = Date.now() - row.last_used;
  return Math.max(0, cooldownMs - elapsed);
}
function setJobCooldown(userId, jobKey) {
  db.prepare(
    'INSERT INTO job_cooldowns (user_id, job_key, last_used) VALUES (?, ?, ?) ON CONFLICT(user_id, job_key) DO UPDATE SET last_used = excluded.last_used'
  ).run(userId, jobKey, Date.now());
}

async function runJob(interaction, jobKey) {
  const tier = getToolTier(interaction.user.id, jobKey);
  if (tier === 0) {
    await interaction.reply({ content: `You need a ${TOOL_LABELS[jobKey]} first — check \`/shop\` under Tools.`, ephemeral: true });
    return;
  }
  const cooldownMs = JOB_COOLDOWNS[tier];
  const remaining = getJobCooldownRemaining(interaction.user.id, jobKey, cooldownMs);
  if (remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    await interaction.reply({ content: `Not yet — ${mins}m left on your ${JOB_LABELS[jobKey]} cooldown.`, ephemeral: true });
    return;
  }

  setJobCooldown(interaction.user.id, jobKey);
  const loot = rollJobLoot(jobKey);
  const buff = getActiveBuff(interaction.user.id);
  const isDoubleLoot = Date.now() < doubleLootUntil;
  let baseCoin = Math.floor(Math.random() * (loot.coinMax - loot.coinMin + 1)) + loot.coinMin;
  if (isDoubleLoot) baseCoin *= 2;
  const coin = applyBuff(baseCoin, buff.coin);
  addBalance(interaction.user.id, coin);

  let candyLine = '';
  if (loot.candyAmt > 0 && Math.random() < loot.candyChance) {
    const candyAmt = isDoubleLoot ? loot.candyAmt * 2 : loot.candyAmt;
    addCandy(interaction.user.id, candyAmt);
    candyLine = ` + ${fmtCandy(candyAmt)}`;
  }
  trackQuest(interaction.user.id, `${jobKey}_any`);
  await incrementMilestone('total_jobs', interaction.user.id, 1);

  const embed = new EmbedBuilder()
    .setTitle(`${loot.emoji} You ${JOB_VERBS[jobKey]} a ${loot.name}!${isDoubleLoot ? ' 🎉 DOUBLE LOOT!' : ''}`)
    .setDescription(`+${fmt(coin)}${candyLine}`)
    .setColor(0x8D6E63)
    .setFooter({ text: `${TOOL_LABELS[jobKey]} tier ${tier}` });
  await interaction.reply({ embeds: [embed] });
}

// ---------- Pet sell-back ----------
const SELL_VALUE = {
  Common: { coin: 50, candy: 5 },
  Rare: { coin: 150, candy: 15 },
  Epic: { coin: 400, candy: 40 },
  Legendary: { coin: 1000, candy: 100 },
};
function sellPet(userId, petId) {
  const pet = getPet(petId);
  if (!pet || pet.user_id !== userId) return null;
  const catalog = petByKey(pet.pet_key);
  const value = SELL_VALUE[catalog.rarity];
  db.prepare('DELETE FROM active_pets WHERE pet_id = ?').run(petId); // unequip if it was equipped
  db.prepare('DELETE FROM pets WHERE id = ?').run(petId);
  addBalance(userId, value.coin);
  addCandy(userId, value.candy);
  return { catalog, value };
}

// ---------- Weekly quests ----------
const QUEST_TEMPLATES = [
  { key: 'bj3', desc: 'Win 3 games of Blackjack', trackKey: 'blackjack_win', target: 3, reward: { coin: 300, candy: 10 } },
  { key: 'fish5', desc: 'Go fishing 5 times', trackKey: 'fish_any', target: 5, reward: { coin: 250, candy: 15 } },
  { key: 'mine5', desc: 'Go mining 5 times', trackKey: 'mine_any', target: 5, reward: { coin: 250, candy: 15 } },
  { key: 'hunt5', desc: 'Go hunting 5 times', trackKey: 'hunt_any', target: 5, reward: { coin: 250, candy: 15 } },
  { key: 'trivia3', desc: 'Answer 3 trivia questions correctly', trackKey: 'trivia_correct', target: 3, reward: { coin: 200, candy: 10 } },
  { key: 'slots3', desc: 'Hit 3 slots jackpots', trackKey: 'slots_jackpot', target: 3, reward: { coin: 400, candy: 20 } },
  { key: 'daily3', desc: 'Claim /daily 3 times', trackKey: 'daily_claim', target: 3, reward: { coin: 200, candy: 10 } },
  { key: 'feed3', desc: 'Feed a pet with candy 3 times', trackKey: 'pet_feed', target: 3, reward: { coin: 150, candy: 20 } },
];

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNo}`;
}

function getCurrentQuests() {
  const weekKey = isoWeekKey();
  let row = db.prepare('SELECT * FROM weekly_quests WHERE week_key = ?').get(weekKey);
  if (!row) {
    const shuffled = [...QUEST_TEMPLATES].sort(() => Math.random() - 0.5);
    const chosen = shuffled.slice(0, 3).map(q => q.key);
    db.prepare('INSERT INTO weekly_quests (week_key, quest_keys) VALUES (?, ?)').run(weekKey, JSON.stringify(chosen));
    row = { week_key: weekKey, quest_keys: JSON.stringify(chosen) };
  }
  const keys = JSON.parse(row.quest_keys);
  return { weekKey, quests: keys.map(k => QUEST_TEMPLATES.find(q => q.key === k)).filter(Boolean) };
}

function getQuestProgress(userId, weekKey, questKey) {
  const row = db.prepare('SELECT * FROM quest_progress WHERE user_id = ? AND week_key = ? AND quest_key = ?').get(userId, weekKey, questKey);
  return row || { progress: 0, claimed: 0 };
}

function trackQuest(userId, trackKey, amount = 1) {
  const { weekKey, quests } = getCurrentQuests();
  const quest = quests.find(q => q.trackKey === trackKey);
  if (!quest) return;
  const current = getQuestProgress(userId, weekKey, quest.key);
  if (current.claimed) return; // already claimed, no point tracking further
  const newProgress = Math.min(quest.target, current.progress + amount);
  db.prepare(
    'INSERT INTO quest_progress (user_id, week_key, quest_key, progress, claimed) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id, week_key, quest_key) DO UPDATE SET progress = excluded.progress'
  ).run(userId, weekKey, quest.key, newProgress);
}

// ---------- Pet trading ----------
const tradeOffers = new Map(); // offerId -> { fromUserId, toUserId, fromPetId, toPetId, timeout }

function executeTrade(offer) {
  const fromPet = getPet(offer.fromPetId);
  const toPet = getPet(offer.toPetId);
  if (!fromPet || !toPet || fromPet.user_id !== offer.fromUserId || toPet.user_id !== offer.toUserId) {
    return false; // one side no longer owns their pet (sold/traded elsewhere since the offer)
  }
  db.prepare('DELETE FROM active_pets WHERE pet_id IN (?, ?)').run(offer.fromPetId, offer.toPetId);
  db.prepare('UPDATE pets SET user_id = ? WHERE id = ?').run(offer.toUserId, offer.fromPetId);
  db.prepare('UPDATE pets SET user_id = ? WHERE id = ?').run(offer.fromUserId, offer.toPetId);
  return true;
}

// ---------- Achievements / titles ----------
const ACHIEVEMENT_DEFS = [
  { key: 'first_legendary', name: 'Legendary Finder', title: '🌟 Legendary Finder',
    met: (u, pets) => pets.some(p => petByKey(p.pet_key).rarity === 'Legendary') },
  { key: 'card_shark', name: 'Card Shark', title: '🃏 Card Shark', met: (u) => u.blackjack_wins >= 50 },
  { key: 'collector', name: 'Collector', title: '🎒 Collector', met: (u) => u.pet_slots >= 3 },
  { key: 'grinder', name: 'Grinder', title: '⭐ Grinder', met: (u) => u.level >= 10 },
  { key: 'battle_champion', name: 'Battle Champion', title: '⚔️ Battle Champion', met: (u) => u.battle_wins >= 10 },
];

function getUnlockedAchievements(userId) {
  return JSON.parse(getUser(userId).achievements || '[]');
}
function unlockAchievement(userId, key) {
  const list = getUnlockedAchievements(userId);
  if (list.includes(key)) return false;
  list.push(key);
  const def = ACHIEVEMENT_DEFS.find(a => a.key === key);
  db.prepare('UPDATE users SET achievements = ?, active_title = ? WHERE user_id = ?').run(JSON.stringify(list), def.title, userId);
  return true;
}
function checkAchievements(userId) {
  const user = getUser(userId);
  const pets = getUserPets(userId);
  const owned = new Set(getUnlockedAchievements(userId));
  const newly = [];
  for (const def of ACHIEVEMENT_DEFS) {
    if (!owned.has(def.key) && def.met(user, pets)) {
      if (unlockAchievement(userId, def.key)) newly.push(def);
    }
  }
  return newly;
}

// ---------- Pet battles ----------
const battleOffers = new Map(); // offerId -> { challengerId, opponentId, challengerPetId, wager, timeout }

function petPower(pet) {
  const catalog = petByKey(pet.pet_key);
  const buffSum = (catalog.buff.xp + catalog.buff.coin + catalog.buff.win) + ((pet.bonus_xp || 0) + (pet.bonus_coin || 0) + (pet.bonus_win || 0));
  return pet.level * (10 + buffSum);
}

// Returns an error message if the battle can't go ahead fairly, or null if it can.
function battleProblem(challengerId, opponentId, challengerPetId, opponentPetId, wager) {
  const cPet = getPet(challengerPetId);
  if (!cPet || cPet.user_id !== challengerId) return "The challenger's pet is no longer theirs — battle cancelled.";
  if (opponentPetId != null) {
    const oPet = getPet(opponentPetId);
    if (!oPet || oPet.user_id !== opponentId) return "That pet isn't yours anymore.";
  }
  if (wager > 0) {
    if (getUser(challengerId).balance < wager) return `The challenger no longer has ${fmt(wager)} to cover the wager — battle cancelled.`;
    if (getUser(opponentId).balance < wager) return `You need ${fmt(wager)} to accept this wager.`;
  }
  return null;
}
function resolveBattle(challengerId, opponentId, challengerPetId, opponentPetId, wager) {
  const challengerPet = getPet(challengerPetId);
  const opponentPet = getPet(opponentPetId);
  const powerA = petPower(challengerPet);
  const powerB = petPower(opponentPet);
  const challengerWins = Math.random() < powerA / (powerA + powerB);
  const winnerId = challengerWins ? challengerId : opponentId;
  const loserId = challengerWins ? opponentId : challengerId;

  let wagerPaid = 0;
  if (wager > 0) {
    const winnerBal = getUser(winnerId).balance;
    const loserBal = getUser(loserId).balance;
    if (loserBal >= wager) { // always true: battleProblem() checks both balances right before this runs
      addBalance(loserId, -wager);
      addBalance(winnerId, wager);
      wagerPaid = wager;
    }
  }
  db.prepare('UPDATE users SET battle_wins = battle_wins + 1 WHERE user_id = ?').run(winnerId);
  checkAchievements(winnerId);

  return {
    winnerId, loserId, wagerPaid,
    challengerPet, opponentPet, powerA, powerB,
    winnerCatalog: petByKey((challengerWins ? challengerPet : opponentPet).pet_key),
    loserCatalog: petByKey((challengerWins ? opponentPet : challengerPet).pet_key),
  };
}

// ---------- Roulette (vs house) ----------
const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
function spinRoulette() { return Math.floor(Math.random() * 37); } // 0-36
function rouletteColor(n) { if (n === 0) return 'green'; return ROULETTE_RED.has(n) ? 'red' : 'black'; }

function validateRouletteBet(betType, valueRaw) {
  if (betType === 'number') {
    const n = parseInt(valueRaw, 10);
    return !isNaN(n) && n >= 0 && n <= 36;
  }
  if (betType === 'color') return ['red', 'black'].includes(valueRaw);
  if (betType === 'parity') return ['odd', 'even'].includes(valueRaw);
  if (betType === 'range') return ['low', 'high'].includes(valueRaw);
  return false;
}

// Pure resolution: given the spin result, does this bet win, and at what multiplier?
function evaluateRouletteBet(betType, valueRaw, result) {
  const color = rouletteColor(result);
  if (betType === 'number') return { won: parseInt(valueRaw, 10) === result, payoutMultiplier: 36 };
  if (betType === 'color') return { won: valueRaw === color, payoutMultiplier: 2 };
  if (betType === 'parity') return { won: result !== 0 && (result % 2 === 0 ? 'even' : 'odd') === valueRaw, payoutMultiplier: 2 };
  if (betType === 'range') return { won: result !== 0 && (result <= 18 ? 'low' : 'high') === valueRaw, payoutMultiplier: 2 };
  return { won: false, payoutMultiplier: 0 };
}

// ---------- Duel (proper multiplayer — first non-vs-house game) ----------
const duelOffers = new Map(); // offerId -> { challengerId, opponentId, amount, timeout }
const CARD_RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
function highCardRank(rank) { return CARD_RANK_ORDER.indexOf(rank); } // Ace high for duel purposes

// Pure resolution: draws both cards, transfers the wager, returns everything
// needed to render the result. No Discord objects touched here.
function resolveDuel(challengerId, opponentId, amount) {
  addBalance(challengerId, -amount);
  addBalance(opponentId, -amount);

  const deck = buildDeck();
  const challengerCard = deck.pop();
  const opponentCard = deck.pop();
  const cRank = highCardRank(challengerCard.rank);
  const oRank = highCardRank(opponentCard.rank);

  if (cRank === oRank) {
    addBalance(challengerId, amount);
    addBalance(opponentId, amount);
    return { tie: true, challengerCard, opponentCard, winnerId: null };
  }
  const winnerId = cRank > oRank ? challengerId : opponentId;
  addBalance(winnerId, amount * 2);
  return { tie: false, challengerCard, opponentCard, winnerId };
}

// ---------- Shop UI ----------
function buildShopCategoryRow(selected) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('shop_category')
    .setPlaceholder('Choose a category')
    .addOptions(SHOP_CATEGORIES.map(cat => ({ label: cat, value: cat, default: cat === selected })));
  return new ActionRowBuilder().addComponents(menu);
}

function buildShopItemButtons(category) {
  const items = SHOP_ITEMS[category];
  const rows = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      items.slice(i, i + 5).map(item =>
        new ButtonBuilder()
          .setCustomId(`shop_buy_${item.key}`)
          .setLabel(`${item.name} — ${item.price}`)
          .setStyle(ButtonStyle.Primary)
      )
    ));
  }
  return rows.slice(0, 4); // Discord caps 5 action rows per message, leave 1 for the select menu
}

function buildShopEmbed(category, userId) {
  const user = getUser(userId);
  const items = SHOP_ITEMS[category];
  const lines = items.map(item => {
    let extra = '';
    if (item.job) {
      const owned = getToolTier(userId, item.job);
      extra = owned >= item.tier ? ' *(owned)*' : owned === item.tier - 1 ? '' : owned > 0 ? ' *(skips a tier)*' : '';
    }
    if (item.key === 'slot2' && user.pet_slots >= 2) extra = ' *(owned)*';
    return `**${item.name}** — ${fmt(item.price)}${extra}`;
  });
  return new EmbedBuilder()
    .setTitle('🛒 Shop')
    .setColor(0x66BB6A)
    .setDescription(`**${category}**\n\n${lines.join('\n')}`)
    .setFooter({ text: `Your balance: ${user.balance.toLocaleString()} ${CURRENCY_NAME}` });
}

async function purchaseItem(interaction, itemKey) {
  const item = findShopItem(itemKey);
  if (!item) return interaction.reply({ content: 'Unknown item.', ephemeral: true });

  const user = getUser(interaction.user.id);
  if (user.balance < item.price) {
    return interaction.reply({ content: `You need ${fmt(item.price)} — you have ${fmt(user.balance)}.`, ephemeral: true });
  }

  if (item.category === 'Tools') {
    const owned = getToolTier(interaction.user.id, item.job);
    if (owned >= item.tier) {
      return interaction.reply({ content: `You already own ${TOOL_LABELS[item.job]} tier ${owned} or better.`, ephemeral: true });
    }
    addBalance(interaction.user.id, -item.price);
    setToolTier(interaction.user.id, item.job, item.tier);
    const cooldownMin = JOB_COOLDOWNS[item.tier] / 60000;
    return interaction.reply({ content: `✅ Bought **${item.name}**! Your ${JOB_LABELS[item.job]} cooldown is now ${cooldownMin} min.`, ephemeral: true });
  }

  if (item.category === 'Boosts') {
    addBalance(interaction.user.id, -item.price);
    addBoost(interaction.user.id, item.key, item.stat, item.value, item.durationMs);
    return interaction.reply({ content: `✅ **${item.name}** activated — check \`/inventory\` for the countdown.`, ephemeral: true });
  }

  if (item.category === 'Pet Chests') {
    addBalance(interaction.user.id, -item.price);
    const hadCharm = user.pending_luck_charm === 1;
    if (hadCharm) db.prepare('UPDATE users SET pending_luck_charm = 0 WHERE user_id = ?').run(interaction.user.id);
    const pet = rollPet(item.premium, hadCharm);
    const petId = addPetToUser(interaction.user.id, pet.key);
    checkAchievements(interaction.user.id);
    const embed = new EmbedBuilder()
      .setTitle(`${pet.emoji} ${item.name} → You got a ${pet.name}!`)
      .setDescription(`Rarity: **${pet.rarity}**\nBuff: ${describeBuff(pet.buff)}${hadCharm ? '\n🍀 Luck Charm was applied to this pull.' : ''}`)
      .setColor(RARITY_COLOR[pet.rarity])
      .setFooter({ text: `Pet ID #${petId} — /pet-equip id:${petId} to use its buff` });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (item.category === 'Pet Items') {
    if (item.effect === 'luck_charm') {
      if (user.pending_luck_charm === 1) {
        return interaction.reply({ content: '🍀 You already have a Luck Charm waiting — it applies to your next chest. Nothing was charged.', ephemeral: true });
      }
      addBalance(interaction.user.id, -item.price);
      db.prepare('UPDATE users SET pending_luck_charm = 1 WHERE user_id = ?').run(interaction.user.id);
      return interaction.reply({ content: '🍀 Luck Charm active — your next chest purchase (Normal or Premium) gets improved odds.', ephemeral: true });
    }

    // booster / xp_elixir both need the user to pick a target pet
    const eligible = item.effect === 'booster'
      ? getUserPets(interaction.user.id).filter(p => !p.booster_used)
      : getUserPets(interaction.user.id);
    if (!eligible.length) {
      const msg = item.effect === 'booster'
        ? 'Every pet you own already has a booster (one per pet, max) — get a new pet first.'
        : "You don't have any pets yet — try a Pet Chest first.";
      return interaction.reply({ content: msg, ephemeral: true });
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`pet_item_target_${item.key}`)
      .setPlaceholder('Choose a pet')
      .addOptions(eligible.slice(0, 25).map(p => {
        const c = petByKey(p.pet_key);
        return { label: `${c.name} (#${p.id}, Lv.${p.level})`, value: String(p.id) };
      }));
    return interaction.reply({ content: `Pick a pet for the ${item.name} — ${fmt(item.price)} is only charged once you choose:`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
  }

  if (item.category === 'Upgrades') {
    if (item.key === 'slot2') {
      if (user.pet_slots >= 2) return interaction.reply({ content: 'You already own the 2nd pet slot.', ephemeral: true });
      addBalance(interaction.user.id, -item.price);
      db.prepare('UPDATE users SET pet_slots = 2 WHERE user_id = ?').run(interaction.user.id);
      return interaction.reply({ content: '✅ Unlocked a 2nd pet slot! Use `/pet-equip id: slot:2` to fill it.', ephemeral: true });
    }
    if (item.key === 'slot3') {
      if (user.pet_slots < 2) return interaction.reply({ content: 'You need the 2nd pet slot first.', ephemeral: true });
      if (user.pet_slots >= 3) return interaction.reply({ content: 'You already own the 3rd pet slot.', ephemeral: true });
      addBalance(interaction.user.id, -item.price);
      db.prepare('UPDATE users SET pet_slots = 3 WHERE user_id = ?').run(interaction.user.id);
      checkAchievements(interaction.user.id);
      return interaction.reply({ content: '✅ Unlocked a 3rd pet slot! Use `/pet-equip id: slot:3` to fill it.', ephemeral: true });
    }
    if (item.key === 'daily_upgrade') {
      if (user.perm_daily_bonus > 0) return interaction.reply({ content: 'You already own the Daily Booster.', ephemeral: true });
      addBalance(interaction.user.id, -item.price);
      db.prepare('UPDATE users SET perm_daily_bonus = perm_daily_bonus + 10 WHERE user_id = ?').run(interaction.user.id);
      return interaction.reply({ content: '✅ Daily Booster active — permanent +10% on `/daily`, stacking with any pet/boost coin buffs.', ephemeral: true });
    }
    if (item.key === 'xp_cd_upgrade') {
      if (user.perm_xp_cd_reduction > 0) return interaction.reply({ content: 'You already own Faster Grind.', ephemeral: true });
      addBalance(interaction.user.id, -item.price);
      db.prepare('UPDATE users SET perm_xp_cd_reduction = 15000 WHERE user_id = ?').run(interaction.user.id);
      return interaction.reply({ content: '✅ Faster Grind active — your XP cooldown just dropped from 60s to 45s.', ephemeral: true });
    }
    return interaction.reply({ content: 'Unknown upgrade.', ephemeral: true });
  }

  if (item.category === 'Cosmetics') {
    if (ownsSkin(interaction.user.id, item.skinKey)) {
      return interaction.reply({ content: 'You already own this skin.', ephemeral: true });
    }
    addBalance(interaction.user.id, -item.price);
    db.prepare('INSERT INTO pet_skins (user_id, skin_key) VALUES (?, ?)').run(interaction.user.id, item.skinKey);
    const skin = skinByKey(item.skinKey);
    return interaction.reply({ content: `✅ Bought the ${skin.emoji} **${skin.name}** skin! Use \`/pet-skin\` to apply it to a pet.`, ephemeral: true });
  }
}

// ---------- Pet evolution ----------
const EVOLVE_LEVEL = 10;
const EVOLVE_COST = {
  Common: { candy: 100, coin: 1000 },
  Rare: { candy: 200, coin: 2500 },
  Epic: { candy: 400, coin: 5000 },
  Legendary: { candy: 800, coin: 10000 },
};
const EVOLVE_MULTIPLIER = 1.5;

function evolvedName(catalog) {
  return `⚡ ${catalog.name}`;
}

// ---------- Co-op boss event ----------
const BOSS_BASE_HP = 5000;
const BOSS_REWARD = { coin: 5000, candy: 500 };
const BOSS_ATTACK_COOLDOWN_MS = 5 * 60 * 1000;
let currentBoss = null; // { hp, maxHp, contributions: Map<userId, number>, channelId }
const bossAttackCooldowns = new Map(); // userId -> last attack timestamp

function bossHpBar(hp, maxHp, size = 20) {
  const filled = Math.round((hp / maxHp) * size);
  return '🟥'.repeat(Math.max(0, filled)) + '⬛'.repeat(size - Math.max(0, filled));
}

// ---------- General trade (coins / candy / pets, any combination) ----------
const generalTradeOffers = new Map(); // offerId -> offer

function describeTradeSide(side) {
  const parts = [];
  if (side.coin > 0) parts.push(fmt(side.coin));
  if (side.candy > 0) parts.push(fmtCandy(side.candy));
  if (side.petId) {
    const pet = getPet(side.petId);
    if (pet) { const c = petByKey(pet.pet_key); parts.push(`${c.emoji} ${c.name} (#${side.petId})`); }
  }
  return parts.length ? parts.join(' + ') : 'nothing';
}

function canAffordTradeSide(userId, side) {
  const user = getUser(userId);
  if (user.balance < side.coin) return false;
  if (user.candy < side.candy) return false;
  if (side.petId) {
    const pet = getPet(side.petId);
    if (!pet || pet.user_id !== userId) return false;
  }
  return true;
}

function executeGeneralTrade(offer) {
  if (!canAffordTradeSide(offer.fromUserId, offer.give) || !canAffordTradeSide(offer.toUserId, offer.request)) return false;
  const { give, request, fromUserId, toUserId } = offer;
  if (give.coin > 0) { addBalance(fromUserId, -give.coin); addBalance(toUserId, give.coin); }
  if (give.candy > 0) { addCandy(fromUserId, -give.candy); addCandy(toUserId, give.candy); }
  if (request.coin > 0) { addBalance(toUserId, -request.coin); addBalance(fromUserId, request.coin); }
  if (request.candy > 0) { addCandy(toUserId, -request.candy); addCandy(fromUserId, request.candy); }
  if (give.petId) { db.prepare('DELETE FROM active_pets WHERE pet_id = ?').run(give.petId); db.prepare('UPDATE pets SET user_id = ? WHERE id = ?').run(toUserId, give.petId); }
  if (request.petId) { db.prepare('DELETE FROM active_pets WHERE pet_id = ?').run(request.petId); db.prepare('UPDATE pets SET user_id = ? WHERE id = ?').run(fromUserId, request.petId); }
  return true;
}

// ---------- Server-wide milestone ----------
const MILESTONE_ANNOUNCE_CHANNEL_ID = process.env.DOUBLE_LOOT_CHANNEL_ID || '1413262822082744322';

function seedMilestone(key, target, rewardCoin, rewardCandy) {
  const existing = db.prepare('SELECT * FROM server_milestone WHERE key = ?').get(key);
  if (existing) return existing;
  db.prepare('INSERT INTO server_milestone (key, progress, target, reward_coin, reward_candy, achieved) VALUES (?, 0, ?, ?, ?, 0)')
    .run(key, target, rewardCoin, rewardCandy);
  return db.prepare('SELECT * FROM server_milestone WHERE key = ?').get(key);
}
function getMilestone(key) {
  return db.prepare('SELECT * FROM server_milestone WHERE key = ?').get(key)
    || seedMilestone('total_jobs', 500, 500, 50);
}
async function incrementMilestone(key, userId, amount = 1) {
  const m = getMilestone(key);
  if (m.achieved) return;

  db.prepare('UPDATE server_milestone SET progress = progress + ? WHERE key = ?').run(amount, key);
  db.prepare(
    'INSERT INTO milestone_contributions (milestone_key, user_id, amount) VALUES (?, ?, ?) ON CONFLICT(milestone_key, user_id) DO UPDATE SET amount = amount + excluded.amount'
  ).run(key, userId, amount);

  const updated = getMilestone(key);
  if (updated.progress >= updated.target && !updated.achieved) {
    db.prepare('UPDATE server_milestone SET achieved = 1 WHERE key = ?').run(key);
    const contributors = db.prepare('SELECT user_id FROM milestone_contributions WHERE milestone_key = ?').all(key);
    for (const c of contributors) {
      addBalance(c.user_id, updated.reward_coin);
      addCandy(c.user_id, updated.reward_candy);
    }
    try {
      const channel = await client.channels.fetch(MILESTONE_ANNOUNCE_CHANNEL_ID);
      await channel.send(
        `🏆 **Server milestone reached!** The community hit ${updated.target} total job runs — ` +
        `every contributor (${contributors.length}) just got ${fmt(updated.reward_coin)} + ${fmtCandy(updated.reward_candy)}!`
      );
    } catch (e) { console.error('milestone announce failed:', e.message); }
  }
}

// ---------- Discord client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('balance').setDescription(`Check your ${CURRENCY_NAME} balance`)
      .addUserOption(o => o.setName('user').setDescription('Whose balance to check (defaults to you)')),
    new SlashCommandBuilder().setName('daily').setDescription(`Claim your daily ${CURRENCY_NAME}`),
    new SlashCommandBuilder().setName('monthly').setDescription(`Claim your monthly ${CURRENCY_NAME}`),
    new SlashCommandBuilder().setName('yearly').setDescription(`Claim your yearly ${CURRENCY_NAME}`),
    new SlashCommandBuilder().setName('prestige').setDescription(`Reset your level at cap ${PRESTIGE_LEVEL_CAP} for a permanent buff and badge`),
    new SlashCommandBuilder().setName('milestone').setDescription('Check the server-wide job milestone progress'),
    new SlashCommandBuilder().setName('pet-skin').setDescription('Apply (or remove) an owned skin on a pet')
      .addIntegerOption(o => o.setName('id').setDescription('Pet ID (from /pets)').setRequired(true))
      .addStringOption(o => o.setName('skin').setDescription('Skin to apply — omit to remove')
        .addChoices(...SKIN_CATALOG.map(s => ({ name: `${s.name} (${s.rarity})`, value: s.key })))),
    new SlashCommandBuilder().setName('roulette').setDescription('Bet on the roulette wheel (0-36)')
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('bet_type').setDescription('What to bet on').setRequired(true)
        .addChoices(
          { name: 'Number (35:1)', value: 'number' },
          { name: 'Color — red/black (1:1)', value: 'color' },
          { name: 'Odd/Even (1:1)', value: 'parity' },
          { name: 'Low(1-18)/High(19-36) (1:1)', value: 'range' },
        ))
      .addStringOption(o => o.setName('value').setDescription('e.g. 17, red, odd, high').setRequired(true)),
    new SlashCommandBuilder().setName('duel').setDescription('Challenge someone to a high-card duel — winner takes both antes')
      .addUserOption(o => o.setName('user').setDescription('Who to challenge').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount each side antes').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName('pay').setDescription(`Send ${CURRENCY_NAME} to someone`)
      .addUserOption(o => o.setName('user').setDescription('Recipient').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName('leaderboard').setDescription(`Top ${CURRENCY_NAME} holders in this server`),
    new SlashCommandBuilder().setName('rank').setDescription('Check your (or someone else\'s) level and XP')
      .addUserOption(o => o.setName('user').setDescription('Whose rank to check (defaults to you)')),
    new SlashCommandBuilder().setName('xp-leaderboard').setDescription('Top levels/XP in this server'),
    new SlashCommandBuilder().setName('coinflip').setDescription('Bet on a coin flip')
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('call').setDescription('Heads or tails').setRequired(true)
        .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })),
    new SlashCommandBuilder().setName('slots').setDescription('Spin the slot machine')
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName('blackjack').setDescription('Play a hand of blackjack against the dealer')
      .addIntegerOption(o => o.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName('trivia').setDescription(`Answer a trivia question for ${CURRENCY_NAME}`),
    new SlashCommandBuilder().setName('pet-pull').setDescription(`Spend ${fmt2(PET_PULL_COST)} for a random pet`),
    new SlashCommandBuilder().setName('pets').setDescription('View your (or someone else\'s) pet collection')
      .addUserOption(o => o.setName('user').setDescription('Whose pets to view (defaults to you)')),
    new SlashCommandBuilder().setName('pet-info').setDescription('View one pet in detail')
      .addIntegerOption(o => o.setName('id').setDescription('Pet ID (from /pets)').setRequired(true)),
    new SlashCommandBuilder().setName('pet-feed').setDescription('Feed a pet candy to level it up (candy comes from jobs/chests, not coins)')
      .addIntegerOption(o => o.setName('id').setDescription('Pet ID (from /pets)').setRequired(true))
      .addIntegerOption(o => o.setName('amount').setDescription('Candy to feed it').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName('pet-equip').setDescription('Set an active pet — its buffs apply to you while equipped')
      .addIntegerOption(o => o.setName('id').setDescription('Pet ID (from /pets)').setRequired(true))
      .addIntegerOption(o => o.setName('slot').setDescription('Which slot (only relevant if you own a 2nd slot)').addChoices({ name: '1', value: 1 }, { name: '2', value: 2 }, { name: '3', value: 3 })),
    new SlashCommandBuilder().setName('shop').setDescription('Browse and buy tools, boosts, chests, and upgrades'),
    new SlashCommandBuilder().setName('inventory').setDescription('View your tools, active boosts, and pet slots'),
    new SlashCommandBuilder().setName('fish').setDescription('Go fishing (needs a Fishing Rod from /shop)'),
    new SlashCommandBuilder().setName('mine').setDescription('Go mining (needs a Pickaxe from /shop)'),
    new SlashCommandBuilder().setName('hunt').setDescription('Go hunting (needs a Bow from /shop)'),
    new SlashCommandBuilder().setName('pet-sell').setDescription('Sell a pet for partial coins/candy back')
      .addIntegerOption(o => o.setName('id').setDescription('Pet ID (from /pets)').setRequired(true)),
    new SlashCommandBuilder().setName('quests').setDescription('View this week\'s quests and claim rewards'),
    new SlashCommandBuilder().setName('pet-trade').setDescription('Offer to trade one of your pets for one of theirs')
      .addUserOption(o => o.setName('user').setDescription('Who to trade with').setRequired(true))
      .addIntegerOption(o => o.setName('your_pet').setDescription('Your pet ID').setRequired(true))
      .addIntegerOption(o => o.setName('their_pet').setDescription('Their pet ID').setRequired(true)),
    new SlashCommandBuilder().setName('achievements').setDescription('View your unlocked achievements and title'),
    new SlashCommandBuilder().setName('pet-battle').setDescription('Challenge someone to a pet battle')
      .addUserOption(o => o.setName('user').setDescription('Who to challenge').setRequired(true))
      .addIntegerOption(o => o.setName('your_pet').setDescription('Your pet ID').setRequired(true))
      .addIntegerOption(o => o.setName('wager').setDescription('Optional coin wager (0 for bragging rights only)').setMinValue(0)),
    new SlashCommandBuilder().setName('pet-evolve').setDescription(`Evolve a level ${EVOLVE_LEVEL}+ pet into a stronger form`)
      .addIntegerOption(o => o.setName('id').setDescription('Pet ID (from /pets)').setRequired(true)),
    new SlashCommandBuilder().setName('boss').setDescription('Check the current co-op boss, or spawn one if none is active'),
    new SlashCommandBuilder().setName('boss-attack').setDescription('Attack the active boss with your equipped pet'),
    new SlashCommandBuilder().setName('trade').setDescription('Offer coins, candy, and/or a pet in exchange for theirs')
      .addUserOption(o => o.setName('user').setDescription('Who to trade with').setRequired(true))
      .addIntegerOption(o => o.setName('your_coin').setDescription('Coins you offer').setMinValue(0))
      .addIntegerOption(o => o.setName('your_candy').setDescription('Candy you offer').setMinValue(0))
      .addIntegerOption(o => o.setName('your_pet').setDescription('Your pet ID to offer'))
      .addIntegerOption(o => o.setName('their_coin').setDescription('Coins you want').setMinValue(0))
      .addIntegerOption(o => o.setName('their_candy').setDescription('Candy you want').setMinValue(0))
      .addIntegerOption(o => o.setName('their_pet').setDescription('Their pet ID you want')),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  for (const guildId of GUILD_IDS) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
      console.log(`Commands registered for guild ${guildId}`);
    } catch (e) {
      console.log(`Skipped guild ${guildId} (not joined yet or error): ${e.message}`);
    }
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const result = awardXp(message.author.id);
  if (result) {
    try {
      await message.channel.send(
        `🎉 ${message.author} leveled up to **Level ${result.newLevel}**! Bonus: ${fmt(result.bonus)}`
      );
    } catch (e) {
      console.error('Failed to send level-up message:', e.message);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  // ---------- Select menu interactions ----------
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('battle_pick_')) {
      const offerId = interaction.customId.replace('battle_pick_', '');
      const offer = battleOffers.get(offerId);
      const opponentPetId = parseInt(interaction.values[0], 10);
      if (!offer || interaction.user.id !== offer.opponentId) {
        await interaction.update({ content: 'This challenge is no longer active.', components: [] });
        return;
      }
      const problem = battleProblem(offer.challengerId, offer.opponentId, offer.challengerPetId, opponentPetId, offer.wager);
      if (problem) {
        // a pet or wager issue on the challenger's side ends the challenge; an opponent-side issue lets them fix it and retry
        if (problem.startsWith('The challenger')) { clearTimeout(offer.timeout); battleOffers.delete(offerId); }
        await interaction.update({ content: problem, components: [] });
        return;
      }
      clearTimeout(offer.timeout);
      battleOffers.delete(offerId);

      const result = resolveBattle(offer.challengerId, offer.opponentId, offer.challengerPetId, opponentPetId, offer.wager);
      await interaction.update({ content: 'Battle resolved — check the channel!', components: [] });

      const winnerMember = await interaction.guild.members.fetch(result.winnerId);
      const loserMember = await interaction.guild.members.fetch(result.loserId);
      const embed = new EmbedBuilder()
        .setTitle('⚔️ Battle Result')
        .setColor(0x66BB6A)
        .setDescription(
          `${result.winnerCatalog.emoji} **${result.winnerCatalog.name}** (${winnerMember.displayName}) defeated ` +
          `${result.loserCatalog.emoji} **${result.loserCatalog.name}** (${loserMember.displayName})!`
        )
        .addFields(
          { name: 'Power', value: `${result.powerA} vs ${result.powerB}`, inline: true },
          { name: 'Wager', value: result.wagerPaid > 0 ? fmt(result.wagerPaid) : 'None', inline: true },
        );
      await interaction.channel.send({ embeds: [embed] });
      return;
    }
    if (interaction.customId === 'shop_category') {
      const category = interaction.values[0];
      const embed = buildShopEmbed(category, interaction.user.id);
      const rows = [buildShopCategoryRow(category), ...buildShopItemButtons(category)];
      await interaction.update({ embeds: [embed], components: rows });
      return;
    }
    if (interaction.customId.startsWith('pet_item_target_')) {
      const itemKey = interaction.customId.replace('pet_item_target_', '');
      const item = findShopItem(itemKey);
      const petId = parseInt(interaction.values[0], 10);
      const pet = getPet(petId);
      if (!item || !pet || pet.user_id !== interaction.user.id) {
        await interaction.update({ content: 'That pet is no longer available.', components: [] });
        return;
      }
      const catalog = petByKey(pet.pet_key);
      if (item.effect === 'booster' && pet.booster_used) {
        await interaction.update({ content: `${catalog.name} (#${petId}) already has a booster — nothing was charged. Pick a different pet from \`/shop\`.`, components: [] });
        return;
      }
      if (getUser(interaction.user.id).balance < item.price) {
        await interaction.update({ content: `You need ${fmt(item.price)} for the ${item.name} — nothing was charged.`, components: [] });
        return;
      }
      addBalance(interaction.user.id, -item.price);

      if (item.effect === 'booster') {
        // Boost whichever stat this pet already buffs the most (ties go xp > coin > win).
        const stats = ['xp', 'coin', 'win'];
        const best = stats.reduce((a, b) => (catalog.buff[b] > catalog.buff[a] ? b : a));
        const column = `bonus_${best}`;
        db.prepare(`UPDATE pets SET ${column} = ${column} + ${item.boost}, booster_used = 1 WHERE id = ?`).run(petId);
        await interaction.update({ content: `✅ ${catalog.emoji} **${catalog.name}** (#${petId}) got a permanent +${item.boost}% ${best} boost! (max one booster per pet — this one's used up)`, components: [] });
        return;
      }

      if (item.effect === 'xp_elixir') {
        const updated = feedPet(petId, item.xpAmount);
        const xpNeeded = petXpForLevel(updated.level);
        const lvlMsg = updated.leveledUp ? ` 🎉 Leveled up to **Level ${updated.level}**!` : '';
        await interaction.update({ content: `✅ ${catalog.emoji} **${catalog.name}** (#${petId}) drank the XP Elixir (+${item.xpAmount} XP).${lvlMsg}`, components: [] });
        return;
      }
    }
    return;
  }

  // ---------- Button interactions ----------
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('quest_claim_')) {
      const questKey = interaction.customId.replace('quest_claim_', '');
      const quest = QUEST_TEMPLATES.find(q => q.key === questKey);
      const { weekKey } = getCurrentQuests();
      const p = getQuestProgress(interaction.user.id, weekKey, questKey);
      if (!quest || p.progress < quest.target || p.claimed) {
        await interaction.reply({ content: 'Nothing to claim there.', ephemeral: true });
        return;
      }
      db.prepare('UPDATE quest_progress SET claimed = 1 WHERE user_id = ? AND week_key = ? AND quest_key = ?').run(interaction.user.id, weekKey, questKey);
      addBalance(interaction.user.id, quest.reward.coin);
      addCandy(interaction.user.id, quest.reward.candy);
      await interaction.reply({ content: `✅ Claimed: ${fmt(quest.reward.coin)} + ${fmtCandy(quest.reward.candy)}`, ephemeral: true });
      return;
    }

    if (interaction.customId.startsWith('gtrade_accept_') || interaction.customId.startsWith('gtrade_decline_')) {
      const accept = interaction.customId.startsWith('gtrade_accept_');
      const offerId = interaction.customId.replace(accept ? 'gtrade_accept_' : 'gtrade_decline_', '');
      const offer = generalTradeOffers.get(offerId);
      if (!offer) { await interaction.reply({ content: 'This trade offer is no longer active.', ephemeral: true }); return; }
      if (interaction.user.id !== offer.toUserId) { await interaction.reply({ content: "This offer isn't for you.", ephemeral: true }); return; }
      clearTimeout(offer.timeout);
      generalTradeOffers.delete(offerId);

      if (!accept) {
        await interaction.update({ content: 'Trade declined.', embeds: [], components: [] });
        return;
      }
      const ok = executeGeneralTrade(offer);
      await interaction.update({
        content: ok ? '✅ Trade completed!' : '❌ Trade failed — one side no longer has what was offered.',
        embeds: [], components: [],
      });
      return;
    }

    if (interaction.customId.startsWith('trade_accept_') || interaction.customId.startsWith('trade_decline_')) {
      const accept = interaction.customId.startsWith('trade_accept_');
      const offerId = interaction.customId.replace(accept ? 'trade_accept_' : 'trade_decline_', '');
      const offer = tradeOffers.get(offerId);
      if (!offer) {
        await interaction.reply({ content: 'This trade offer is no longer active.', ephemeral: true });
        return;
      }
      if (interaction.user.id !== offer.toUserId) {
        await interaction.reply({ content: "This offer isn't for you.", ephemeral: true });
        return;
      }
      clearTimeout(offer.timeout);
      tradeOffers.delete(offerId);

      if (!accept) {
        await interaction.update({ content: 'Trade declined.', embeds: [], components: [] });
        return;
      }
      const ok = executeTrade(offer);
      await interaction.update({
        content: ok ? '✅ Trade completed!' : '❌ Trade failed — one of the pets is no longer available.',
        embeds: [], components: [],
      });
      return;
    }

    if (interaction.customId.startsWith('battle_accept_')) {
      const offerId = interaction.customId.replace('battle_accept_', '');
      const offer = battleOffers.get(offerId);
      if (!offer) { await interaction.reply({ content: 'This challenge is no longer active.', ephemeral: true }); return; }
      if (interaction.user.id !== offer.opponentId) { await interaction.reply({ content: "This challenge isn't for you.", ephemeral: true }); return; }
      const acceptProblem = battleProblem(offer.challengerId, offer.opponentId, offer.challengerPetId, null, offer.wager);
      if (acceptProblem) { await interaction.reply({ content: acceptProblem, ephemeral: true }); return; }

      const pets = getUserPets(interaction.user.id);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`battle_pick_${offerId}`)
        .setPlaceholder('Choose your pet')
        .addOptions(pets.slice(0, 25).map(p => {
          const c = petByKey(p.pet_key);
          return { label: `${c.name} (#${p.id}, Lv.${p.level})`, value: String(p.id) };
        }));
      await interaction.reply({ content: 'Pick your pet for the battle:', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      return;
    }

    if (interaction.customId.startsWith('duel_accept_')) {
      const offerId = interaction.customId.replace('duel_accept_', '');
      const offer = duelOffers.get(offerId);
      if (!offer) { await interaction.reply({ content: 'This duel is no longer active.', ephemeral: true }); return; }
      if (interaction.user.id !== offer.opponentId) { await interaction.reply({ content: "This challenge isn't for you.", ephemeral: true }); return; }
      if (getUser(interaction.user.id).balance < offer.amount) { await interaction.reply({ content: `You don't have ${fmt(offer.amount)} to ante.`, ephemeral: true }); return; }
      if (getUser(offer.challengerId).balance < offer.amount) { await interaction.reply({ content: 'The challenger no longer has enough to cover their ante.', ephemeral: true }); return; }
      clearTimeout(offer.timeout);
      duelOffers.delete(offerId);

      const result = resolveDuel(offer.challengerId, offer.opponentId, offer.amount);

      let resultText;
      if (result.tie) {
        resultText = `🤝 Tie! Both drew ${result.challengerCard.rank}. Antes returned.`;
      } else {
        const winnerMember = await interaction.guild.members.fetch(result.winnerId);
        const winnerCard = result.winnerId === offer.challengerId ? result.challengerCard : result.opponentCard;
        const loserCard = result.winnerId === offer.challengerId ? result.opponentCard : result.challengerCard;
        resultText = `🎉 ${winnerMember.displayName} wins with ${renderCard(winnerCard)} vs ${renderCard(loserCard)}! Takes ${fmt(offer.amount * 2)}.`;
      }

      const challengerMember = await interaction.guild.members.fetch(offer.challengerId);
      const opponentMember = await interaction.guild.members.fetch(offer.opponentId);
      const embed = new EmbedBuilder()
        .setTitle('🃏 Duel Result')
        .setColor(0x66BB6A)
        .setDescription(`${challengerMember.displayName}: ${renderCard(result.challengerCard)}\n${opponentMember.displayName}: ${renderCard(result.opponentCard)}\n\n${resultText}`);
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    if (interaction.customId.startsWith('shop_buy_')) {
      const itemKey = interaction.customId.replace('shop_buy_', '');
      await purchaseItem(interaction, itemKey);
      return;
    }

    if (interaction.customId === 'bj_hit' || interaction.customId === 'bj_stand') {
      const game = blackjackGames.get(interaction.user.id);
      if (!game || interaction.message.id !== game.messageId) {
        await interaction.reply({ content: 'This game is no longer active.', ephemeral: true });
        return;
      }
      if (interaction.customId === 'bj_hit') {
        game.playerHand.push(game.deck.pop());
        const val = handValue(game.playerHand);
        if (val > 21) {
          await resolveBlackjack(game, interaction, true);
        } else {
          const embed = buildBlackjackEmbed(game);
          await interaction.update({ embeds: [embed], components: [buildBlackjackRow()] });
        }
      } else {
        await resolveBlackjack(game, interaction, false);
      }
      return;
    }

    if (interaction.customId.startsWith('triv_')) {
      const [, idxStr, msgId] = interaction.customId.split('_');
      const session = triviaSessions.get(msgId);
      if (!session || session.resolved) {
        await interaction.reply({ content: 'This question is already closed.', ephemeral: true });
        return;
      }
      const chosen = parseInt(idxStr, 10);
      const uid = interaction.user.id;
      const priorAttempts = session.attempts.get(uid) || 0;
      const attemptNumber = priorAttempts + 1; // the attempt happening right now
      session.attempts.set(uid, attemptNumber);

      if (chosen !== session.answer) {
        const nextReward = attemptNumber === 1 ? TRIVIA_REWARD_SECOND : 0;
        const hint = nextReward > 0
          ? `Not quite — one more try is worth ${fmt(nextReward)}, after that it's free.`
          : 'Not quite — no reward left for you on this one, but give it a guess anyway!';
        await interaction.reply({ content: `❌ ${hint}`, ephemeral: true });
        return;
      }

      session.resolved = true;
      const reward = attemptNumber === 1 ? TRIVIA_REWARD_FIRST : attemptNumber === 2 ? TRIVIA_REWARD_SECOND : 0;
      const newBalance = reward > 0 ? addBalance(uid, reward) : getUser(uid).balance;
      trackQuest(uid, 'trivia_correct');
      const q = TRIVIA_QUESTIONS[session.qIndex];
      const tierLabel = attemptNumber === 1 ? 'first try' : attemptNumber === 2 ? 'second try' : `try #${attemptNumber} — no reward`;
      const embed = new EmbedBuilder()
        .setTitle('🧠 Trivia — Correct!')
        .setDescription(`**${q.q}**\n\n✅ ${interaction.user.username} got it on their ${tierLabel}! Answer: **${q.choices[q.answer]}**`)
        .setColor(0x4CAF50)
        .addFields({ name: 'Reward', value: reward > 0 ? fmt(reward) : 'None', inline: true }, { name: 'New balance', value: fmt(newBalance), inline: true });
      const disabledRow = new ActionRowBuilder().addComponents(
        q.choices.map((c, i) => new ButtonBuilder()
          .setCustomId(`triv_${i}_${msgId}`)
          .setLabel(c)
          .setStyle(i === session.answer ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(true))
      );
      await interaction.update({ embeds: [embed], components: [disabledRow] });
      triviaSessions.delete(msgId);
      return;
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'balance') {
    const target = interaction.options.getUser('user') || interaction.user;
    const row = getUser(target.id);
    const pronoun = target.id === interaction.user.id ? 'Your' : `${target.username}'s`;
    await interaction.reply(`${pronoun} balance: ${fmt(row.balance)} · ${fmtCandy(row.candy)}`);
    return;
  }

  if (interaction.commandName === 'daily') {
    const row = getUser(interaction.user.id);
    const now = Date.now();
    const elapsed = now - row.last_daily;
    if (elapsed < DAILY_COOLDOWN_MS) {
      const remaining = DAILY_COOLDOWN_MS - elapsed;
      const hours = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      await interaction.reply({ content: `Already claimed — try again in ${hours}h ${mins}m.`, ephemeral: true });
      return;
    }
    setLastDaily(interaction.user.id, now);
    const buff = getActiveBuff(interaction.user.id);
    const totalCoinPct = buff.coin + row.perm_daily_bonus;
    const boosted = applyBuff(DAILY_AMOUNT, totalCoinPct);
    const newBalance = addBalance(interaction.user.id, boosted);
    const buffNote = totalCoinPct > 0 ? ` (+${totalCoinPct}% from pets/boosts/upgrades)` : '';
    trackQuest(interaction.user.id, 'daily_claim');
    await interaction.reply(`Claimed your daily ${fmt(boosted)}${buffNote}! New balance: ${fmt(newBalance)}`);
    return;
  }

  if (interaction.commandName === 'roulette') {
    const amount = interaction.options.getInteger('amount', true);
    const betType = interaction.options.getString('bet_type', true);
    const valueRaw = interaction.options.getString('value', true).toLowerCase().trim();
    const user = getUser(interaction.user.id);
    if (user.balance < amount) { await interaction.reply({ content: `You only have ${fmt(user.balance)}.`, ephemeral: true }); return; }

    if (!validateRouletteBet(betType, valueRaw)) { await interaction.reply({ content: `Invalid value "${valueRaw}" for bet type "${betType}".`, ephemeral: true }); return; }

    addBalance(interaction.user.id, -amount);
    const result = spinRoulette();
    const color = rouletteColor(result);
    const { won, payoutMultiplier } = evaluateRouletteBet(betType, valueRaw, result);

    const buff = getActiveBuff(interaction.user.id);
    let winnings = 0;
    if (won) { winnings = applyBuff(amount * payoutMultiplier, buff.win); addBalance(interaction.user.id, winnings); }
    const newBalance = getUser(interaction.user.id).balance;

    const colorEmoji = color === 'red' ? '🔴' : color === 'black' ? '⚫' : '🟢';
    const embed = new EmbedBuilder()
      .setTitle('🎡 Roulette')
      .setDescription(`Ball landed on **${result}** ${colorEmoji}`)
      .setColor(won ? 0x4CAF50 : 0xE53935)
      .addFields(
        { name: won ? '🎉 You won' : '💥 You lost', value: won ? `+${fmt(winnings - amount)}` : `Lost ${fmt(amount)}`, inline: true },
        { name: 'New balance', value: fmt(newBalance), inline: true },
      );
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'pet-skin') {
    const id = interaction.options.getInteger('id', true);
    const skinKey = interaction.options.getString('skin');
    const pet = getPet(id);
    if (!pet || pet.user_id !== interaction.user.id) {
      await interaction.reply({ content: `No pet with #${id} in your collection.`, ephemeral: true });
      return;
    }
    if (!skinKey) {
      db.prepare('UPDATE pets SET skin_key = NULL WHERE id = ?').run(id);
      await interaction.reply(`Removed the skin from ${petByKey(pet.pet_key).name} (#${id}).`);
      return;
    }
    if (!ownsSkin(interaction.user.id, skinKey)) {
      await interaction.reply({ content: `You don't own that skin yet — check \`/shop\` under Cosmetics.`, ephemeral: true });
      return;
    }
    db.prepare('UPDATE pets SET skin_key = ? WHERE id = ?').run(skinKey, id);
    const skin = skinByKey(skinKey);
    const catalog = petByKey(pet.pet_key);
    await interaction.reply(`${skin.emoji} Applied **${skin.name}** to ${catalog.emoji} ${catalog.name} (#${id}) — cosmetic only, no stat change.`);
    return;
  }

  if (interaction.commandName === 'milestone') {
    const m = getMilestone('total_jobs');
    const embed = new EmbedBuilder()
      .setTitle('🏆 Server Milestone: Total Job Runs')
      .setColor(m.achieved ? 0xFFD700 : 0x66BB6A)
      .setDescription(`${progressBar(Math.min(m.progress, m.target), m.target, 20)}\n${m.progress} / ${m.target}`)
      .setFooter({ text: m.achieved ? 'Completed! Reward already paid out.' : `Reward on completion: ${m.reward_coin} coin + ${m.reward_candy} candy per contributor` });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'prestige') {
    const user = getUser(interaction.user.id);
    if (user.level < PRESTIGE_LEVEL_CAP) {
      await interaction.reply({ content: `You need level ${PRESTIGE_LEVEL_CAP} to prestige — you're at level ${user.level}.`, ephemeral: true });
      return;
    }
    const newPrestige = user.prestige + 1;
    db.prepare('UPDATE users SET xp = 0, level = 0, prestige = ? WHERE user_id = ?').run(newPrestige, interaction.user.id);
    const embed = new EmbedBuilder()
      .setTitle(`✨ Prestige ${newPrestige}!`)
      .setColor(0xFFD700)
      .setDescription(`Level reset to 0. Permanent buff: +${newPrestige * PRESTIGE_BUFF_PER_LEVEL}% to XP, coin, and gambling winnings — stacks with everything else.`);
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'monthly') {
    const row = getUser(interaction.user.id);
    const now = Date.now();
    const elapsed = now - row.last_monthly;
    if (elapsed < MONTHLY_COOLDOWN_MS) {
      const remaining = MONTHLY_COOLDOWN_MS - elapsed;
      const days = Math.floor(remaining / 86400000);
      const hours = Math.floor((remaining % 86400000) / 3600000);
      await interaction.reply({ content: `Already claimed — try again in ${days}d ${hours}h.`, ephemeral: true });
      return;
    }
    db.prepare('UPDATE users SET last_monthly = ? WHERE user_id = ?').run(now, interaction.user.id);
    const buff = getActiveBuff(interaction.user.id);
    const totalCoinPct = buff.coin + row.perm_daily_bonus;
    const boosted = applyBuff(MONTHLY_AMOUNT, totalCoinPct);
    const newBalance = addBalance(interaction.user.id, boosted);
    const buffNote = totalCoinPct > 0 ? ` (+${totalCoinPct}% from pets/boosts/upgrades)` : '';
    await interaction.reply(`Claimed your monthly ${fmt(boosted)}${buffNote}! New balance: ${fmt(newBalance)}`);
    return;
  }

  if (interaction.commandName === 'yearly') {
    const row = getUser(interaction.user.id);
    const now = Date.now();
    const elapsed = now - row.last_yearly;
    if (elapsed < YEARLY_COOLDOWN_MS) {
      const remaining = YEARLY_COOLDOWN_MS - elapsed;
      const days = Math.floor(remaining / 86400000);
      await interaction.reply({ content: `Already claimed — try again in ${days} day(s).`, ephemeral: true });
      return;
    }
    db.prepare('UPDATE users SET last_yearly = ? WHERE user_id = ?').run(now, interaction.user.id);
    const buff = getActiveBuff(interaction.user.id);
    const totalCoinPct = buff.coin + row.perm_daily_bonus;
    const boosted = applyBuff(YEARLY_AMOUNT, totalCoinPct);
    const newBalance = addBalance(interaction.user.id, boosted);
    const buffNote = totalCoinPct > 0 ? ` (+${totalCoinPct}% from pets/boosts/upgrades)` : '';
    await interaction.reply(`🎉 Claimed your yearly ${fmt(boosted)}${buffNote}! New balance: ${fmt(newBalance)}`);
    return;
  }

  if (interaction.commandName === 'pay') {
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);
    if (target.id === interaction.user.id) { await interaction.reply({ content: "Can't pay yourself.", ephemeral: true }); return; }
    if (target.bot) { await interaction.reply({ content: "Can't pay a bot.", ephemeral: true }); return; }
    const sender = getUser(interaction.user.id);
    if (sender.balance < amount) { await interaction.reply({ content: `You only have ${fmt(sender.balance)}.`, ephemeral: true }); return; }
    addBalance(interaction.user.id, -amount);
    addBalance(target.id, amount);
    await interaction.reply(`${interaction.user.username} sent ${fmt(amount)} to ${target.username}.`);
    return;
  }

  if (interaction.commandName === 'leaderboard') {
    await interaction.deferReply();
    const members = await interaction.guild.members.fetch();
    const rows = db.prepare('SELECT user_id, balance FROM users ORDER BY balance DESC').all();
    const ranked = rows.filter(r => members.has(r.user_id)).slice(0, 10);
    if (!ranked.length) { await interaction.editReply('Nobody has any balance yet — try `/daily`.'); return; }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = ranked.map((r, i) => {
      const u = getUser(r.user_id);
      const prestigeTag = u.prestige > 0 ? `✨${u.prestige} ` : '';
      const namePart = u.active_title ? `${prestigeTag}${u.active_title} ${members.get(r.user_id).displayName}` : `${prestigeTag}${members.get(r.user_id).displayName}`;
      return `${medals[i] || `#${i + 1}`} ${namePart} — ${fmt(r.balance)}`;
    });
    const embed = new EmbedBuilder().setTitle(`${CURRENCY_EMOJI} ${CURRENCY_NAME} Leaderboard`).setDescription(lines.join('\n')).setColor(0xFFD700).setTimestamp(new Date());
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'rank') {
    const target = interaction.options.getUser('user') || interaction.user;
    const row = getUser(target.id);
    const { level, xpIntoLevel, xpForThisLevel } = levelFromTotalXp(row.xp);
    const titlePart = row.prestige > 0 ? `✨${row.prestige} ` : '';
    const embed = new EmbedBuilder()
      .setTitle(`${titlePart}${target.username}'s Rank`).setColor(0x90CAF9)
      .addFields(
        { name: 'Level', value: row.level >= PRESTIGE_LEVEL_CAP ? `${level} (ready to /prestige!)` : String(level), inline: true },
        { name: 'Total XP', value: row.xp.toLocaleString(), inline: true },
        { name: 'Prestige', value: String(row.prestige), inline: true },
        { name: 'Progress', value: `${progressBar(xpIntoLevel, xpForThisLevel)}\n${xpIntoLevel} / ${xpForThisLevel} XP to next level` },
      )
      .setThumbnail(target.displayAvatarURL());
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'xp-leaderboard') {
    await interaction.deferReply();
    const members = await interaction.guild.members.fetch();
    const rows = db.prepare('SELECT user_id, xp, level FROM users ORDER BY xp DESC').all();
    const ranked = rows.filter(r => members.has(r.user_id)).slice(0, 10);
    if (!ranked.length) { await interaction.editReply('Nobody has any XP yet — just chat to start earning it.'); return; }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = ranked.map((r, i) => `${medals[i] || `#${i + 1}`} ${members.get(r.user_id).displayName} — Level ${r.level} (${r.xp.toLocaleString()} XP)`);
    const embed = new EmbedBuilder().setTitle('⭐ XP Leaderboard').setDescription(lines.join('\n')).setColor(0x90CAF9).setTimestamp(new Date());
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'coinflip') {
    const amount = interaction.options.getInteger('amount', true);
    const call = interaction.options.getString('call', true);
    const user = getUser(interaction.user.id);
    if (user.balance < amount) { await interaction.reply({ content: `You only have ${fmt(user.balance)}.`, ephemeral: true }); return; }

    addBalance(interaction.user.id, -amount);
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const won = result === call;
    const buff = getActiveBuff(interaction.user.id);
    const payout = won ? applyBuff(amount * 2, buff.win) : 0;
    if (won) addBalance(interaction.user.id, payout);
    const newBalance = getUser(interaction.user.id).balance;

    const embed = new EmbedBuilder()
      .setTitle('🪙 Coinflip')
      .setDescription(`Landed on **${result}**! You called **${call}**.`)
      .setColor(won ? 0x4CAF50 : 0xE53935)
      .addFields(
        { name: won ? 'You won' : 'You lost', value: won ? `+${fmt(payout - amount)}` : fmt(amount), inline: true },
        { name: 'New balance', value: fmt(newBalance), inline: true },
      );
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'slots') {
    const amount = interaction.options.getInteger('amount', true);
    const user = getUser(interaction.user.id);
    if (user.balance < amount) { await interaction.reply({ content: `You only have ${fmt(user.balance)}.`, ephemeral: true }); return; }

    addBalance(interaction.user.id, -amount);
    const reels = [spinReel(), spinReel(), spinReel()];
    const [a, b, c] = reels;

    const buff = getActiveBuff(interaction.user.id);
    let winnings = 0;
    let outcome = 'lose';
    if (a.emoji === b.emoji && b.emoji === c.emoji) {
      winnings = applyBuff(amount * a.payout, buff.win);
      outcome = 'jackpot';
      trackQuest(interaction.user.id, 'slots_jackpot');
    } else if (a.emoji === b.emoji || b.emoji === c.emoji || a.emoji === c.emoji) {
      winnings = amount; // push — bet returned, buff doesn't apply to a non-win
      outcome = 'push';
    }
    if (winnings > 0) addBalance(interaction.user.id, winnings);
    const newBalance = getUser(interaction.user.id).balance;

    const embed = new EmbedBuilder()
      .setTitle('🎰 Slots')
      .setDescription(`**[ ${a.emoji} | ${b.emoji} | ${c.emoji} ]**`)
      .setColor(outcome === 'jackpot' ? 0xFFD700 : outcome === 'push' ? 0xFFC107 : 0xE53935)
      .addFields(
        { name: outcome === 'jackpot' ? '🎉 Jackpot!' : outcome === 'push' ? '🤝 Push' : '💥 No match', value: outcome === 'lose' ? `Lost ${fmt(amount)}` : outcome === 'push' ? 'Bet returned' : `+${fmt(winnings - amount)}`, inline: true },
        { name: 'New balance', value: fmt(newBalance), inline: true },
      );
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'blackjack') {
    const amount = interaction.options.getInteger('amount', true);
    const user = getUser(interaction.user.id);
    if (user.balance < amount) { await interaction.reply({ content: `You only have ${fmt(user.balance)}.`, ephemeral: true }); return; }
    if (blackjackGames.has(interaction.user.id)) { await interaction.reply({ content: 'You already have a game in progress.', ephemeral: true }); return; }

    addBalance(interaction.user.id, -amount);
    const deck = buildDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];
    const game = { userId: interaction.user.id, deck, playerHand, dealerHand, bet: amount, messageId: null };

    const playerBJ = handValue(playerHand) === 21;
    const dealerBJ = handValue(dealerHand) === 21;

    if (playerBJ || dealerBJ) {
      let result;
      const naturalBuff = getActiveBuff(interaction.user.id);
      if (playerBJ && dealerBJ) { result = 'push'; addBalance(interaction.user.id, amount); }
      else if (playerBJ) {
        result = 'win';
        addBalance(interaction.user.id, applyBuff(Math.floor(amount * 2.5), naturalBuff.win));
        db.prepare('UPDATE users SET blackjack_wins = blackjack_wins + 1 WHERE user_id = ?').run(interaction.user.id);
        trackQuest(interaction.user.id, 'blackjack_win');
        checkAchievements(interaction.user.id);
      }
      else { result = 'lose'; }
      const embed = buildBlackjackEmbed(game, { reveal: true, result });
      await interaction.reply({ embeds: [embed] });
      return;
    }

    blackjackGames.set(interaction.user.id, game); // claim the seat before awaiting Discord
    const embed = buildBlackjackEmbed(game);
    let reply;
    try {
      reply = await interaction.reply({ embeds: [embed], components: [buildBlackjackRow()], fetchReply: true });
    } catch (err) {
      blackjackGames.delete(interaction.user.id);
      addBalance(interaction.user.id, amount); // the table never appeared — give the bet back
      throw err;
    }
    game.messageId = reply.id;
    game.timeout = setTimeout(async () => {
      if (blackjackGames.has(interaction.user.id)) {
        try { await resolveBlackjack(game, { update: async (opts) => reply.edit(opts) }, false); } catch {}
      }
    }, 120000);
    return;
  }

  if (interaction.commandName === 'trivia') {
    const qIndex = Math.floor(Math.random() * TRIVIA_QUESTIONS.length);
    const q = TRIVIA_QUESTIONS[qIndex];
    const embed = new EmbedBuilder()
      .setTitle('🧠 Trivia')
      .setDescription(q.q)
      .setColor(0x90CAF9)
      .setFooter({ text: `1st try: ${TRIVIA_REWARD_FIRST} ${CURRENCY_NAME} · 2nd try: ${TRIVIA_REWARD_SECOND} · after that: nothing` });

    const reply = await interaction.reply({ embeds: [embed], fetchReply: true });
    const row = new ActionRowBuilder().addComponents(
      q.choices.map((c, i) => new ButtonBuilder().setCustomId(`triv_${i}_${reply.id}`).setLabel(c).setStyle(ButtonStyle.Secondary))
    );
    triviaSessions.set(reply.id, { answer: q.answer, qIndex, resolved: false, attempts: new Map() });
    await interaction.editReply({ embeds: [embed], components: [row] });

    setTimeout(() => {
      const session = triviaSessions.get(reply.id);
      if (session && !session.resolved) {
        triviaSessions.delete(reply.id);
        interaction.editReply({ components: [] }).catch(() => {});
      }
    }, 30000);
    return;
  }
  if (interaction.commandName === 'pet-pull') {
    const user = getUser(interaction.user.id);
    if (user.balance < PET_PULL_COST) {
      await interaction.reply({ content: `You need ${fmt(PET_PULL_COST)} to pull — you have ${fmt(user.balance)}.`, ephemeral: true });
      return;
    }
    addBalance(interaction.user.id, -PET_PULL_COST);
    const hadCharm = user.pending_luck_charm === 1;
    if (hadCharm) db.prepare('UPDATE users SET pending_luck_charm = 0 WHERE user_id = ?').run(interaction.user.id);
    const pet = rollPet(false, hadCharm);
    const petId = addPetToUser(interaction.user.id, pet.key);
    checkAchievements(interaction.user.id);
    const newBalance = getUser(interaction.user.id).balance;

    const embed = new EmbedBuilder()
      .setTitle(`${pet.emoji} You got a ${pet.name}!`)
      .setDescription(`Rarity: **${pet.rarity}**\nBuff: ${describeBuff(pet.buff)}${hadCharm ? '\n🍀 Luck Charm was applied to this pull.' : ''}`)
      .setColor(RARITY_COLOR[pet.rarity])
      .addFields(
        { name: 'Pet ID', value: `#${petId}`, inline: true },
        { name: 'Cost', value: fmt(PET_PULL_COST), inline: true },
        { name: 'New balance', value: fmt(newBalance), inline: true },
      )
      .setFooter({ text: `/pet-equip id:${petId} to use its buff · /pet-feed id:${petId} to level it up` });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'pets') {
    const target = interaction.options.getUser('user') || interaction.user;
    const pets = getUserPets(target.id);
    if (!pets.length) {
      await interaction.reply(`${target.id === interaction.user.id ? "You don't" : `${target.username} doesn't`} have any pets yet — try \`/pet-pull\`.`);
      return;
    }
    const enriched = pets.map(p => ({ ...p, catalog: petByKey(p.pet_key) }))
      .sort((a, b) => RARITY_ORDER[a.catalog.rarity] - RARITY_ORDER[b.catalog.rarity]);

    const activeIds = new Set(getActivePets(target.id).map(a => a.pet_id));
    const lines = enriched.map(p => {
      const skinPrefix = p.skin_key ? `${skinByKey(p.skin_key).emoji} ` : '';
      const namePart = `${skinPrefix}${p.evolved ? '⚡ ' : ''}${p.catalog.name}`;
      return `${activeIds.has(p.id) ? '⭐' : '#' + p.id} ${p.catalog.emoji} **${namePart}** (${p.catalog.rarity}) — Lv.${p.level}${activeIds.has(p.id) ? ' *(active)*' : ''}`;
    });
    const chunks = [];
    let cur = [], len = 0;
    for (const line of lines) {
      if (len + line.length + 1 > 950 && cur.length) { chunks.push(cur); cur = []; len = 0; }
      cur.push(line); len += line.length + 1;
    }
    if (cur.length) chunks.push(cur);

    const embed = new EmbedBuilder()
      .setTitle(`${target.username}'s Pets (${pets.length})`)
      .setColor(0xAB47BC);
    chunks.forEach((chunk, i) => {
      embed.addFields({ name: chunks.length > 1 ? `Collection (${i + 1}/${chunks.length})` : 'Collection', value: chunk.join('\n') });
    });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'pet-info') {
    const id = interaction.options.getInteger('id', true);
    const pet = getPet(id);
    if (!pet || pet.user_id !== interaction.user.id) {
      await interaction.reply({ content: `No pet with #${id} in your collection.`, ephemeral: true });
      return;
    }
    const catalog = petByKey(pet.pet_key);
    const xpNeeded = petXpForLevel(pet.level);
    const isActive = getActivePets(interaction.user.id).some(a => a.pet_id === pet.id);
    const mult = pet.evolved ? EVOLVE_MULTIPLIER : 1;
    const totalBuff = {
      xp: Math.round((catalog.buff.xp + (pet.bonus_xp || 0)) * mult),
      coin: Math.round((catalog.buff.coin + (pet.bonus_coin || 0)) * mult),
      win: Math.round((catalog.buff.win + (pet.bonus_win || 0)) * mult),
    };
    const hasBonus = pet.bonus_xp || pet.bonus_coin || pet.bonus_win;
    const skinPrefix = pet.skin_key ? `${skinByKey(pet.skin_key).emoji} ` : '';
    const displayName = `${skinPrefix}${pet.evolved ? evolvedName(catalog) : catalog.name}`;
    const evolveNote = pet.evolved
      ? 'Evolved ⚡'
      : pet.level >= EVOLVE_LEVEL
        ? `Ready to evolve! \`/pet-evolve id:${pet.id}\``
        : `Level ${EVOLVE_LEVEL} needed (currently ${pet.level})`;
    const embed = new EmbedBuilder()
      .setTitle(`${catalog.emoji} ${displayName} — #${pet.id}${isActive ? ' ⭐ (active)' : ''}`)
      .setColor(RARITY_COLOR[catalog.rarity])
      .addFields(
        { name: 'Rarity', value: catalog.rarity, inline: true },
        { name: 'Level', value: String(pet.level), inline: true },
        { name: 'Evolution', value: evolveNote, inline: true },
        { name: 'Skin', value: pet.skin_key ? `${skinByKey(pet.skin_key).emoji} ${skinByKey(pet.skin_key).name}` : 'None', inline: true },
        { name: 'Buff', value: hasBonus ? `${describeBuff(totalBuff)} *(includes booster bonus)*` : describeBuff(totalBuff) },
        { name: 'Booster', value: pet.booster_used ? 'Used ✅' : 'Available', inline: true },
        { name: 'Progress', value: `${progressBar(pet.xp, xpNeeded)}\n${pet.xp} / ${xpNeeded} XP to next level` },
        { name: 'Obtained', value: `<t:${Math.floor(pet.obtained_at / 1000)}:R>` },
      );
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'pet-battle') {
    const target = interaction.options.getUser('user', true);
    const yourPetId = interaction.options.getInteger('your_pet', true);
    const wager = interaction.options.getInteger('wager') || 0;

    if (target.id === interaction.user.id) { await interaction.reply({ content: "Can't battle yourself.", ephemeral: true }); return; }
    if (target.bot) { await interaction.reply({ content: "Can't battle a bot.", ephemeral: true }); return; }

    const yourPet = getPet(yourPetId);
    if (!yourPet || yourPet.user_id !== interaction.user.id) { await interaction.reply({ content: `You don't own pet #${yourPetId}.`, ephemeral: true }); return; }
    if (wager > 0 && getUser(interaction.user.id).balance < wager) { await interaction.reply({ content: `You don't have ${fmt(wager)} to wager.`, ephemeral: true }); return; }

    const targetPets = getUserPets(target.id);
    if (!targetPets.length) { await interaction.reply({ content: `${target.username} doesn't have any pets to battle with.`, ephemeral: true }); return; }

    const yourCatalog = petByKey(yourPet.pet_key);
    const offerId = Math.random().toString(36).slice(2, 10);

    const embed = new EmbedBuilder()
      .setTitle('⚔️ Battle Challenge')
      .setColor(0xEF5350)
      .setDescription(`${interaction.user} challenges ${target} with ${yourCatalog.emoji} **${yourCatalog.name}** (Lv.${yourPet.level})${wager > 0 ? `\nWager: ${fmt(wager)}` : ''}`)
      .setFooter({ text: `Only ${target.username} can accept — expires in 5 min` });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`battle_accept_${offerId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    );
    await interaction.reply({ content: `${target}`, embeds: [embed], components: [row] });

    const offer = { challengerId: interaction.user.id, opponentId: target.id, challengerPetId: yourPetId, wager };
    offer.timeout = setTimeout(() => battleOffers.delete(offerId), 300000);
    battleOffers.set(offerId, offer);
    return;
  }

  if (interaction.commandName === 'trade') {
    const target = interaction.options.getUser('user', true);
    const give = {
      coin: interaction.options.getInteger('your_coin') || 0,
      candy: interaction.options.getInteger('your_candy') || 0,
      petId: interaction.options.getInteger('your_pet') || null,
    };
    const request = {
      coin: interaction.options.getInteger('their_coin') || 0,
      candy: interaction.options.getInteger('their_candy') || 0,
      petId: interaction.options.getInteger('their_pet') || null,
    };

    if (target.id === interaction.user.id) { await interaction.reply({ content: "Can't trade with yourself.", ephemeral: true }); return; }
    if (target.bot) { await interaction.reply({ content: "Can't trade with a bot.", ephemeral: true }); return; }
    if (!give.coin && !give.candy && !give.petId) { await interaction.reply({ content: 'Offer at least something.', ephemeral: true }); return; }
    if (!request.coin && !request.candy && !request.petId) { await interaction.reply({ content: 'Request at least something.', ephemeral: true }); return; }
    if (!canAffordTradeSide(interaction.user.id, give)) { await interaction.reply({ content: "You don't have what you're offering.", ephemeral: true }); return; }
    if (request.petId) {
      const pet = getPet(request.petId);
      if (!pet || pet.user_id !== target.id) { await interaction.reply({ content: `${target.username} doesn't own pet #${request.petId}.`, ephemeral: true }); return; }
    }

    const offerId = Math.random().toString(36).slice(2, 10);
    const embed = new EmbedBuilder()
      .setTitle('🔄 Trade Offer')
      .setColor(0x29B6F6)
      .setDescription(`${interaction.user} offers **${describeTradeSide(give)}** for ${target}'s **${describeTradeSide(request)}**`)
      .setFooter({ text: `Only ${target.username} can respond — expires in 5 min` });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gtrade_accept_${offerId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gtrade_decline_${offerId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );
    const reply = await interaction.reply({ content: `${target}`, embeds: [embed], components: [row], fetchReply: true });

    const offer = { fromUserId: interaction.user.id, toUserId: target.id, give, request };
    offer.timeout = setTimeout(() => {
      if (generalTradeOffers.has(offerId)) {
        generalTradeOffers.delete(offerId);
        reply.edit({ content: 'Trade offer expired.', embeds: [], components: [] }).catch(() => {});
      }
    }, 300000);
    generalTradeOffers.set(offerId, offer);
    return;
  }

  if (interaction.commandName === 'boss') {
    if (!currentBoss) {
      currentBoss = { hp: BOSS_BASE_HP, maxHp: BOSS_BASE_HP, contributions: new Map(), channelId: interaction.channelId };
      const embed = new EmbedBuilder()
        .setTitle('👹 A wild boss appeared!')
        .setDescription(`HP: ${bossHpBar(currentBoss.hp, currentBoss.maxHp)}\n${currentBoss.hp}/${currentBoss.maxHp}`)
        .setColor(0x6D4C41)
        .setFooter({ text: `Reward pool: ${BOSS_REWARD.coin} ${CURRENCY_EMOJI} + ${BOSS_REWARD.candy} ${CANDY_EMOJI} · use /boss-attack` });
      await interaction.reply({ embeds: [embed] });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle('👹 Boss status')
      .setDescription(`HP: ${bossHpBar(currentBoss.hp, currentBoss.maxHp)}\n${currentBoss.hp}/${currentBoss.maxHp}`)
      .setColor(0x6D4C41)
      .setFooter({ text: `${currentBoss.contributions.size} attacker(s) so far · use /boss-attack` });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'boss-attack') {
    if (!currentBoss) {
      await interaction.reply({ content: 'No boss is active right now — use `/boss` to spawn one.', ephemeral: true });
      return;
    }
    const activePets = getActivePets(interaction.user.id);
    if (!activePets.length) {
      await interaction.reply({ content: 'Equip a pet first with `/pet-equip`.', ephemeral: true });
      return;
    }
    const lastAttack = bossAttackCooldowns.get(interaction.user.id) || 0;
    const remaining = BOSS_ATTACK_COOLDOWN_MS - (Date.now() - lastAttack);
    if (remaining > 0) {
      await interaction.reply({ content: `Not yet — ${Math.ceil(remaining / 60000)}m left on your attack cooldown.`, ephemeral: true });
      return;
    }
    bossAttackCooldowns.set(interaction.user.id, Date.now());

    const damage = activePets.reduce((sum, a) => sum + petPower(a.pet), 0);
    currentBoss.hp = Math.max(0, currentBoss.hp - damage);
    currentBoss.contributions.set(interaction.user.id, (currentBoss.contributions.get(interaction.user.id) || 0) + damage);

    if (currentBoss.hp <= 0) {
      const totalDamage = [...currentBoss.contributions.values()].reduce((a, b) => a + b, 0);
      const payoutLines = [];
      for (const [uid, dmg] of currentBoss.contributions) {
        const share = dmg / totalDamage;
        const coinShare = Math.round(BOSS_REWARD.coin * share);
        const candyShare = Math.round(BOSS_REWARD.candy * share);
        addBalance(uid, coinShare);
        addCandy(uid, candyShare);
        const member = await interaction.guild.members.fetch(uid).catch(() => null);
        payoutLines.push(`${member ? member.displayName : uid}: ${fmt(coinShare)} + ${fmtCandy(candyShare)} (${Math.round(share * 100)}% damage)`);
      }
      const embed = new EmbedBuilder()
        .setTitle('💥 Boss defeated!')
        .setDescription(`Final blow by **${interaction.user.username}** for ${damage} damage.\n\n${payoutLines.join('\n')}`)
        .setColor(0x4CAF50);
      currentBoss = null;
      await interaction.reply({ embeds: [embed] });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`⚔️ Hit the boss for ${damage} damage!`)
      .setDescription(`HP: ${bossHpBar(currentBoss.hp, currentBoss.maxHp)}\n${currentBoss.hp}/${currentBoss.maxHp}`)
      .setColor(0x6D4C41);
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'pet-evolve') {
    const id = interaction.options.getInteger('id', true);
    const pet = getPet(id);
    if (!pet || pet.user_id !== interaction.user.id) {
      await interaction.reply({ content: `No pet with #${id} in your collection.`, ephemeral: true });
      return;
    }
    if (pet.evolved) {
      await interaction.reply({ content: 'This pet has already evolved.', ephemeral: true });
      return;
    }
    if (pet.level < EVOLVE_LEVEL) {
      await interaction.reply({ content: `${petByKey(pet.pet_key).name} needs to reach level ${EVOLVE_LEVEL} first (currently level ${pet.level}).`, ephemeral: true });
      return;
    }
    const catalog = petByKey(pet.pet_key);
    const cost = EVOLVE_COST[catalog.rarity];
    const user = getUser(interaction.user.id);
    if (user.balance < cost.coin || user.candy < cost.candy) {
      await interaction.reply({ content: `Evolving needs ${fmt(cost.coin)} + ${fmtCandy(cost.candy)} — you have ${fmt(user.balance)} and ${fmtCandy(user.candy)}.`, ephemeral: true });
      return;
    }
    addBalance(interaction.user.id, -cost.coin);
    addCandy(interaction.user.id, -cost.candy);
    db.prepare('UPDATE pets SET evolved = 1 WHERE id = ?').run(id);

    const embed = new EmbedBuilder()
      .setTitle(`⚡ ${evolvedName(catalog)} (#${id})`)
      .setColor(RARITY_COLOR[catalog.rarity])
      .setDescription(`Evolved! All buffs on this pet are now ${EVOLVE_MULTIPLIER}x stronger while equipped.`)
      .addFields({ name: 'Cost', value: `${fmt(cost.coin)} + ${fmtCandy(cost.candy)}` });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'duel') {
    const target = interaction.options.getUser('user', true);
    const amount = interaction.options.getInteger('amount', true);

    if (target.id === interaction.user.id) { await interaction.reply({ content: "Can't duel yourself.", ephemeral: true }); return; }
    if (target.bot) { await interaction.reply({ content: "Can't duel a bot.", ephemeral: true }); return; }
    if (getUser(interaction.user.id).balance < amount) { await interaction.reply({ content: `You don't have ${fmt(amount)} to ante.`, ephemeral: true }); return; }

    const offerId = Math.random().toString(36).slice(2, 10);
    const embed = new EmbedBuilder()
      .setTitle('🃏 Duel Challenge')
      .setColor(0xEF5350)
      .setDescription(`${interaction.user} challenges ${target} to a high-card duel for ${fmt(amount)} each — winner takes both antes!`)
      .setFooter({ text: `Only ${target.username} can accept — expires in 5 min` });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`duel_accept_${offerId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    );
    await interaction.reply({ content: `${target}`, embeds: [embed], components: [row] });

    const offer = { challengerId: interaction.user.id, opponentId: target.id, amount };
    offer.timeout = setTimeout(() => duelOffers.delete(offerId), 300000);
    duelOffers.set(offerId, offer);
    return;
  }

  if (interaction.commandName === 'achievements') {
    const unlocked = new Set(getUnlockedAchievements(interaction.user.id));
    const user = getUser(interaction.user.id);
    const lines = ACHIEVEMENT_DEFS.map(a => `${unlocked.has(a.key) ? '✅' : '🔒'} ${a.title}${unlocked.has(a.key) ? '' : ` *(locked — ${a.name})*`}`);
    const embed = new EmbedBuilder()
      .setTitle(`🏅 Achievements (${unlocked.size}/${ACHIEVEMENT_DEFS.length})`)
      .setColor(0xFFA726)
      .setDescription(lines.join('\n'))
      .setFooter({ text: user.active_title ? `Current title: ${user.active_title}` : 'No title unlocked yet' });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'pet-trade') {
    const target = interaction.options.getUser('user', true);
    const yourPetId = interaction.options.getInteger('your_pet', true);
    const theirPetId = interaction.options.getInteger('their_pet', true);

    if (target.id === interaction.user.id) { await interaction.reply({ content: "Can't trade with yourself.", ephemeral: true }); return; }
    if (target.bot) { await interaction.reply({ content: "Can't trade with a bot.", ephemeral: true }); return; }

    const yourPet = getPet(yourPetId);
    const theirPet = getPet(theirPetId);
    if (!yourPet || yourPet.user_id !== interaction.user.id) { await interaction.reply({ content: `You don't own pet #${yourPetId}.`, ephemeral: true }); return; }
    if (!theirPet || theirPet.user_id !== target.id) { await interaction.reply({ content: `${target.username} doesn't own pet #${theirPetId}.`, ephemeral: true }); return; }

    const yourCatalog = petByKey(yourPet.pet_key);
    const theirCatalog = petByKey(theirPet.pet_key);
    const offerId = Math.random().toString(36).slice(2, 10);

    const embed = new EmbedBuilder()
      .setTitle('🔄 Trade Offer')
      .setColor(0x29B6F6)
      .setDescription(`${interaction.user} offers ${yourCatalog.emoji} **${yourCatalog.name}** (#${yourPetId}) for ${target}'s ${theirCatalog.emoji} **${theirCatalog.name}** (#${theirPetId})`)
      .setFooter({ text: `Only ${target.username} can respond — expires in 5 min` });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`trade_accept_${offerId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`trade_decline_${offerId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );
    const reply = await interaction.reply({ content: `${target}`, embeds: [embed], components: [row], fetchReply: true });

    const offer = { fromUserId: interaction.user.id, toUserId: target.id, fromPetId: yourPetId, toPetId: theirPetId, messageId: reply.id };
    offer.timeout = setTimeout(() => {
      if (tradeOffers.has(offerId)) {
        tradeOffers.delete(offerId);
        reply.edit({ content: 'Trade offer expired.', embeds: [], components: [] }).catch(() => {});
      }
    }, 300000);
    tradeOffers.set(offerId, offer);
    return;
  }

  if (interaction.commandName === 'quests') {
    const { weekKey, quests } = getCurrentQuests();
    const embed = new EmbedBuilder().setTitle('📜 Weekly Quests').setColor(0x7E57C2).setFooter({ text: `Week ${weekKey}` });
    const row = new ActionRowBuilder();
    for (const q of quests) {
      const p = getQuestProgress(interaction.user.id, weekKey, q.key);
      const done = p.progress >= q.target;
      const status = p.claimed ? '✅ Claimed' : done ? '🎁 Ready to claim!' : `${p.progress}/${q.target}`;
      embed.addFields({ name: q.desc, value: `${progressBar(p.progress, q.target, 10)} ${status}\nReward: ${q.reward.coin} ${CURRENCY_EMOJI} + ${q.reward.candy} ${CANDY_EMOJI}` });
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`quest_claim_${q.key}`)
          .setLabel(q.desc.slice(0, 30))
          .setStyle(ButtonStyle.Success)
          .setDisabled(!done || !!p.claimed)
      );
    }
    await interaction.reply({ embeds: [embed], components: [row] });
    return;
  }

  if (interaction.commandName === 'pet-sell') {
    const id = interaction.options.getInteger('id', true);
    const pet = getPet(id);
    if (!pet || pet.user_id !== interaction.user.id) {
      await interaction.reply({ content: `No pet with #${id} in your collection.`, ephemeral: true });
      return;
    }
    const result = sellPet(interaction.user.id, id);
    await interaction.reply(`Sold ${result.catalog.emoji} **${result.catalog.name}** (#${id}) for ${fmt(result.value.coin)} + ${fmtCandy(result.value.candy)}.`);
    return;
  }

  if (interaction.commandName === 'fish') { await runJob(interaction, 'fish'); return; }
  if (interaction.commandName === 'mine') { await runJob(interaction, 'mine'); return; }
  if (interaction.commandName === 'hunt') { await runJob(interaction, 'hunt'); return; }

  if (interaction.commandName === 'shop') {
    const category = SHOP_CATEGORIES[0];
    const embed = buildShopEmbed(category, interaction.user.id);
    const rows = [buildShopCategoryRow(category), ...buildShopItemButtons(category)];
    await interaction.reply({ embeds: [embed], components: rows });
    return;
  }

  if (interaction.commandName === 'inventory') {
    const user = getUser(interaction.user.id);
    const tools = getOwnedTools(interaction.user.id);
    const boosts = getActiveBoosts(interaction.user.id);
    const activePets = getActivePets(interaction.user.id);

    const toolLines = ['fish', 'mine', 'hunt'].map(job => {
      const tool = getTool(interaction.user.id, job);
      if (!tool) return `${JOB_LABELS[job]}: *none*`;
      return `${JOB_LABELS[job]}: ${TOOL_LABELS[job]} tier ${tool.tier}`;
    });

    const boostLines = boosts.length
      ? boosts.map(b => {
          const mins = Math.max(0, Math.ceil((b.expires_at - Date.now()) / 60000));
          return `+${b.value}% ${b.stat} — ${mins}m left`;
        })
      : ['*none active*'];

    const petLines = activePets.length
      ? activePets.map(a => {
          const c = petByKey(a.pet.pet_key);
          return `Slot ${a.slot_index}: ${c.emoji} ${c.name} (#${a.pet_id})`;
        })
      : ['*none equipped*'];

    const upgradeLines = [];
    if (user.perm_daily_bonus > 0) upgradeLines.push(`Daily Booster: +${user.perm_daily_bonus}%`);
    if (user.perm_xp_cd_reduction > 0) upgradeLines.push(`Faster Grind: -${user.perm_xp_cd_reduction / 1000}s XP cooldown`);
    if (user.pending_luck_charm) upgradeLines.push(`🍀 Luck Charm ready — applies to your next chest`);
    if (!upgradeLines.length) upgradeLines.push('*none*');

    const embed = new EmbedBuilder()
      .setTitle('🎒 Inventory')
      .setColor(0x8D6E63)
      .addFields(
        { name: 'Tools', value: toolLines.join('\n') },
        { name: 'Active Boosts', value: boostLines.join('\n') },
        { name: `Pet Slots (${activePets.length}/${user.pet_slots})`, value: petLines.join('\n') },
        { name: 'Upgrades & Charms', value: upgradeLines.join('\n') },
        { name: 'Balance', value: `${fmt(user.balance)}\n${fmtCandy(user.candy)}` },
      )
      .setFooter({ text: '/shop to buy · /pet-equip to change active pets' });
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'pet-equip') {
    const id = interaction.options.getInteger('id', true);
    const slot = interaction.options.getInteger('slot') || 1;
    const pet = getPet(id);
    if (!pet || pet.user_id !== interaction.user.id) {
      await interaction.reply({ content: `No pet with #${id} in your collection.`, ephemeral: true });
      return;
    }
    const user = getUser(interaction.user.id);
    if (slot > user.pet_slots) {
      await interaction.reply({ content: `You only have ${user.pet_slots} pet slot${user.pet_slots > 1 ? 's' : ''} — buy more pet slots from \`/shop\` (Upgrades) to use slot ${slot}.`, ephemeral: true });
      return;
    }
    setActivePet(interaction.user.id, id, slot);
    const catalog = petByKey(pet.pet_key);
    const embed = new EmbedBuilder()
      .setTitle(`${catalog.emoji} ${catalog.name} is now active (slot ${slot})`)
      .setColor(RARITY_COLOR[catalog.rarity])
      .setDescription(`Buff: ${describeBuff(catalog.buff)}`);
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'pet-feed') {
    const id = interaction.options.getInteger('id', true);
    const candyAmount = interaction.options.getInteger('amount', true);
    const pet = getPet(id);
    if (!pet || pet.user_id !== interaction.user.id) {
      await interaction.reply({ content: `No pet with #${id} in your collection.`, ephemeral: true });
      return;
    }
    const user = getUser(interaction.user.id);
    if (user.candy < candyAmount) {
      await interaction.reply({ content: `You only have ${fmtCandy(user.candy)} — go fish/mine/hunt for more.`, ephemeral: true });
      return;
    }
    addCandy(interaction.user.id, -candyAmount);
    const xpGained = candyAmount * CANDY_TO_PET_XP;
    const updated = feedPet(id, xpGained);
    trackQuest(interaction.user.id, 'pet_feed');
    const catalog = petByKey(updated.pet_key);
    const xpNeeded = petXpForLevel(updated.level);

    const embed = new EmbedBuilder()
      .setTitle(`${catalog.emoji} Fed ${catalog.name}`)
      .setColor(RARITY_COLOR[catalog.rarity])
      .setDescription(updated.leveledUp ? `🎉 Leveled up to **Level ${updated.level}**!` : `Fed ${fmtCandy(candyAmount)} (+${xpGained} pet XP).`)
      .addFields({ name: 'Progress', value: `${progressBar(updated.xp, xpNeeded)}\n${updated.xp} / ${xpNeeded} XP to next level` });
    await interaction.reply({ embeds: [embed] });
    return;
  }

});

const DOUBLE_LOOT_CHANNEL_ID = process.env.DOUBLE_LOOT_CHANNEL_ID || process.env.GUILD_ID_1_GENERAL || '1413262822082744322';
const DOUBLE_LOOT_CHECK_MS = 30 * 60 * 1000;
const DOUBLE_LOOT_CHANCE = 0.05;
const DOUBLE_LOOT_DURATION_MS = 15 * 60 * 1000;

async function checkDoubleLootTrigger() {
  if (Date.now() < doubleLootUntil) return; // one at a time
  if (Math.random() >= DOUBLE_LOOT_CHANCE) return;
  doubleLootUntil = Date.now() + DOUBLE_LOOT_DURATION_MS;
  if (!DOUBLE_LOOT_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(DOUBLE_LOOT_CHANNEL_ID);
    await channel.send('🎉 **DOUBLE LOOT** is active for the next 15 minutes on `/fish`, `/mine`, and `/hunt`!');
  } catch (e) {
    console.error('double loot announce failed:', e.message);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Command registration failed:', e.message);
  }
  setInterval(checkDoubleLootTrigger, DOUBLE_LOOT_CHECK_MS);
});

// client.login(process.env.DISCORD_TOKEN); // DISABLED — this is a test harness, never connects to Discord



module.exports = {
  battleProblem, resolveBattle,
  db, getUser, addBalance, addCandy, fmt, fmtCandy,
  xpForNextLevel, levelFromTotalXp, progressBar, awardXp,
  buildDeck, cardValue, handValue, renderCard,
  SLOT_SYMBOLS, spinReel,
  TRIVIA_QUESTIONS,
  PET_CATALOG, RARITY_COLOR, RARITY_ORDER, petTotalWeight, petByKey, petXpForLevel,
  addPetToUser, getUserPets, getPet, feedPet,
  getActivePets, setActivePet, getActiveBoosts, getActiveBuff, applyBuff, describeBuff,
  JOB_LABELS, TOOL_LABELS, JOB_COOLDOWNS, SHOP_CATEGORIES, SHOP_ITEMS, findShopItem,
  PREMIUM_MULTIPLIER, CHARM_MULTIPLIER, rollPet,
  getOwnedTools, getToolTier, getTool, setToolTier,
  SELL_VALUE, sellPet,
  QUEST_TEMPLATES, isoWeekKey, getCurrentQuests, getQuestProgress, trackQuest,
  ACHIEVEMENT_DEFS, getUnlockedAchievements, unlockAchievement, checkAchievements,
  JOB_LOOT, JOB_VERBS, rollJobLoot, getJobCooldownRemaining, setJobCooldown,
  tradeOffers, executeTrade,
  battleOffers, petPower, resolveBattle,
  EVOLVE_LEVEL, EVOLVE_COST, EVOLVE_MULTIPLIER, evolvedName,
  BOSS_BASE_HP, BOSS_REWARD, bossHpBar,
  generalTradeOffers, describeTradeSide, canAffordTradeSide, executeGeneralTrade,
  CANDY_TO_PET_XP, PET_PULL_COST, DAILY_AMOUNT,
  MONTHLY_AMOUNT, YEARLY_AMOUNT, PRESTIGE_LEVEL_CAP, PRESTIGE_BUFF_PER_LEVEL,
  spinRoulette, rouletteColor, ROULETTE_RED, validateRouletteBet, evaluateRouletteBet,
  highCardRank, CARD_RANK_ORDER, resolveDuel,
  SKIN_CATALOG, skinByKey, ownsSkin,
  seedMilestone, getMilestone, incrementMilestone,
};
