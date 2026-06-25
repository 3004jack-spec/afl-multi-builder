/**
 * Walk-forward backtest using ACTUAL Sportsbet lines and prices.
 * Mirrors the exact line selection logic from player-props/route.ts:
 *   1. Filter lines where seasonAvg >= threshold
 *   2. Pick best by bayesianEdge (model-selected line)
 *   3. Only keep if Kelly > 0
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stored = JSON.parse(readFileSync(join(__dirname, "../data/player-stats.json"), "utf8"));
const sbData = JSON.parse(readFileSync(join(__dirname, "../data/sportsbet-odds.json"), "utf8"));

const TEST_ROUNDS = [11, 12, 13, 14, 15];
const TEST_YEAR = 2026;
const BANKROLL = 200;

function weightedHitRate(values, threshold) {
  if (!values.length) return 0;
  let sumW = 0, sumHit = 0;
  for (let i = 0; i < values.length; i++) {
    const w = Math.pow(0.966, values.length - 1 - i);
    sumW += w;
    if (values[i] >= threshold) sumHit += w;
  }
  return sumW > 0 ? Math.round((sumHit / sumW) * 1000) / 10 : 0;
}

function bayesianBlend(hr10, rawPrior, priorN) {
  const shrunkPrior = (rawPrior * priorN + 65 * 10) / (priorN + 10);
  return Math.round(((10 * hr10 + 25 * shrunkPrior) / 35) * 10) / 10;
}

function kelly(br, odds) {
  return Math.max(0, Math.round(((br / 100 * odds - 1) / (odds - 1)) * 1000) / 10);
}

// For a player+stat, pick the model's chosen line given a set of training values
// Returns null if no eligible line or Kelly <= 0
function modelPick(trainValues, sbThresholds) {
  const seasonAvg = trainValues.reduce((a, b) => a + b, 0) / trainValues.length;
  const last10 = trainValues.slice(-10);

  const pricedLines = [];
  for (const [threshStr, price] of Object.entries(sbThresholds)) {
    const threshold = parseInt(threshStr); // Sportsbet "18+" means exactly 18
    if (isNaN(threshold) || price < 1.01) continue;
    if (seasonAvg < threshold) continue; // model eligibility gate

    const allHr = weightedHitRate(trainValues, threshold);
    const hr10 = last10.length
      ? Math.round(last10.filter(v => v >= threshold).length / last10.length * 1000) / 10
      : allHr;
    const br = bayesianBlend(hr10, allHr, trainValues.length);
    const implied = Math.round((1 / price) * 1000) / 10;
    const bayesianEdge = Math.round((br - implied) * 10) / 10;
    pricedLines.push({ threshold, odds: price, br, hr10, bayesianEdge, implied });
  }

  if (!pricedLines.length) return null;
  pricedLines.sort((a, b) => b.bayesianEdge - a.bayesianEdge);
  const best = pricedLines[0];
  const k = kelly(best.br, best.odds);
  if (k <= 0) return null;

  return { ...best, kellyPct: k, ev: Math.round((best.br - best.implied) * 10) / 10 };
}

// ── Run backtest ──────────────────────────────────────────────────────────────

const results = [];
let skippedNoStats = 0, skippedNoGames = 0;

for (const match of sbData.matches) {
  for (const [playerName, statMap] of Object.entries(match.markets)) {
    const playerData = stored[playerName];
    if (!playerData) { skippedNoStats++; continue; }

    for (const [statKey, thresholds] of Object.entries(statMap)) {
      for (const round of TEST_ROUNDS) {
        const trainGames = playerData.games.filter(g =>
          g.year < TEST_YEAR || (g.year === TEST_YEAR && parseInt(g.round) < round)
        );
        const testGame = playerData.games.find(g =>
          g.year === TEST_YEAR && parseInt(g.round) === round
        );
        if (!testGame) continue;

        const trainValues = trainGames
          .map(g => g[statKey])
          .filter(v => typeof v === "number");
        if (trainValues.length < 10) { skippedNoGames++; continue; }

        const actualValue = testGame[statKey];
        if (typeof actualValue !== "number") continue;

        const pick = modelPick(trainValues, thresholds);
        if (!pick) continue;

        results.push({
          round,
          playerName,
          stat: statKey,
          threshold: pick.threshold,
          odds: pick.odds,
          bayesianRate: pick.br,
          kellyPct: pick.kellyPct,
          ev: pick.ev,
          actual: actualValue,
          hit: actualValue >= pick.threshold,
        });
      }
    }
  }
}

console.log(`\n=== BACKTEST: Rounds ${TEST_ROUNDS[0]}–${TEST_ROUNDS[TEST_ROUNDS.length-1]} of ${TEST_YEAR} ===`);
console.log(`Players in Sportsbet not in stats: ${skippedNoStats} (name mismatch)`);
console.log(`Legs skipped (< 10 training games): ${skippedNoGames}`);
console.log(`Total legs with genuine edge: ${results.length}\n`);

if (!results.length) {
  console.log("No results — check player name overlap.");
  process.exit(0);
}

const hits = results.filter(r => r.hit).length;
console.log(`Overall hit rate:    ${Math.round(hits / results.length * 1000) / 10}%`);
console.log(`Model predicted avg: ${Math.round(results.reduce((s, r) => s + r.bayesianRate, 0) / results.length * 10) / 10}%`);
console.log(`Avg odds per leg:    $${Math.round(results.reduce((s, r) => s + r.odds, 0) / results.length * 100) / 100}`);
console.log(`Avg EV per leg:      +${Math.round(results.reduce((s, r) => s + r.ev, 0) / results.length * 10) / 10}%`);

// Calibration
console.log("\n── Calibration (predicted vs actual hit rate) ──");
const BANDS = [
  { label: "65–70%", min: 65, max: 70 },
  { label: "70–75%", min: 70, max: 75 },
  { label: "75–80%", min: 75, max: 80 },
  { label: "80–85%", min: 80, max: 85 },
  { label: "85–90%", min: 85, max: 90 },
  { label: "90%+",   min: 90, max: 101 },
];
for (const band of BANDS) {
  const legs = results.filter(r => r.bayesianRate >= band.min && r.bayesianRate < band.max);
  if (!legs.length) continue;
  const h = legs.filter(r => r.hit).length;
  const actual = Math.round(h / legs.length * 1000) / 10;
  const mid = (band.min + band.max) / 2;
  const drift = Math.round((actual - mid) * 10) / 10;
  const avgOdds = Math.round(legs.reduce((s, r) => s + r.odds, 0) / legs.length * 100) / 100;
  console.log(`  ${band.label.padEnd(8)} predicted ~${mid.toFixed(0)}%  actual ${String(actual + "%").padEnd(7)} (${h}/${legs.length})  avg odds $${avgOdds}  drift ${drift >= 0 ? "+" : ""}${drift}%`);
}

// Per-round summary
console.log("\n── Per-round summary ──");
for (const round of TEST_ROUNDS) {
  const rLegs = results.filter(r => r.round === round);
  if (!rLegs.length) { console.log(`  Rd ${round}: no legs`); continue; }
  const h = rLegs.filter(r => r.hit).length;
  const avgOdds = Math.round(rLegs.reduce((s, r) => s + r.odds, 0) / rLegs.length * 100) / 100;
  console.log(`  Rd ${round}: ${h}/${rLegs.length} hit (${Math.round(h/rLegs.length*1000)/10}%)  avg odds $${avgOdds}  legs predicted avg ${Math.round(rLegs.reduce((s,r)=>s+r.bayesianRate,0)/rLegs.length*10)/10}%`);
}

// Best 2-leg multi per round (real odds, $10 flat stake)
console.log("\n── Best 2-leg multi per round (real Sportsbet odds, $10 flat stake) ──");
let totalStaked = 0, totalReturn = 0;
for (const round of TEST_ROUNDS) {
  const rLegs = results.filter(r => r.round === round);
  const byPlayer = {};
  for (const leg of rLegs) {
    if (!byPlayer[leg.playerName] || leg.bayesianRate > byPlayer[leg.playerName].bayesianRate) {
      byPlayer[leg.playerName] = leg;
    }
  }
  const pool = Object.values(byPlayer).sort((a, b) => b.bayesianRate - a.bayesianRate);
  if (pool.length < 2) { console.log(`  Rd ${round}: not enough legs`); continue; }

  let bestCombo = null, bestK = -Infinity;
  for (let i = 0; i < Math.min(pool.length, 12); i++) {
    for (let j = i + 1; j < Math.min(pool.length, 12); j++) {
      const comboOdds = pool[i].odds * pool[j].odds;
      const comboSR = pool[i].bayesianRate / 100 * pool[j].bayesianRate / 100 * 100;
      const k = kelly(comboSR, comboOdds);
      if (k > bestK) { bestK = k; bestCombo = [pool[i], pool[j]]; }
    }
  }
  if (!bestCombo || bestK <= 0) { console.log(`  Rd ${round}: no positive Kelly combo`); continue; }

  const comboOdds = Math.round(bestCombo[0].odds * bestCombo[1].odds * 100) / 100;
  const comboSR = Math.round(bestCombo[0].bayesianRate / 100 * bestCombo[1].bayesianRate / 100 * 1000) / 10;
  const won = bestCombo[0].hit && bestCombo[1].hit;
  const ret = won ? Math.round(10 * comboOdds * 100) / 100 : 0;
  totalStaked += 10;
  totalReturn += ret;
  const net = Math.round((ret - 10) * 100) / 100;
  console.log(`  Rd ${round}: ${bestCombo[0].playerName} ${bestCombo[0].stat} ${bestCombo[0].threshold}+ ($${bestCombo[0].odds}) + ${bestCombo[1].playerName} ${bestCombo[1].stat} ${bestCombo[1].threshold}+ ($${bestCombo[1].odds})`);
  console.log(`         combo $${comboOdds}  SR ${comboSR}%  Kelly ${bestK.toFixed(1)}%  ${won ? "✅ WON" : "❌ LOST"}  P&L $${net >= 0 ? "+" : ""}${net.toFixed(2)}`);
}
const totalNet = Math.round((totalReturn - totalStaked) * 100) / 100;
console.log(`\n  Staked $${totalStaked}  Returned $${totalReturn.toFixed(2)}  Net $${totalNet >= 0 ? "+" : ""}${totalNet.toFixed(2)}`);

// Top legs by EV for this round (current recommendations)
console.log("\n── Current recommendations for this round (by EV) ──");
const currentPicks = [];
for (const match of sbData.matches) {
  for (const [playerName, statMap] of Object.entries(match.markets)) {
    const playerData = stored[playerName];
    if (!playerData) continue;
    for (const [statKey, thresholds] of Object.entries(statMap)) {
      const values = playerData.games.map(g => g[statKey]).filter(v => typeof v === "number");
      if (values.length < 10) continue;
      const pick = modelPick(values, thresholds);
      if (!pick || pick.br < 75) continue;
      currentPicks.push({ playerName, stat: statKey, matchup: match.matchup, ...pick });
    }
  }
}
currentPicks.sort((a, b) => b.ev - a.ev);
for (const p of currentPicks.slice(0, 15)) {
  console.log(`  ${p.playerName.padEnd(22)} ${p.stat.padEnd(12)} ${p.threshold}+  $${p.odds}  BR ${p.br}%  EV +${p.ev}%  Kelly ${p.kellyPct}%  [${p.matchup}]`);
}
