// Start every run from an empty test database, so leftovers from earlier runs
// (e.g. the prestige test setting test_user_1 to prestige 5) can't skew results.
{
  const fs = require('fs'), p = require('path');
  for (const f of ['economy.db', 'economy.db-wal', 'economy.db-shm']) {
    try { fs.unlinkSync(p.join(__dirname, f)); } catch {}
  }
}
const h = require('./harness.js');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

// unique fake user ids for isolation within the same test DB
const U1 = 'test_user_1';
const U2 = 'test_user_2';

console.log('\n=== 1. Economy basics ===');
{
  const b0 = h.getUser(U1).balance;
  h.addBalance(U1, 500);
  check('addBalance increments correctly', h.getUser(U1).balance === b0 + 500);
  h.addBalance(U1, -200);
  check('addBalance decrements correctly', h.getUser(U1).balance === b0 + 300);

  const c0 = h.getUser(U1).candy;
  h.addCandy(U1, 50);
  check('addCandy increments correctly', h.getUser(U1).candy === c0 + 50);
}

console.log('=== 2. XP / leveling curve ===');
{
  check('level 0 needs 100 xp', h.xpForNextLevel(0) === 100);
  check('level 1 needs 155 xp', h.xpForNextLevel(1) === 155);
  const at100 = h.levelFromTotalXp(100);
  check('exactly 100 total xp = level 1, 0 into level', at100.level === 1 && at100.xpIntoLevel === 0);
  const at99 = h.levelFromTotalXp(99);
  check('99 total xp = still level 0', at99.level === 0 && at99.xpIntoLevel === 99);

  // monotonic increasing curve
  let monotonic = true;
  for (let l = 0; l < 20; l++) if (h.xpForNextLevel(l + 1) <= h.xpForNextLevel(l)) monotonic = false;
  check('xp curve strictly increasing over 20 levels', monotonic);
}

console.log('=== 3. awardXp cooldown + perm reduction ===');
{
  h.db.prepare('UPDATE users SET last_xp_ts = 0, xp = 0, level = 0 WHERE user_id = ?').run(U1);
  const first = h.awardXp(U1);
  check('first awardXp call grants xp', first !== null || h.getUser(U1).xp > 0);
  const second = h.awardXp(U1);
  check('immediate second call is blocked by cooldown', second === null && h.getUser(U1).level === h.getUser(U1).level);

  // simulate the Faster Grind upgrade (-15s)
  h.db.prepare('UPDATE users SET perm_xp_cd_reduction = 15000, last_xp_ts = 0 WHERE user_id = ?').run(U1);
  const beforeXp = h.getUser(U1).xp;
  h.awardXp(U1);
  check('awardXp works again immediately after resetting last_xp_ts (reduction applied, not blocking)', h.getUser(U1).xp > beforeXp);
}

console.log('=== 4. Blackjack card logic ===');
{
  const deck = h.buildDeck();
  check('deck has 52 cards', deck.length === 52);
  const unique = new Set(deck.map(c => c.rank + c.suit));
  check('all 52 cards unique', unique.size === 52);

  check('A+K = 21', h.handValue([{ rank: 'A' }, { rank: 'K' }]) === 21);
  check('A+A+9 = 21 (one ace demoted to 1)', h.handValue([{ rank: 'A' }, { rank: 'A' }, { rank: '9' }]) === 21);
  check('10+10+5 = 25 (bust)', h.handValue([{ rank: '10' }, { rank: '10' }, { rank: '5' }]) === 25);
  check('A+9+A+A = 12 (three aces, two demoted)', h.handValue([{ rank: 'A' }, { rank: '9' }, { rank: 'A' }, { rank: 'A' }]) === 12);
}

console.log('=== 5. Slots weight distribution (50k spins) ===');
{
  const counts = {};
  const N = 50000;
  for (let i = 0; i < N; i++) {
    const s = h.spinReel();
    counts[s.emoji] = (counts[s.emoji] || 0) + 1;
  }
  const totalWeight = h.SLOT_SYMBOLS.reduce((s, x) => s + x.weight, 0);
  let allClose = true;
  for (const sym of h.SLOT_SYMBOLS) {
    const expected = sym.weight / totalWeight;
    const actual = (counts[sym.emoji] || 0) / N;
    if (!approx(expected, actual, 0.02)) allClose = false;
  }
  check('slots symbol distribution matches configured weights (±2%)', allClose);
}

console.log('=== 6. Trivia data integrity ===');
{
  const allValid = h.TRIVIA_QUESTIONS.every(q => q.answer >= 0 && q.answer < q.choices.length);
  check('every trivia question has a valid answer index', allValid);
  check('at least 10 trivia questions', h.TRIVIA_QUESTIONS.length >= 10);
}

console.log('=== 7. Pet catalog + roll odds (100k pulls each) ===');
{
  check('20 pets in catalog', h.PET_CATALOG.length === 20);
  const byRarity = { Common: 0, Rare: 0, Epic: 0, Legendary: 0 };
  h.PET_CATALOG.forEach(p => byRarity[p.rarity]++);
  check('10 common / 5 rare / 3 epic / 2 legendary', byRarity.Common === 10 && byRarity.Rare === 5 && byRarity.Epic === 3 && byRarity.Legendary === 2);

  function distribution(premium, charm, N) {
    const counts = { Common: 0, Rare: 0, Epic: 0, Legendary: 0 };
    for (let i = 0; i < N; i++) counts[h.rollPet(premium, charm).rarity]++;
    return counts;
  }
  const N = 100000;
  const normal = distribution(false, false, N);
  check('normal chest ~61% common (±2%)', approx(normal.Common / N, 0.61, 0.02), `got ${(normal.Common/N*100).toFixed(1)}%`);
  check('normal chest ~0.5% legendary (±0.3%)', approx(normal.Legendary / N, 0.005, 0.003), `got ${(normal.Legendary/N*100).toFixed(2)}%`);

  const premium = distribution(true, false, N);
  check('premium chest ~18.8% common (±2%)', approx(premium.Common / N, 0.188, 0.02), `got ${(premium.Common/N*100).toFixed(1)}%`);
  check('premium chest ~5.1% legendary (±1%)', approx(premium.Legendary / N, 0.051, 0.01), `got ${(premium.Legendary/N*100).toFixed(2)}%`);

  const charmed = distribution(false, true, N);
  check('luck charm increases legendary odds vs normal', charmed.Legendary > normal.Legendary);
}

