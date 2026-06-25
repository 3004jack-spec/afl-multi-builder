import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const SQUIGGLE = "https://api.squiggle.com.au";

type StatType = "disposals" | "goals" | "marks" | "kicks" | "handballs" | "tackles" | "clearances";

interface SquiggleEvent { id: string; home_team: string; away_team: string; commence_time: string; }

// Fixture source: Squiggle (free, no quota) — replaces the old Odds API events lookup,
// which was stuck returning a stale/wrong round (see SESSION_NOTES.md, 2026-06-25).
async function getSquiggleFixtures(): Promise<SquiggleEvent[]> {
  try {
    const year = new Date().getFullYear();
    const res = await fetch(`${SQUIGGLE}/?q=games;year=${year}`, {
      headers: { "User-Agent": "afl-multi-builder/1.0" },
      next: { revalidate: 300 },
    });
    const data = await res.json();
    return (data.games ?? [])
      .filter((g: { complete: number; hteam: string | null; ateam: string | null }) => g.complete < 100 && g.hteam && g.ateam)
      .map((g: { id: number; hteam: string; ateam: string; date: string }) => ({
        id: String(g.id),
        home_team: g.hteam,
        away_team: g.ateam,
        commence_time: new Date(g.date.replace(" ", "T") + "+10:00").toISOString(),
      }));
  } catch {
    return [];
  }
}

interface ThresholdPoint {
  threshold: number;
  line: number;
  hitRate: number; // recency-weighted
}

interface PricedLine {
  line: number;
  bookmakerOdds: Record<string, number>;
  bestOdds: number;
  bestBookie: string;
  hitRate: number;       // recency-weighted all-time hit rate at this line
  hitRate10: number;     // straight L10 hit rate at this line
  bayesianRate: number;  // (10×L10 + 15×allTime) / 25 — blended reliability estimate
  bookmakerImplied: number;
  edge: number;          // allTime edge
  bayesianEdge: number;  // bayesianRate − implied — informational only, no longer drives line selection
  kelly: number;         // Kelly fraction on shrunk bayesianRate — used to pick the optimal line
}

interface PlayerProp {
  playerName: string;
  matchup: string;
  commenceTime: string;
  statType: StatType;
  statLabel: string;
  marketLine: number;
  bestOdds: number;
  bestBookie: string;
  bookmakerOdds: Record<string, number>;
  isAlternateLine: boolean;
  allPricedLines: PricedLine[];
  gamesAnalysed: number;
  hitRate: number;       // recency-weighted all-time
  hitRate5: number;      // straight hit rate last 5 games
  hitRate10: number;     // straight hit rate last 10 games
  bayesianRate: number;  // (10×L10 + 25×shrunkPrior) / 35 — primary reliability estimate
  coldForm: boolean;     // true when last-10 hit rate is 25+ points below all-time
  bookmakerImplied: number;
  edge: number;          // all-time weighted edge
  recentEdge: number;    // L10 hit rate minus bookmaker implied
  bayesianEdge: number;  // bayesianRate − implied — informational only
  kelly: number;         // Kelly fraction on shrunk bayesianRate — used to rank and filter
  seasonAvg: number;
  recentForm: number[];
  thresholds: ThresholdPoint[];
}

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
  fetchedAt: string;
  marketLine: number;
  matchup: string;
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

interface SportsbetOdds {
  fetchedAt: string;
  matches: Array<{
    matchup: string;
    url: string;
    markets: Record<string, Record<string, Record<string, number>>>;
  }>;
}

