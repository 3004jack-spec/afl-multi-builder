/**
 * Model validation: for every current Sportsbet line, compare the model's
 * predicted hit rate against the actual historical hit rate across ALL seasons.
 * No odds needed — pure calibration check.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stored = JSON.parse(readFileSync(join(__dirname, "../data/player-stats.json"), "utf8"));
const sbData = JSON.parse(readFileSync(join(__dirname, "../data/sportsbet-odds.json"), "utf8"));

// ── Model functions (mirrors route.ts exactly) ────────────────────────────────

function weightedHitRate(values, threshold) {
  if (!values.length) return 0;
  let sumW = 0, sumHit = 0;
  for (let i = 0; i < values.length; i++) {
    const w = Math.pow(0.966, values.length - 1 - i);
    sumW += w;
    if (values[i] >= threshold) sumHit += w;
  }
  return Math.round((sumHit / sumW) * 1000) / 10;
}

function bayesianBlend(hr10, rawPrior, priorN) {
  const shrunkPrior = (rawPrior * priorN + 65 * 10) / (priorN + 10);
  return Math.round(((10 * hr10 + 25 * shrunkPrior) / 35) * 10) / 10;
}

// Pick the model's chosen line from a set of Sportsbet thresholds
function modelPick(values, sbThresholds) {
  const seasonAvg = values.reduce((a, b) => a + b, 0) / values.length;
  const last10 = values.slice(-10);
  const pricedLines = [];
  for (const [threshStr, price] of Object.entries(sbThresholds)) {
    const threshold = parseInt(threshStr);
    if (isNaN(threshold) || price < 1.01) continue;
    if (seasonAvg < threshold) continue;
    const allHr = weightedHitRate(values, threshold);
    const hr10 = last10.length
      ? Math.round(last10.filter(v => v >= threshold).length / last10.length * 1000) / 10
      : allHr;
    const br = bayesianBlend(hr10, allHr, values.length);
    const implied = Math.round((1 / price) * 1000) / 10;
    pricedLines.push({ threshold, odds: price, br, bayesianEdge: br - implied });
  }
  if (!pricedLines.length) return null;
  pricedLines.sort((a, b) => b.bayesianEdge - a.bayesianEdge);
  return pricedLines[0];
}

// ── Cross-validation: leave-one-out across all historical games ───────────────
// For each player+stat line: use ALL games except game i to predict, check game i

const observations = []; // { predicted, actual_hit, threshold, playerName, stat, odds }
let skipped = 0;

for (const match of sbData.matches) {
  for (const [playerName, statMap] of Object.entries(match.markets)) {
    const playerData = stored[playerName];
    if (!playerData) { skipped++; continue; }

    for (const [statKey, thresholds] of Object.entries(statMap)) {
      const allValues = playerData.games
        .map(g => g[statKey])
        .filter(v => typeof v === "number");

      if (allValues.length < 15) continue; // need enough history

      // Leave-one-out: for each game, predict using all OTHER games
      for (let i = 10; i < allValues.length; i++) { // start at 10 so we always have ≥10 training
        const trainValues = [...allValues.slice(0, i)];
        const actual = allValues[i];

        const pick = modelPick(trainValues, thresholds);
        if (!pick) continue;

        observations.push({
          playerName,
          stat: statKey,
          threshold: pick.threshold,
          odds: pick.odds,
          predicted: pick.br,
          actual_hit: actual >= pick.threshold ? 1 : 0,
          actual_value: actual,
        });
      }
    }
  }
}

console.log(`\n=== MODEL VALIDATION — Leave-One-Out Cross-Validation ===`);
console.log(`Players missing from stats: ${skipped}`);
console.log(`Total observations: ${observations.length}`);
if (!observations.length) { console.log("No data."); process.exit(0); }

const overallHit = Math.round(observations.filter(o => o.actual_hit).length / observations.length * 1000) / 10;
const overallPred = Math.round(observations.reduce((s, o) => s + o.predicted, 0) / observations.length * 10) / 10;
console.log(`Overall actual hit rate: ${overallHit}%`);
console.log(`Model predicted avg:     ${overallPred}%`);
console.log(`Calibration gap:         ${Math.round((overallHit - overallPred) * 10) / 10}%\n`);

// Calibration bands
console.log("── Calibration by confidence band ──");
console.log("  Band      Predicted  Actual     Count   Gap        Verdict");
console.log("  ─────────────────────────────────────────────────────────");
const BANDS = [
  { label: "60–65%", min: 60, max: 65 },
  { label: "65–70%", min: 65, max: 70 },
  { label: "70–75%", min: 70, max: 75 },
  { label: "75–80%", min: 75, max: 80 },
  { label: "80–85%", min: 80, max: 85 },
  { label: "85–90%", min: 85, max: 90 },
  { label: "90–95%", min: 90, max: 95 },
  { label: "95%+",   min: 95, max: 101 },
];

for (const band of BANDS) {
  const obs = observations.filter(o => o.predicted >= band.min && o.predicted < band.max);
  if (obs.length < 5) continue;
  const hits = obs.filter(o => o.actual_hit).length;
  const actual = Math.round(hits / obs.length * 1000) / 10;
  const mid = (band.min + band.max) / 2;
  const gap = Math.round((actual - mid) * 10) / 10;
  const verdict = Math.abs(gap) <= 5 ? "✅ calibrated" : gap > 0 ? "⬆️  conservative" : "⬇️  overconfident";
  console.log(`  ${band.label.padEnd(10)}~${mid.toFixed(0)}%       ${String(actual + "%").padEnd(11)}${obs.length.toString().padEnd(8)}${(gap >= 0 ? "+" : "") + gap + "%"}    ${verdict}`);
}

// Per-stat calibration
console.log("\n── Calibration by stat type ──");
const STATS = ["disposals","kicks","marks","handballs","tackles","clearances","goals"];
for (const stat of STATS) {
  const obs = observations.filter(o => o.stat === stat);
  if (!obs.length) continue;
  const hits = obs.filter(o => o.actual_hit).length;
  const actual = Math.round(hits / obs.length * 1000) / 10;
  const pred = Math.round(obs.reduce((s, o) => s + o.predicted, 0) / obs.length * 10) / 10;
  const gap = Math.round((actual - pred) * 10) / 10;
  console.log(`  ${stat.padEnd(14)} predicted ${pred}%  actual ${actual}%  gap ${gap >= 0 ? "+" : ""}${gap}%  (n=${obs.length})`);
}

// Brier score (proper scoring rule — lower is better, 0.25 = random, 0 = perfect)
const brier = observations.reduce((s, o) => s + Math.pow(o.predicted / 100 - o.actual_hit, 2), 0) / observations.length;
const brierBaseline = observations.reduce((s, o) => s + Math.pow(overallHit / 100 - o.actual_hit, 2), 0) / observations.length;
console.log(`\n── Scoring ──`);
console.log(`Brier score:          ${Math.round(brier * 1000) / 1000} (lower is better; baseline=${Math.round(brierBaseline * 1000) / 1000})`);
console.log(`Brier skill score:    ${Math.round((1 - brier / brierBaseline) * 1000) / 10}% (skill vs naive baseline)`);

// What threshold gives reliable calibration?
console.log("\n── Where to trust the model ──");
for (const minBR of [70, 75, 80, 85, 90]) {
  const obs = observations.filter(o => o.predicted >= minBR);
  if (!obs.length) continue;
  const hits = obs.filter(o => o.actual_hit).length;
  const actual = Math.round(hits / obs.length * 1000) / 10;
  const pred = Math.round(obs.reduce((s, o) => s + o.predicted, 0) / obs.length * 10) / 10;
  const gap = Math.round((actual - pred) * 10) / 10;
  console.log(`  BR ≥ ${minBR}%: predicted ${pred}%  actual ${actual}%  gap ${gap >= 0 ? "+" : ""}${gap}%  (n=${obs.length})`);
}

// Calibration correction factor
console.log("\n── Calibration correction (shrink factor to apply to model outputs) ──");
const highConf = observations.filter(o => o.predicted >= 80);
if (highConf.length) {
  const actualAvg = highConf.filter(o => o.actual_hit).length / highConf.length;
  const predAvg = highConf.reduce((s, o) => s + o.predicted / 100, 0) / highConf.length;
  const shrink = Math.round((actualAvg / predAvg) * 100) / 100;
  console.log(`  For BR ≥ 80%: multiply model output by ${shrink} to get calibrated estimate`);
  console.log(`  e.g. model says 85% → calibrated ${Math.round(85 * shrink)}%`);
  console.log(`       model says 90% → calibrated ${Math.round(90 * shrink)}%`);
  console.log(`       model says 75% → calibrated ${Math.round(75 * shrink)}%`);
}