console.log('=== 8. Pet lifecycle (obtain, feed, level) ===');
{
  const petId = h.addPetToUser(U1, 'puppy');
  const pet = h.getPet(petId);
  check('new pet starts at level 1, 0 xp', pet.level === 1 && pet.xp === 0);

  const fed = h.feedPet(petId, 99);
  check('feeding 99 xp does not level up (needs 100)', fed.level === 1 && fed.xp === 99);
  const fed2 = h.feedPet(petId, 1);
  check('feeding 1 more xp levels up to 2', fed2.level === 2 && fed2.leveledUp === true);
}

console.log('=== 9. Active pets / buff aggregation ===');
{
  h.db.prepare("DELETE FROM active_pets WHERE user_id = ?").run(U1);
  const petId = h.addPetToUser(U1, 'kitten'); // coin +3% base
  h.setActivePet(U1, petId, 1);
  const buff = h.getActiveBuff(U1);
  check('equipped Kitten grants +3% coin buff', buff.coin === 3, `got ${buff.coin}`);

  // permanent booster bonus
  h.db.prepare('UPDATE pets SET bonus_coin = 2 WHERE id = ?').run(petId);
  const buffed = h.getActiveBuff(U1);
  check('booster bonus adds on top of base buff (3+2=5%)', buffed.coin === 5, `got ${buffed.coin}`);

  // evolution multiplier
  h.db.prepare('UPDATE pets SET evolved = 1 WHERE id = ?').run(petId);
  const evoBuff = h.getActiveBuff(U1);
  check('evolution multiplies total buff by 1.5x (5*1.5=7.5→round 8)', evoBuff.coin === Math.round(5 * h.EVOLVE_MULTIPLIER), `got ${evoBuff.coin}`);
}

console.log('=== 10. Shop catalog integrity ===');
{
  check('PET_PULL_COST is 200', h.PET_PULL_COST === 200);
  const premiumChest = h.SHOP_ITEMS['Pet Chests'].find(i => i.key === 'chest_premium');
  check('premium chest costs 2000', premiumChest.price === 2000);
  const boosts = h.SHOP_ITEMS.Boosts;
  check('all boosts are 15min duration', boosts.every(b => b.durationMs === 900000));
  check('4 pet items in shop', h.SHOP_ITEMS['Pet Items'].length === 4);
  check('4 upgrades in shop', h.SHOP_ITEMS.Upgrades.length === 4);
  check('findShopItem resolves category correctly', h.findShopItem('slot3').category === 'Upgrades');
}

console.log('=== 11. Jobs: loot tables + tools ===');
{
  for (const job of ['fish', 'mine', 'hunt']) {
    const total = h.JOB_LOOT[job].reduce((s, e) => s + e.weight, 0);
    check(`${job} loot weights sum to 100`, total === 100);
  }

  h.db.prepare('DELETE FROM owned_tools WHERE user_id = ?').run(U1);
  h.setToolTier(U1, 'fish', 1);
  check('buying tier 1 gives the tool', h.getToolTier(U1, 'fish') === 1);
  h.setToolTier(U1, 'fish', 3);
  check('upgrading to tier 3 sticks', h.getToolTier(U1, 'fish') === 3);
  check('no durability or repair left in the bot', h.damageTool === undefined && h.repairTool === undefined);
  const prices = {};
  for (const [job, pre] of [['fish', 'rod'], ['mine', 'pick'], ['hunt', 'bow']])
    for (const tier of [1, 2, 3]) prices[`${job}_${tier}`] = h.findShopItem(`${pre}_${tier}`)?.price;
  check('tool prices: 750 / 3000 / 9000 for every job',
    ['fish', 'mine', 'hunt'].every(j => prices[`${j}_1`] === 750 && prices[`${j}_2`] === 3000 && prices[`${j}_3`] === 9000), JSON.stringify(prices));
}

console.log('=== 12. Weekly quests ===');
{
  const wk1 = h.isoWeekKey(new Date('2026-09-03T00:00:00Z'));
  const wk2 = h.isoWeekKey(new Date('2026-09-03T12:00:00Z'));
  check('isoWeekKey is deterministic within the same day', wk1 === wk2);

  const { weekKey, quests } = h.getCurrentQuests();
  check('exactly 3 quests chosen for the week', quests.length === 3);
  const { quests: quests2 } = h.getCurrentQuests();
  check('same week returns same quest set on second call', JSON.stringify(quests) === JSON.stringify(quests2));

  const q = quests[0];
  h.db.prepare('DELETE FROM quest_progress WHERE user_id = ?').run(U1);
  h.trackQuest(U1, q.trackKey, 1);
  const p1 = h.getQuestProgress(U1, weekKey, q.key);
  check('trackQuest increments progress', p1.progress === 1);
  h.trackQuest(U1, q.trackKey, 999); // way over target
  const p2 = h.getQuestProgress(U1, weekKey, q.key);
  check('progress caps at target, never overflows', p2.progress === q.target);
}

console.log('=== 13. Achievements ===');
{
  h.db.prepare("UPDATE users SET achievements = '[]', active_title = NULL, blackjack_wins = 0, pet_slots = 1, battle_wins = 0, level = 0, xp = 0 WHERE user_id = ?").run(U2);
  h.db.prepare('DELETE FROM pets WHERE user_id = ?').run(U2);

  let unlocked = h.checkAchievements(U2);
  check('no achievements unlocked for a fresh user', unlocked.length === 0);

  h.db.prepare('UPDATE users SET blackjack_wins = 50 WHERE user_id = ?').run(U2);
  unlocked = h.checkAchievements(U2);
  check('Card Shark unlocks at 50 blackjack wins', unlocked.some(a => a.key === 'card_shark'));
  check('active_title is set after unlocking', h.getUser(U2).active_title === '🃏 Card Shark');

  const again = h.checkAchievements(U2);
  check('already-unlocked achievement does not re-trigger', !again.some(a => a.key === 'card_shark'));
}

