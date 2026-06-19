import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

type StatType = "disposals" | "goals" | "marks" | "kicks" | "handballs" | "tackles" | "clearances";

interface StoredGame {
  year: number;
  round: string;
  disposals: number;
  kicks?: number;
  marks?: number;
  handballs?: number;
  goals?: number;
  tackles?: number;
  clearances?: number;
}

interface StoredPlayer {
  games: StoredGame[];
  fetchedAt?: string;
  matchup?: string;
}

const STATS: StatType[] = ["disposals", "kicks", "marks", "handballs", "tackles", "goals"];

// Minimum threshold per stat — below this a line is too easy to be priced on Sportsbet
const MIN_THRESHOLD: Record<StatType, number> = {
  disposals:  10,
  kicks:       4,
  marks:       3,
  handballs:   5,
  tackles:     3,
  goals:       1,
  clearances:  3,
};

function parseRound(r: string): number {
  const n = parseInt(r);
  if (!isNaN(n)) return n;
  const finals: Record<string, number> = { EF: 25, SF: 26, PF: 27, GF: 28 };
  return finals[r.toUpperCase()] ?? 99;
}

function relevantStatValues(games: StoredGame[], stat: StatType, currentYear: number): number[] {
  const minYear = currentYear - 2;
  const filtered = games.filter(g => g.year >= minYear);
  const years = [...new Set(filtered.map(g => g.year))].sort((a, b) => a - b);
  const result: StoredGame[] = [];
  for (const year of years) {
    const season = filtered
      .filter(g => g.year === year)
      .sort((a, b) => parseRound(a.round) - parseRound(b.round));
    let cutIndex = 0;
    for (let i = 1; i < season.length; i++) {
      if (parseRound(season[i].round) - parseRound(season[i - 1].round) >= 5) cutIndex = i;
    }
    result.push(...season.slice(cutIndex));
  }
  return result.map(g => {
    const v = (g as unknown as Record<string, unknown>)[stat];
    return typeof v === "number" ? v : 0;
  });
}

function weightedHitRate(values: number[], threshold: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const HALF_LIFE = 20;
  const decay = Math.pow(0.5, 1 / HALF_LIFE);
  let weightedHits = 0, totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const gamesAgo = n - 1 - i;
    const w = Math.pow(decay, gamesAgo);
    if (values[i] >= threshold) weightedHits += w;
    totalWeight += w;
  }
  return Math.round((weightedHits / totalWeight) * 1000) / 10;
}

export interface HistoricalPick {
  playerName: string;
  statType: StatType;
  suggestedThreshold: number;
  bayesianRate: number;
  hitRate10: number;
  hitRate5: number;
  allTimeRate: number;
  seasonAvg: number;
  recentForm: number[];
  gamesAnalysed: number;
  suggestedLine: string; // e.g. "19+ disposals"
  matchup?: string;
}

function loadPlayerStats(): Record<string, StoredPlayer> {
  const filePath = join(process.cwd(), "data", "player-stats.json");
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const minBayesian = parseFloat(url.searchParams.get("minBayesian") ?? "70");

  const stored = loadPlayerStats();
  const picks: HistoricalPick[] = [];

  for (const [playerName, player] of Object.entries(stored)) {
    if (player.games.length < 10) continue;

    // Only include players active in 2026
    const mostRecentYear = player.games[player.games.length - 1].year;
    if (mostRecentYear < 2026) continue;

    const currentYear = new Date().getFullYear();

    for (const stat of STATS) {
      const values = player.games.map((g) => {
        const v = (g as unknown as Record<string, unknown>)[stat];
        return typeof v === "number" ? v : 0;
      });

      // Skip if this player has no meaningful data for this stat
      const nonZero = values.filter(v => v > 0).length;
      if (nonZero < player.games.length * 0.5) continue; // mostly zeros = not their stat

      const n = values.length;
      const seasonAvg = Math.round((values.reduce((a, b) => a + b, 0) / n) * 100) / 100;
      if (seasonAvg < 3) continue; // skip very low-volume stats

      // Relevant prior: 3-season cap + injury gap detection
      const priorValues = relevantStatValues(player.games, stat, currentYear);
      const priorN = priorValues.length || 1;

      const last5 = values.slice(-5);
      const last10 = values.slice(-10);

      // Scan thresholds from stat minimum (realistic Sportsbet line) up to seasonAvg
      // Find the highest threshold where bayesianRate >= minBayesian
      const statMin = MIN_THRESHOLD[stat] ?? 1;
      let bestThreshold = 0;
      let bestBayesian = 0;
      let bestHr10 = 0;
      let bestHr5 = 0;
      let bestAllTime = 0;

      const maxThreshold = Math.ceil(seasonAvg * 1.1); // allow slightly above avg
      for (let t = statMin; t <= maxThreshold; t++) {
        const allTime = weightedHitRate(values, t);
        const hr10 = last10.length
          ? Math.round((last10.filter(v => v >= t).length / last10.length) * 1000) / 10
          : allTime;
        const hr5 = last5.length
          ? Math.round((last5.filter(v => v >= t).length / last5.length) * 1000) / 10
          : allTime;
        // Smart prior: relevant games (3-season cap + injury gaps) + 10 pseudo-games at 65%
        const rawPrior = weightedHitRate(priorValues, t);
        const shrunkPrior = Math.round((rawPrior * priorN + 65 * 10) / (priorN + 10) * 10) / 10;
        const bayesian = Math.round(((10 * hr10 + 25 * shrunkPrior) / 35) * 10) / 10;

        // Season avg must be >= threshold — only consider lines a player can realistically hit
        if (seasonAvg < t) continue;
        if (bayesian >= minBayesian && t > bestThreshold) {
          bestThreshold = t;
          bestBayesian = bayesian;
          bestHr10 = hr10;
          bestHr5 = hr5;
          bestAllTime = allTime;
        }
      }

      if (bestThreshold === 0) continue;

      picks.push({
        playerName,
        statType: stat,
        suggestedThreshold: bestThreshold,
        bayesianRate: bestBayesian,
        hitRate10: bestHr10,
        hitRate5: bestHr5,
        allTimeRate: bestAllTime,
        seasonAvg,
        recentForm: last5,
        gamesAnalysed: n,
        suggestedLine: `${bestThreshold}+ ${stat}`,
        matchup: player.matchup ?? "",
      });
    }
  }

  // Sort by Bayesian rate desc, then by hitRate10 desc
  picks.sort((a, b) => b.bayesianRate - a.bayesianRate || b.hitRate10 - a.hitRate10);

  return NextResponse.json({ picks });
}