function loadSportsbetOdds(): SportsbetOdds | null {
  const filePath = join(process.cwd(), "data", "sportsbet-odds.json");
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function loadBetrOdds(): SportsbetOdds | null {
  const filePath = join(process.cwd(), "data", "betr-odds.json");
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseRound(r: string): number {
  const n = parseInt(r);
  if (!isNaN(n)) return n;
  const finals: Record<string, number> = { EF: 25, SF: 26, PF: 27, GF: 28 };
  return finals[r.toUpperCase()] ?? 99;
}

/**
 * Returns stat values from only "relevant" games:
 * - Last 3 seasons (guards against old club/position data)
 * - Per season, if a gap of ≥5 rounds exists, drops pre-gap games (guards against injury returns)
 */
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

/**
 * Recency-weighted hit rate. Games stored oldest→newest.
 * Half-life = 20 games ≈ one AFL season.
 * Last season carries ~53% of total weight; games 2+ years back are near-zero.
 */
function weightedHitRate(values: number[], threshold: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const HALF_LIFE = 20;
  const decay = Math.pow(0.5, 1 / HALF_LIFE); // ≈ 0.966 per game
  let weightedHits = 0;
  let totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const gamesAgo = n - 1 - i; // 0 = most recent
    const w = Math.pow(decay, gamesAgo);
    if (values[i] >= threshold) weightedHits += w;
    totalWeight += w;
  }
  return Math.round((weightedHits / totalWeight) * 1000) / 10;
}

function buildThresholds(values: number[]): ThresholdPoint[] {
  const n = values.length;
  if (n === 0) return [];
  const min = Math.max(0, Math.min(...values));
  const max = Math.max(...values);
  const thresholds: ThresholdPoint[] = [];
  for (let t = min; t <= max + 1; t++) {
    thresholds.push({
      threshold: t,
      line: t - 0.5,
      hitRate: weightedHitRate(values, t),
    });
  }
  return thresholds;
}

export async function GET() {
  const stored = loadPlayerStats();
  if (Object.keys(stored).length === 0) {
    return NextResponse.json({ props: [], message: "No player stats. Run: node scripts/fetch-player-stats.mjs" });
  }

  const events = await getSquiggleFixtures();
  if (events.length === 0) return NextResponse.json({ props: [] });

  // playerName+statType → { matchup, commenceTime, statType, statLabel, lines: line → bookie → odds }
  const playerLineMap = new Map<string, {
    matchup: string;
    commenceTime: string;
    statType: StatType;
    statLabel: string;
    lines: Map<number, Record<string, number>>;
  }>();

  // Build lookup from events: canonical matchup name → commenceTime
  // Also build a word-based lookup so Sportsbet names (e.g. "GWS GIANTS v Hawthorn") can resolve
  // to the canonical Odds API name (e.g. "Greater Western Sydney Giants v Hawthorn Hawks")
  const canonicalEvents: Array<{ canonical: string; commenceTime: string; words: [Set<string>, Set<string>] }> = [];
  const matchupTimeMap = new Map<string, string>();

  for (const event of events as Array<{ id: string; home_team: string; away_team: string; commence_time: string }>) {
    const canonical = `${event.home_team} v ${event.away_team}`;
    matchupTimeMap.set(canonical, event.commence_time);
    matchupTimeMap.set(`${event.away_team} v ${event.home_team}`, event.commence_time);
    const homeWords = new Set(event.home_team.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const awayWords = new Set(event.away_team.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    canonicalEvents.push({ canonical, commenceTime: event.commence_time, words: [homeWords, awayWords] });
  }

  function resolveCanonicalMatchup(sbMatchup: string): { canonical: string; commenceTime: string } {
    // Exact match first
    if (matchupTimeMap.has(sbMatchup)) return { canonical: sbMatchup, commenceTime: matchupTimeMap.get(sbMatchup)! };
    const parts = sbMatchup.toLowerCase().split(" v ");
    if (parts.length !== 2) return { canonical: sbMatchup, commenceTime: "" };
    const sbHomeWords = new Set(parts[0].split(/\s+/).filter(w => w.length > 2));
    const sbAwayWords = new Set(parts[1].split(/\s+/).filter(w => w.length > 2));
    for (const ev of canonicalEvents) {
      const homeMatch = [...sbHomeWords].some(w => ev.words[0].has(w)) || [...ev.words[0]].some(w => sbHomeWords.has(w));
      const awayMatch = [...sbAwayWords].some(w => ev.words[1].has(w)) || [...ev.words[1]].some(w => sbAwayWords.has(w));
      if (homeMatch && awayMatch) return { canonical: ev.canonical, commenceTime: ev.commenceTime };
    }
    return { canonical: sbMatchup, commenceTime: "" };
  }

  // Ingest scraped bookmaker prices (Sportsbet, Betr, ...) — resolve to canonical
  // Odds API matchup name so frontend exact-match works
  function ingestScrapedOdds(scraped: SportsbetOdds | null, bookieName: string) {
    if (!scraped) return;
    for (const match of scraped.matches) {
      const { canonical, commenceTime } = resolveCanonicalMatchup(match.matchup);

      for (const [playerName, statMap] of Object.entries(match.markets)) {
        for (const [statKey, thresholds] of Object.entries(statMap)) {
          const stat = statKey as StatType;
          const mapKey = `${playerName}::${stat}`;
          let entry = playerLineMap.get(mapKey);
          if (!entry) {
            entry = { matchup: canonical, commenceTime, statType: stat, statLabel: stat, lines: new Map() };
            playerLineMap.set(mapKey, entry);
          }
          for (const [threshStr, price] of Object.entries(thresholds)) {
            const threshold = parseInt(threshStr);
            if (isNaN(threshold) || price < 1.01) continue;
            const line = threshold - 0.5; // "18+" → line 17.5
            const lineBookies = entry.lines.get(line) ?? {};
            lineBookies[bookieName] = price;
            entry.lines.set(line, lineBookies);
          }
        }
      }
    }
  }

  ingestScrapedOdds(loadSportsbetOdds(), "Sportsbet");
  ingestScrapedOdds(loadBetrOdds(), "Betr");

  const props: PlayerProp[] = [];

  for (const [mapKey, entry] of playerLineMap.entries()) {
    const playerName = mapKey.split("::")[0];
    const storedPlayer = stored[playerName];
    if (!storedPlayer || storedPlayer.games.length < 10) continue;

    // Staleness gate: most recent game must be from 2025 or later
    const mostRecentYear = storedPlayer.games[storedPlayer.games.length - 1].year;
    if (mostRecentYear < 2025) continue;

    const currentYear = new Date().getFullYear();
    const statValues = storedPlayer.games.map((g) => {
      const v = (g as unknown as Record<string, unknown>)[entry.statType];
      return typeof v === "number" ? v : 0;
    });
    const n = statValues.length;

    // Relevant prior values: 3-season cap + injury gap detection
    const priorValues = relevantStatValues(storedPlayer.games as StoredGame[], entry.statType, currentYear);
    const priorN = priorValues.length || 1;

    // Build PricedLine array for all available lines
    const last10Values = statValues.slice(-10);
    const pricedLines: PricedLine[] = [];
    for (const [line, bookieOdds] of entry.lines.entries()) {
      const threshold = Math.ceil(line); // line 24.5 → threshold 25
      const hr = weightedHitRate(statValues, threshold);
      const hr10 = last10Values.length
        ? Math.round((last10Values.filter(v => v >= threshold).length / last10Values.length) * 1000) / 10
        : hr;
      // Bayesian blend: L10 (k=10) + smart prior (k=25, skeptic-shrunk toward 65%)
      // Prior uses only relevant games (3-season cap + injury gaps) + 10 pseudo-games at 65%
      // to stop small perfect samples (e.g. 13/13) from reading as genuinely 100% reliable.
      const rawPrior = weightedHitRate(priorValues, threshold);
      const shrunkPrior = Math.round((rawPrior * priorN + 65 * 10) / (priorN + 10) * 10) / 10;
      const bayesianRate = Math.round(((10 * hr10 + 25 * shrunkPrior) / 35) * 10) / 10;
      const lineEntries = Object.entries(bookieOdds).sort((a, b) => b[1] - a[1]);
      const [bestBookie, bestOdds] = lineEntries[0];
      const implied = Math.round((1 / bestOdds) * 1000) / 10;
      const edge = Math.round((hr - implied) * 10) / 10;
      const bayesianEdge = Math.round((bayesianRate - implied) * 10) / 10;
      // Calibration-shrunk rate (validated: model is ~6% overconfident, see SESSION_NOTES.md)
      // feeds Kelly so line selection optimizes the actual bet, not just the raw probability gap.
      const shrunkRate = (bayesianRate / 100) * 0.94;
      const kelly = bestOdds > 1 ? Math.round(((shrunkRate * bestOdds - 1) / (bestOdds - 1)) * 1000) / 1000 : -Infinity;
      pricedLines.push({
        line,
        bookmakerOdds: bookieOdds,
        bestOdds,
        bestBookie,
        hitRate: hr,
        hitRate10: hr10,
        bayesianRate,
        bookmakerImplied: implied,
        edge,
        bayesianEdge,
        kelly,
      });
    }

    if (pricedLines.length === 0) continue;

    // Compute season average here so we can filter lines before picking best
    const seasonAvgForFilter = Math.round((statValues.reduce((a, b) => a + b, 0) / n) * 100) / 100;

    // Only consider lines where player's season avg meets the threshold (avoids regression-bait streaks)
    // Then pick the line with the best Kelly fraction among those eligible lines — Kelly accounts for
    // the odds payout curve, so it can favor a safer/shorter line over a bigger raw-edge/longer line
    // (e.g. 90% at $1.23 can out-Kelly 79% at $1.56 even though the latter has the bigger edge).
    const eligibleLines = pricedLines.filter(pl => seasonAvgForFilter >= Math.ceil(pl.line));
    if (eligibleLines.length === 0) continue;
    eligibleLines.sort((a, b) => b.kelly - a.kelly);
    const best = eligibleLines[0];

    // Detect if best line differs from the main (non-alternate) line
    // Main line = the one closest to median of all lines
    const sortedLines = [...entry.lines.keys()].sort((a, b) => a - b);
    const medianLine = sortedLines[Math.floor(sortedLines.length / 2)];
    const isAlternateLine = Math.abs(best.line - medianLine) > 1;

    const seasonAvg = Math.round((statValues.reduce((a, b) => a + b, 0) / n) * 100) / 100;
    const recentForm = statValues.slice(-5);
    const threshold = Math.ceil(best.line);
    const last5 = statValues.slice(-5);
    const hitRate5 = last5.length ? Math.round((last5.filter(v => v >= threshold).length / last5.length) * 1000) / 10 : best.hitRate;
    const hitRate10 = best.hitRate10; // already computed per-line above
    const coldForm = best.hitRate - hitRate10 >= 25;
    const recentEdge = Math.round((hitRate10 - best.bookmakerImplied) * 10) / 10;
    const thresholds = buildThresholds(statValues);

    // seasonAvg >= threshold already enforced during line selection above

    props.push({
      playerName,
      matchup: entry.matchup,
      commenceTime: entry.commenceTime,
      statType: entry.statType,
      statLabel: entry.statLabel,
      marketLine: best.line,
      bestOdds: best.bestOdds,
      bestBookie: best.bestBookie,
      bookmakerOdds: best.bookmakerOdds,
      isAlternateLine,
      allPricedLines: pricedLines,
      gamesAnalysed: n,
      hitRate: best.hitRate,
      hitRate5,
      hitRate10,
      bayesianRate: best.bayesianRate,
      coldForm,
      bookmakerImplied: best.bookmakerImplied,
      edge: best.edge,
      recentEdge,
      bayesianEdge: best.bayesianEdge,
      kelly: best.kelly,
      seasonAvg,
      recentForm,
      thresholds,
    });
  }

  // Sort by Bayesian edge — the optimal line's blended reliability minus implied probability
  props.sort((a, b) => b.recentEdge - a.recentEdge);
  return NextResponse.json({ props });
}