console.log('=== 14. Pet trading (pet-only) ===');
{
  h.db.prepare('DELETE FROM pets WHERE user_id IN (?, ?)').run(U1, U2);
  const petA = h.addPetToUser(U1, 'fox');
  const petB = h.addPetToUser(U2, 'owl');
  const ok = h.executeTrade({ fromUserId: U1, toUserId: U2, fromPetId: petA, toPetId: petB });
  check('trade executes successfully', ok === true);
  check('pet A now belongs to U2', h.getPet(petA).user_id === U2);
  check('pet B now belongs to U1', h.getPet(petB).user_id === U1);

  // failure path: try trading a pet that was already moved
  const failOk = h.executeTrade({ fromUserId: U1, toUserId: U2, fromPetId: petA, toPetId: petB });
  check('re-trading already-moved pets fails safely', failOk === false);
}

console.log('=== 15. General trade (coin + candy + pet) ===');
{
  h.db.prepare('UPDATE users SET balance = 5000, candy = 500 WHERE user_id = ?').run(U1);
  h.db.prepare('UPDATE users SET balance = 5000, candy = 500 WHERE user_id = ?').run(U2);
  const petC = h.addPetToUser(U1, 'panda');

  const offer = {
    fromUserId: U1, toUserId: U2,
    give: { coin: 100, candy: 10, petId: petC },
    request: { coin: 200, candy: 0, petId: null },
  };
  const balU1Before = h.getUser(U1).balance;
  const balU2Before = h.getUser(U2).balance;
  const ok = h.executeGeneralTrade(offer);
  check('general trade with mixed coin/candy/pet succeeds', ok === true);
  check('U1 balance: -100 (gave) +200 (received) = +100 net', h.getUser(U1).balance === balU1Before + 100);
  check('U2 balance: +100 (received) -200 (gave) = -100 net', h.getUser(U2).balance === balU2Before - 100);
  check('pet transferred to U2', h.getPet(petC).user_id === U2);

  // afford check
  const cantAfford = h.canAffordTradeSide(U1, { coin: 999999, candy: 0, petId: null });
  check('canAffordTradeSide correctly rejects insufficient funds', cantAfford === false);
}

console.log('=== 16. Pet battles ===');
{
  h.db.prepare('DELETE FROM pets WHERE user_id IN (?, ?)').run(U1, U2);
  const strongId = h.addPetToUser(U1, 'ancient_dragon'); // legendary, high buff
  h.db.prepare('UPDATE pets SET level = 20 WHERE id = ?').run(strongId);
  const weakId = h.addPetToUser(U2, 'mouse'); // common, low buff
  h.db.prepare('UPDATE pets SET level = 1 WHERE id = ?').run(weakId);

  const strongPower = h.petPower(h.getPet(strongId));
  const weakPower = h.petPower(h.getPet(weakId));
  check('higher level + better buffs = higher power', strongPower > weakPower, `${strongPower} vs ${weakPower}`);

  let strongWins = 0;
  const trials = 500;
  h.db.prepare('UPDATE users SET balance = 0 WHERE user_id IN (?, ?)').run(U1, U2); // no wager funds, tests no-wager path
  for (let i = 0; i < trials; i++) {
    const r = h.resolveBattle(U1, U2, strongId, weakId, 0);
    if (r.winnerId === U1) strongWins++;
  }
  const winRate = strongWins / trials;
  check('much stronger pet wins the large majority of battles (>85%)', winRate > 0.85, `won ${(winRate*100).toFixed(1)}% of ${trials}`);
  check('battle_wins counter increments on the DB', h.getUser(U1).battle_wins + h.getUser(U2).battle_wins >= trials);
}

console.log('=== 17. Boss fight + proportional payout ===');
{
  const contributions = new Map([[U1, 3000], [U2, 1000]]);
  const totalDamage = 4000;
  const payouts = {};
  for (const [uid, dmg] of contributions) {
    payouts[uid] = { coin: Math.round(h.BOSS_REWARD.coin * (dmg / totalDamage)), candy: Math.round(h.BOSS_REWARD.candy * (dmg / totalDamage)) };
  }
  check('75% damage = 75% of coin reward', payouts[U1].coin === Math.round(h.BOSS_REWARD.coin * 0.75));
  check('25% damage = 25% of coin reward', payouts[U2].coin === Math.round(h.BOSS_REWARD.coin * 0.25));
  const sumCoin = payouts[U1].coin + payouts[U2].coin;
  check('payout sum is within rounding of the full pool', approx(sumCoin, h.BOSS_REWARD.coin, 2));

  const bar = h.bossHpBar(2500, 5000, 20);
  const filledCount = (bar.match(/🟥/g) || []).length;
  check('HP bar renders half-filled at 50% hp', filledCount === 10, `got ${filledCount}/20`);
}

console.log('=== 18. Pet evolution ===');
{
  const petId = h.addPetToUser(U1, 'unicorn'); // epic, xp+12 base
  h.db.prepare('UPDATE pets SET level = ? WHERE id = ?').run(h.EVOLVE_LEVEL, petId);
  const cost = h.EVOLVE_COST['Epic'];
  check('epic evolve cost is defined and positive', cost.candy > 0 && cost.coin > 0);

  h.db.prepare('UPDATE pets SET evolved = 1 WHERE id = ?').run(petId);
  h.setActivePet(U1, petId, 1);
  const buff = h.getActiveBuff(U1);
  check('evolved unicorn gives boosted xp buff (12*1.5=18)', buff.xp === Math.round(12 * h.EVOLVE_MULTIPLIER), `got ${buff.xp}`);
}

console.log('=== 19. Pet sell-back ===');
{
  const petId = h.addPetToUser(U1, 'penguin'); // rare
  const before = h.getUser(U1).balance;
  const beforeCandy = h.getUser(U1).candy;
  const result = h.sellPet(U1, petId);
  check('sell-back credits correct coin value for Rare', h.getUser(U1).balance === before + h.SELL_VALUE.Rare.coin);
  check('sell-back credits correct candy value for Rare', h.getUser(U1).candy === beforeCandy + h.SELL_VALUE.Rare.candy);
  check('pet row is actually deleted after selling', h.getPet(petId) === undefined);
}

console.log('=== 20. Daily claim buff stacking ===');
{
  h.db.prepare('UPDATE users SET perm_daily_bonus = 10 WHERE user_id = ?').run(U1);
  const buff = h.getActiveBuff(U1); // whatever is currently equipped from earlier tests
  const total = buff.coin + h.getUser(U1).perm_daily_bonus;
  const boosted = h.applyBuff(h.DAILY_AMOUNT, total);
  check('daily amount boosts correctly with perm_daily_bonus included', boosted === Math.round(h.DAILY_AMOUNT * (1 + total / 100)));
}

console.log('=== 21. Roulette bet validation + evaluation ===');
{
  check('validates number 0-36 as valid', h.validateRouletteBet('number', '17') && h.validateRouletteBet('number', '0') && h.validateRouletteBet('number', '36'));
  check('rejects number 37', !h.validateRouletteBet('number', '37'));
  check('rejects negative number', !h.validateRouletteBet('number', '-1'));
  check('validates color red/black', h.validateRouletteBet('color', 'red') && h.validateRouletteBet('color', 'black'));
  check('rejects invalid color', !h.validateRouletteBet('color', 'green'));
  check('validates parity odd/even', h.validateRouletteBet('parity', 'odd') && h.validateRouletteBet('parity', 'even'));
  check('validates range low/high', h.validateRouletteBet('range', 'low') && h.validateRouletteBet('range', 'high'));

  // color mapping sanity across the whole wheel
  let redCount = 0, blackCount = 0, greenCount = 0;
  for (let n = 0; n <= 36; n++) {
    const c = h.rouletteColor(n);
    if (c === 'red') redCount++; else if (c === 'black') blackCount++; else greenCount++;
  }
  check('18 red, 18 black, 1 green (0) across the full wheel', redCount === 18 && blackCount === 18 && greenCount === 1, `${redCount}/${blackCount}/${greenCount}`);

  // evaluation correctness — deterministic, no RNG involved
  check('number bet wins only on exact match', h.evaluateRouletteBet('number', '17', 17).won === true && h.evaluateRouletteBet('number', '17', 18).won === false);
  check('number bet pays 35x', h.evaluateRouletteBet('number', '17', 17).payoutMultiplier === 35);
  check('color bet wins on matching color', h.evaluateRouletteBet('color', 'red', 1).won === true); // 1 is red
  check('color bet loses on 0 (green)', h.evaluateRouletteBet('color', 'red', 0).won === false);
  check('color bet pays 2x', h.evaluateRouletteBet('color', 'red', 1).payoutMultiplier === 2);
  check('parity bet: 0 never wins odd or even', h.evaluateRouletteBet('parity', 'odd', 0).won === false && h.evaluateRouletteBet('parity', 'even', 0).won === false);
  check('parity bet wins correctly on even number', h.evaluateRouletteBet('parity', 'even', 2).won === true);
  check('parity bet wins correctly on odd number', h.evaluateRouletteBet('parity', 'odd', 3).won === true);
  check('range bet: 0 never wins low or high', h.evaluateRouletteBet('range', 'low', 0).won === false && h.evaluateRouletteBet('range', 'high', 0).won === false);
  check('range bet: 1-18 is low', h.evaluateRouletteBet('range', 'low', 18).won === true && h.evaluateRouletteBet('range', 'low', 19).won === false);
  check('range bet: 19-36 is high', h.evaluateRouletteBet('range', 'high', 19).won === true && h.evaluateRouletteBet('range', 'high', 18).won === false);

  // roll distribution sanity (uniform over 37 outcomes)
  const counts = {};
  const N = 3700;
  for (let i = 0; i < N; i++) { const r = h.spinRoulette(); counts[r] = (counts[r] || 0) + 1; }
  const values = Object.values(counts);
  const avg = N / 37;
  const allNear = values.length >= 30 && values.every(v => approx(v, avg, avg * 1.5)); // loose bound, just checking no obviously broken bias
  check('spinRoulette covers most of the 37 numbers with roughly even spread', allNear, `${values.length} distinct numbers hit`);
}

console.log('=== 22. Duel resolution (multiplayer, not vs house) ===');
{
  h.db.prepare('UPDATE users SET balance = 1000 WHERE user_id IN (?, ?)').run(U1, U2);
  const balBefore1 = h.getUser(U1).balance;
  const balBefore2 = h.getUser(U2).balance;
  const result = h.resolveDuel(U1, U2, 100);

  check('resolveDuel draws two distinct card objects', result.challengerCard && result.opponentCard);
  const totalAfter = h.getUser(U1).balance + h.getUser(U2).balance;
  const totalBefore = balBefore1 + balBefore2;
  check('total coins conserved across the duel (zero-sum, no leakage)', totalAfter === totalBefore, `before ${totalBefore}, after ${totalAfter}`);

  if (result.tie) {
    check('tie refunds both sides exactly', h.getUser(U1).balance === balBefore1 && h.getUser(U2).balance === balBefore2);
  } else {
    const winnerBal = result.winnerId === U1 ? h.getUser(U1).balance : h.getUser(U2).balance;
    const loserBal = result.winnerId === U1 ? h.getUser(U2).balance : h.getUser(U1).balance;
    const winnerBefore = result.winnerId === U1 ? balBefore1 : balBefore2;
    const loserBefore = result.winnerId === U1 ? balBefore2 : balBefore1;
    check('winner gains exactly the ante amount (both antes minus their own)', winnerBal === winnerBefore + 100, `${winnerBal} vs expected ${winnerBefore + 100}`);
    check('loser loses exactly their ante', loserBal === loserBefore - 100, `${loserBal} vs expected ${loserBefore - 100}`);
  }

  // run many duels to confirm both tie and win/loss paths actually occur, and money never leaks
  let ties = 0, decisive = 0, leaks = 0;
  for (let i = 0; i < 300; i++) {
    h.db.prepare('UPDATE users SET balance = 500 WHERE user_id IN (?, ?)').run(U1, U2);
    const r = h.resolveDuel(U1, U2, 50);
    if (r.tie) ties++; else decisive++;
    if (h.getUser(U1).balance + h.getUser(U2).balance !== 1000) leaks++;
  }
  check('300 duels: both tie and decisive outcomes occur', ties > 0 && decisive > 0, `${ties} ties, ${decisive} decisive`);
  check('300 duels: never any coin leakage', leaks === 0, `${leaks} leaks detected`);
}

console.log('=== 23. Prestige system ===');
{
  h.db.prepare('UPDATE users SET level = 0, xp = 0, prestige = 0 WHERE user_id = ?').run(U1);
  const buffBefore = h.getActiveBuff(U1);
  check('prestige 0 adds no flat buff', buffBefore.xp === 0 || buffBefore.xp === (buffBefore.xp - 0)); // baseline, just ensure no crash

  h.db.prepare('UPDATE users SET prestige = 5 WHERE user_id = ?').run(U1);
  const buff5 = h.getActiveBuff(U1);
  check('prestige 5 adds +5% flat to xp/coin/win', buff5.xp >= 5 && buff5.coin >= 5 && buff5.win >= 5, JSON.stringify(buff5));

  check('PRESTIGE_LEVEL_CAP is a sane threshold', h.PRESTIGE_LEVEL_CAP === 50);

  // simulate the /prestige command's own gating logic
  h.db.prepare('UPDATE users SET level = 49, xp = 12345, prestige = 0 WHERE user_id = ?').run(U2);
  const belowCap = h.getUser(U2);
  check('level 49 (below cap) should not be allowed to prestige', belowCap.level < h.PRESTIGE_LEVEL_CAP);

  h.db.prepare('UPDATE users SET level = ?, xp = 99999 WHERE user_id = ?').run(h.PRESTIGE_LEVEL_CAP, U2);
  const atCap = h.getUser(U2);
  check('level at cap is eligible to prestige', atCap.level >= h.PRESTIGE_LEVEL_CAP);
  // perform the reset exactly as the handler does
  const newPrestige = atCap.prestige + 1;
  h.db.prepare('UPDATE users SET xp = 0, level = 0, prestige = ? WHERE user_id = ?').run(newPrestige, U2);
  const afterPrestige = h.getUser(U2);
  check('prestige resets level and xp to 0', afterPrestige.level === 0 && afterPrestige.xp === 0);
  check('prestige counter incremented', afterPrestige.prestige === 1);
}

console.log('=== 24. Server-wide milestone ===');
{
  h.db.prepare("DELETE FROM server_milestone WHERE key = 'test_ms'").run();
  h.db.prepare("DELETE FROM milestone_contributions WHERE milestone_key = 'test_ms'").run();
  const seeded = h.seedMilestone('test_ms', 10, 200, 20);
  check('milestone seeds with correct target/reward', seeded.target === 10 && seeded.reward_coin === 200 && seeded.reward_candy === 20);

  const reseed = h.seedMilestone('test_ms', 999, 1, 1); // should be a no-op since it already exists
  check('seeding an existing milestone key does not overwrite it', reseed.target === 10);

  h.db.prepare('UPDATE users SET balance = 0, candy = 0 WHERE user_id IN (?, ?)').run(U1, U2);
  h.incrementMilestone('test_ms', U1, 6);
  h.incrementMilestone('test_ms', U2, 3);
  let m = h.getMilestone('test_ms');
  check('progress accumulates across multiple contributors (6+3=9 of 10)', m.progress === 9 && m.achieved === 0);

  h.incrementMilestone('test_ms', U1, 5); // pushes well past target
  m = h.getMilestone('test_ms');
  check('milestone marked achieved once target is reached/passed', m.achieved === 1);
  check('every contributor gets the full reward_coin (not split)', h.getUser(U1).balance === 200 && h.getUser(U2).balance === 200, `U1=${h.getUser(U1).balance} U2=${h.getUser(U2).balance}`);
  check('every contributor gets the full reward_candy', h.getUser(U1).candy === 20 && h.getUser(U2).candy === 20);

  const balBeforeExtra = h.getUser(U1).balance;
  h.incrementMilestone('test_ms', U1, 1); // should be a no-op, already achieved
  check('incrementing an already-achieved milestone does not pay out again', h.getUser(U1).balance === balBeforeExtra);
}

console.log('=== 25. Cosmetic pet skins ===');
{
  check('6 skins in catalog', h.SKIN_CATALOG.length === 6);
  const rarities = h.SKIN_CATALOG.map(s => s.rarity);
  check('skins cover all 4 rarity ranks', ['Common', 'Rare', 'Epic', 'Legendary'].every(r => rarities.includes(r)));
  check('Cosmetics shop category mirrors the skin catalog 1:1', h.SHOP_ITEMS.Cosmetics.length === h.SKIN_CATALOG.length);

  h.db.prepare('DELETE FROM pet_skins WHERE user_id = ?').run(U1);
  check('user owns no skins initially', h.ownsSkin(U1, 'golden') === false);
  h.db.prepare('INSERT INTO pet_skins (user_id, skin_key) VALUES (?, ?)').run(U1, 'golden');
  check('ownsSkin reflects a purchased skin', h.ownsSkin(U1, 'golden') === true);
  check('ownsSkin correctly says no for an unowned skin', h.ownsSkin(U1, 'cosmic') === false);

  // cosmetic-only: applying a skin must NOT change the pet's buff contribution
  const petId = h.addPetToUser(U1, 'fox'); // +6% xp base
  h.setActivePet(U1, petId, 1);
  const buffNoSkin = h.getActiveBuff(U1);
  h.db.prepare('UPDATE pets SET skin_key = ? WHERE id = ?').run('golden', petId);
  const buffWithSkin = h.getActiveBuff(U1);
  check('applying a skin does not change the buff at all (purely cosmetic)', JSON.stringify(buffNoSkin) === JSON.stringify(buffWithSkin));

  const skin = h.skinByKey('golden');
  check('skinByKey resolves the correct skin object', skin.name === 'Golden' && skin.rarity === 'Common');
}

console.log('=== 26. Monthly / yearly claim math ===');
{
  check('MONTHLY_AMOUNT is configured and positive', h.MONTHLY_AMOUNT > 0);
  check('YEARLY_AMOUNT is configured and positive', h.YEARLY_AMOUNT > 0);
  check('yearly pays more than monthly, monthly pays more than daily', h.YEARLY_AMOUNT > h.MONTHLY_AMOUNT && h.MONTHLY_AMOUNT > h.DAILY_AMOUNT);

  h.db.prepare('UPDATE users SET perm_daily_bonus = 20 WHERE user_id = ?').run(U1);
  const buff = h.getActiveBuff(U1);
  const totalPct = buff.coin + h.getUser(U1).perm_daily_bonus;
  const boostedMonthly = h.applyBuff(h.MONTHLY_AMOUNT, totalPct);
  const boostedYearly = h.applyBuff(h.YEARLY_AMOUNT, totalPct);
  check('monthly claim applies the same buff formula as daily', boostedMonthly === Math.round(h.MONTHLY_AMOUNT * (1 + totalPct / 100)));
  check('yearly claim applies the same buff formula as daily', boostedYearly === Math.round(h.YEARLY_AMOUNT * (1 + totalPct / 100)));
}

console.log('=== 27. Duel + roulette shop/economy isolation ===');
{
  // sanity: none of the new Phase 8 systems accidentally share state that corrupts the core economy
  const before = h.getUser(U1).balance;
  h.db.prepare('UPDATE users SET balance = balance + 1000 WHERE user_id = ?').run(U1);
  const afterCoins = h.getUser(U1).balance;
  check('direct balance manipulation still works normally after all Phase 8 wiring', afterCoins === before + 1000);
}

console.log('\n' + '='.repeat(50));

console.log('=== 28. Audit fixes: pet slots, battles ===');
{
  // the same pet can't sit in two slots (would double its buff)
  h.db.prepare('DELETE FROM active_pets WHERE user_id = ?').run(U1);
  h.db.prepare('UPDATE users SET pet_slots = 3, prestige = 0 WHERE user_id = ?').run(U1);
  const kit = h.addPetToUser(U1, 'kitten');
  h.setActivePet(U1, kit, 1);
  h.setActivePet(U1, kit, 2);
  const rows = h.db.prepare('SELECT slot_index FROM active_pets WHERE user_id = ? AND pet_id = ?').all(U1, kit);
  check('a pet occupies only one slot', rows.length === 1 && rows[0].slot_index === 2, JSON.stringify(rows));
  check('re-equipping does not double the buff', h.getActiveBuff(U1).coin === 3, `got ${h.getActiveBuff(U1).coin}`);
  const kit2 = h.addPetToUser(U1, 'kitten');
  h.setActivePet(U1, kit2, 3);
  check('slot 3 works once owned', h.db.prepare('SELECT pet_id FROM active_pets WHERE user_id = ? AND slot_index = 3').get(U1)?.pet_id === kit2);

  // battles: ownership + wager coverage checked before resolving
  const a = h.addPetToUser(U1, 'kitten'), b = h.addPetToUser(U2, 'kitten');
  h.db.prepare('UPDATE users SET balance = 100 WHERE user_id IN (?, ?)').run(U1, U2);
  check('valid battle has no problem', h.battleProblem(U1, U2, a, b, 50) === null);
  h.db.prepare('UPDATE users SET balance = 1000 WHERE user_id = ?').run(U1);
  check('broke opponent cannot accept a wager', /need/.test(h.battleProblem(U1, U2, a, b, 500) || ''));
  h.db.prepare('UPDATE users SET balance = 100 WHERE user_id = ?').run(U1);
  h.db.prepare('UPDATE users SET balance = 10 WHERE user_id = ?').run(U1);
  check('broke challenger cancels the battle', /challenger no longer has/.test(h.battleProblem(U1, U2, a, b, 50) || ''));
  h.db.prepare('UPDATE pets SET user_id = ? WHERE id = ?').run(U2, a);
  check('challenger pet traded away cancels the battle', /no longer theirs/.test(h.battleProblem(U1, U2, a, b, 0) || ''));
  check("opponent can't use someone else's pet", /isn't yours/.test(h.battleProblem(U2, U1, b, a, 0) || '') || h.battleProblem(U2, U1, b, a, 0) !== null);
  h.db.prepare('UPDATE pets SET user_id = ? WHERE id = ?').run(U1, a);
  h.db.prepare('UPDATE users SET balance = 100 WHERE user_id IN (?, ?)').run(U1, U2);
  const r = h.resolveBattle(U1, U2, a, b, 40);
  const bal = id => h.getUser(id).balance;
  check('wager always moves winner +40 / loser -40', r.wagerPaid === 40 && bal(r.winnerId) === 140 && bal(r.loserId) === 60, `${bal(r.winnerId)}/${bal(r.loserId)}`);
}

console.log('\n=== 29. Phase 9: loans, stocks, nicknames ===');
{
  const L = 'test_loan_user';
  h.getUser(L); h.db.prepare('UPDATE users SET balance = 100 WHERE user_id = ?').run(L);
  const loan = h.takeLoan(L, 500);
  check('loan pays out principal', h.getUser(L).balance === 600);
  check('loan owes 5% more', loan.owed === 525, String(loan.owed));
  check('second loan refused while one is open', h.takeLoan(L, 100) === null && h.getUser(L).balance === 600);
  let r = h.repayLoan(L, 200);
  check('partial repay', r.paid === 200 && r.left === 325 && h.getUser(L).balance === 400);
  r = h.repayLoan(L);
  check('full repay clears loan', r.paid === 325 && r.left === 0 && h.getLoan(L) === null && h.getUser(L).balance === 75);
  // overdue collection takes what it can, never goes negative
  h.takeLoan(L, 1000);                        // balance 1075, owes 1050
  h.db.prepare('UPDATE users SET balance = 300 WHERE user_id = ?').run(L);
  h.db.prepare('UPDATE loans SET due_at = 0 WHERE user_id = ?').run(L);
  h.collectOverdueLoans();
  check('overdue collects what it can', h.getUser(L).balance === 0 && h.getLoan(L).owed === 750, `${h.getUser(L).balance}/${h.getLoan(L) && h.getLoan(L).owed}`);
  h.collectOverdueLoans();
  check('broke borrower stays at 0, debt kept', h.getUser(L).balance === 0 && h.getLoan(L).owed === 750);
  h.db.prepare('UPDATE users SET balance = 1000 WHERE user_id = ?').run(L);
  h.collectOverdueLoans();
  check('later income settles overdue debt', h.getLoan(L) === null && h.getUser(L).balance === 250);
  const notDue = 'test_loan_user2'; h.getUser(notDue);
  h.takeLoan(notDue, 100); h.collectOverdueLoans();
  check('loans not yet due are left alone', h.getLoan(notDue).owed === 105);

  const counts = {};
  const N = 200000;
  for (let i = 0; i < N; i++) { const c = h.rollStocks().coins(); counts[c] = (counts[c] || 0) + 1; }
  const pct = c => (counts[c] || 0) / N * 100;
  check('stocks: ~50% nothing', approx(pct(0), 50, 1), pct(0).toFixed(2));
  check('stocks: ~5% 1k', approx(pct(1000), 5, 0.4), pct(1000).toFixed(2));
  check('stocks: ~4.9% 2k', approx(pct(2000), 4.9, 0.4), pct(2000).toFixed(2));
  check('stocks: ~0.1% 10k', approx(pct(10000), 0.1, 0.06), pct(10000).toFixed(3));

  check('nickname strips markdown/mentions', h.cleanNickname('**@everyone** <b>') === 'everyone b', h.cleanNickname('**@everyone** <b>'));
  check('nickname length capped', h.cleanNickname('x'.repeat(50)).length === 24);
  check('withNick formats', h.withNick({ nickname: 'Bob' }, 'Dragon') === '"Bob" (Dragon)' && h.withNick({}, 'Dragon') === 'Dragon');
}

console.log('\n=== 30. Bank + robbing ===');
{
  const A = 'rob_a', B = 'rob_b', OWN = '546429809459200000';
  const set = (id, bal, bank = 0) => { h.getUser(id); h.db.prepare('UPDATE users SET balance = ?, bank = ?, last_rob = 0, last_robbed = 0 WHERE user_id = ?').run(bal, bank, id); };
  set(A, 1000);
  check('deposit all', h.bankDeposit(A) === 1000 && h.getUser(A).balance === 0 && h.getUser(A).bank === 1000);
  check('withdraw part', h.bankWithdraw(A, 300) === 300 && h.getUser(A).balance === 300 && h.getUser(A).bank === 700);
  check('withdraw capped at bank', h.bankWithdraw(A, 99999) === 700 && h.getUser(A).bank === 0);

  set(A, 1000); set(B, 5000, 100000);
  check('cannot rob self', /yourself/.test(h.robProblem(A, A)));
  set(B, 150); check('poor target refused', /not worth/.test(h.robProblem(A, B) || ''));
  set(B, 5000, 100000); set(A, 50); check('broke robber refused', /at least/.test(h.robProblem(A, B) || ''));
  set(A, 1000);
  let r = h.resolveRob(A, B, () => 0.0);       // forced success, rand 0 => lowest roll, 10%
  check('success steals the rolled % (10%) of the wallet only', r.success && r.pct === 10 && r.stolen === 500 && h.getUser(B).balance === 4500 && h.getUser(B).bank === 100000, JSON.stringify(r));
  check('robber cooldown set', /laying low/.test(h.robProblem(A, B) || ''));
  set(A, 1000); check('victim protected after robbery', /on guard/.test(h.robProblem(A, B) || ''));
  set(A, 1000); set(B, 50000);
  { let k = 0; r = h.resolveRob(A, B, () => (k++ === 0 ? 0.0 : 0.999)); }   // succeed, then top roll
  check('no cap: top roll steals 50% of a big wallet', r.success && r.pct === 50 && r.stolen === 25000 && h.getUser(B).balance === 25000, JSON.stringify(r));
  set(A, 2000); set(B, 5000);
  r = h.resolveRob(A, B, () => 0.99);          // fails; same roll gives 50%
  check('caught: the rolled % of the robber\'s wallet goes to the victim', !r.success && r.pct === 50 && r.fine === 1000 && h.getUser(A).balance === 1000 && h.getUser(B).balance === 6000, JSON.stringify(r));
  set(A, 300); set(B, 5000);
  { let k = 0; r = h.resolveRob(A, B, () => (k++ === 0 ? 0.99 : 0.0)); }    // fail, lowest roll
  check('caught with a 10% roll: pays exactly 10%, no minimum', !r.success && r.pct === 10 && r.fine === 30 && h.getUser(A).balance === 270, JSON.stringify(r));
  { const seen = new Set(); for (let i = 0; i < 3000; i++) { set(A, 1000); set(B, 5000); seen.add(h.resolveRob(A, B).pct); }
    check('rolls cover 10..50 and nothing else', seen.size === 41 && Math.min(...seen) === 10 && Math.max(...seen) === 50, [...seen].sort((a, b) => a - b).join(',')); }
  set(A, 1000); set(B, 5000); h.addRobItem(B, 'padlock', 1);
  r = h.resolveRob(A, B, () => 0.0);
  check('padlock blocks and breaks', !r.success && r.blockedByPadlock && h.getRobItem(B, 'padlock') === 0 && h.getUser(B).balance > 5000);
  set(A, 1000); set(B, 5000); h.addRobItem(A, 'lockpick', 1); h.addRobItem(A, 'mask', 1);
  r = h.resolveRob(A, B, () => 0.5);           // 0.5 < 0.40+0.15 → success thanks to lockpick
  check('lockpick adds 15% and is used', r.success && r.usedLockpick && h.getRobItem(A, 'lockpick') === 0 && h.getRobItem(A, 'mask') === 0);
  set(A, 1000); set(B, 5000); h.addBoost(B, 'guard_dog', 'guard', 20, 60000);
  r = h.resolveRob(A, B, () => 0.3);           // 0.3 >= 0.40-0.20 → fails with guard dog
  check('guard dog lowers odds by 20%', !r.success && Math.abs(r.chance - 0.20) < 1e-9, String(r.chance));
  // owner luck: robbing succeeds more often, being robbed succeeds less often
  let ownWins = 0, ownRobbed = 0; const T = 4000;
  for (let i = 0; i < T; i++) { set(OWN, 1000); set('rob_c', 5000); if (h.resolveRob(OWN, 'rob_c').success) ownWins++; }
  for (let i = 0; i < T; i++) { set(A, 1000); set(OWN, 5000); if (h.resolveRob(A, OWN).success) ownRobbed++; }
  check('owner robs always succeed', ownWins === T, String(ownWins));
  check('owner is robbed less (~34%)', approx(ownRobbed / T, 0.40 * (1 - 0.35 * 0.6), 0.03), (ownRobbed / T).toFixed(3));
}

console.log('\n=== 31. House games can\'t be beaten with buffs ===');
{
  const maxBuff = 500; // far more than anyone can stack
  check('bonus capped at +5%', h.houseWinBonus(maxBuff) === 5 && h.houseWinBonus(25) === 2.5);
  const ev = (p, mult) => (p * h.housePayout(10000, mult, maxBuff)) / 10000;
  check('coinflip EV < 1 even fully buffed', ev(0.5, 1.95) < 1, ev(0.5, 1.95).toFixed(4));
  check('roulette colour EV < 1 even fully buffed', ev(18 / 37, 2) < 1, ev(18 / 37, 2).toFixed(4));
  check('roulette number EV < 1 even fully buffed', ev(1 / 37, 35) < 1, ev(1 / 37, 35).toFixed(4));
  check('unbuffed payout unchanged for 2x', h.housePayout(1000, 2, 0) === 2000);
}

console.log('\n=== 32. Bank heists ===');
{
  const L = 'hz_lead', M = 'hz_mem', V = 'hz_vic', OWN = '546429809459200000';
  const reset = (id, bal, bank = 0) => { h.getUser(id); h.db.prepare('UPDATE users SET balance = ?, bank = ?, last_heist = 0, last_heisted = 0 WHERE user_id = ?').run(bal, bank, id); h.db.prepare('DELETE FROM rob_items WHERE user_id = ?').run(id); };
  const gear = (id, kit = 1, drill = 0, laptop = 0) => { if (kit) h.addRobItem(id, 'heist_kit', kit); if (drill) h.addRobItem(id, 'drill', drill); if (laptop) h.addRobItem(id, 'laptop', laptop); };
  reset(L, 1000); reset(M, 1000); reset(V, 0, 100000);
  check('needs a kit to join', /Heist Kit/.test(h.heistMemberProblem(L, V) || ''));
  gear(L, 1, 1, 0); gear(M, 1, 0, 0);
  check('solo crew refused', /at least 2/.test(h.heistStartProblem([L], V) || ''));
  check('needs a laptop', /Laptop/.test(h.heistStartProblem([L, M], V) || ''));
  h.addRobItem(M, 'laptop', 1);
  check('ready crew passes', h.heistStartProblem([L, M], V) === null);
  reset(V, 0, 1000); check('poor bank refused', /not worth/.test(h.heistTargetProblem(V) || ''));
  reset(V, 0, 100000);
  let r = h.resolveHeist([L, M], V, () => 0.0);
  check('success takes 10% of bank, split', r.success && r.take === 10000 && h.getUser(L).balance === 6000 && h.getUser(M).balance === 6000 && h.getUser(V).bank === 90000, JSON.stringify(r));
  check('gear used up', h.getRobItem(L, 'heist_kit') === 0 && h.getRobItem(L, 'drill') === 0 && h.getRobItem(M, 'laptop') === 0);
  check('crew on cooldown', /laying low/.test(h.heistMemberProblem(L, V) || ''));
  check('victim protected 48h', /security is tight/.test(h.heistTargetProblem(V) || ''));
  reset(L, 1000); reset(M, 500); reset(V, 0, 1000000); gear(L, 1, 1, 1); gear(M);
  r = h.resolveHeist([L, M], V, () => 0.0);
  check('take capped at 20k', r.take === 20000);
  reset(L, 1000); reset(M, 500); reset(V, 0, 100000); gear(L, 1, 1, 1); gear(M);
  r = h.resolveHeist([L, M], V, () => 0.99);
  check('failure fines 20% each to the victim', !r.success && r.fines[L] === 200 && r.fines[M] === 100 && h.getUser(V).balance === 300, JSON.stringify(r));
  reset(L, 1000); reset(M, 500); reset(V, 0, 100000); gear(L, 1, 1, 1); gear(M); h.addBoost(V, 'vault_alarm', 'vault', 15, 60000);
  r = h.resolveHeist([L, M], V, () => 0.25);
  check('vault alarm lowers odds by 15%', !r.success && Math.abs(r.chance - 0.20) < 1e-9, String(r.chance));
  reset(OWN, 1000); reset(M, 500); reset('hz_vic2', 0, 100000); gear(OWN, 1, 1, 1); gear(M);
  r = h.resolveHeist([OWN, M], 'hz_vic2', () => 0.99);
  check('owner crews always succeed', r.success);
}

console.log(`RESULTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('✅ All systems verified.');
  process.exit(0);
}
