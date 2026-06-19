import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ODDS_API_KEY = "0f0d4c20983592fffeaa6e1b11206ebd";
const ODDS_BASE = "https://api.the-odds-api.com/v4";

type StatType = "disposals" | "goals" | "marks" | "kicks" | "handballs" | "tackles" | "clearances";

interface StatDef { stat: StatType; label: string; }

// Each entry fetched as a separate API call per event so one invalid market can't block others.
// player_disposals_alternate fetched separately — only available closer to game day.
const MARKET_STAT: Record<string, StatDef> = {
  player_disposals:           { stat: "disposals",   label: "disposals" },
  player_disposals_alternate: { stat: "disposals",   label: "disposals" },
  player_kicks_over:          { stat: "kicks",       label: "kicks" },
  player_marks_over:          { stat: "marks",       label: "marks" },
  player_handballs_over:      { stat: "handballs",   label: "handballs" },
  player_tackles_over:        { stat: "tackles",     label: "tackles" },
  player_clearances_over:     { stat: "clearances",  label: "clearances" },
  player_goals_scored_over:   { stat: "goals",       label: "goals" },
};

// Markets fetched per event. Alternate disposals fetched separately — fails silently when not priced.
const PRIMARY_MARKETS = [
  "player_disposals",
  "player_kicks_over",
  "player_marks_over",
  "player_handballs_over",
  "player_tackles_over",
  "player_clearances_over",
  "player_goals_scored_over",
];

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
  bayesianEdge: number;  // bayesianRate − implied — used to pick the optimal line
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
  coldForm: boolean;     // true when last-10 hit rate is 25+ points below all-time
  bookmakerImplied: number;
  edge: number;          // all-time weighted edge (used by Auto Multi)
  recentEdge: number;    // L10 hit rate minus bookmaker implied — primary display metric
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

  const eventsRes = await fetch(
    `${ODDS_BASE}/sports/aussierules_afl/events/?apiKey=${ODDS_API_KEY}`,
    { next: { revalidate: 300 } }
  );
  const events = await eventsRes.json();
  if (!Array.isArray(events)) return NextResponse.json({ props: [] });

  // playerName+statType → { matchup, commenceTime, statType, statLabel, lines: line → bookie → odds }
  const playerLineMap = new Map<string, {
    matchup: string;
    commenceTime: string;
    statType: StatType;
    statLabel: string;
    lines: Map<number, Record<string, number>>;
  }>();

  function ingestBookmakers(
    bookmakers: Array<{ title: string; markets: Array<{ key: string; outcomes: Array<{ name: string; description: string; point: number; price: number }> }> }>,
    matchup: string,
    commenceTime: string
  ) {
    for (const bm of bookmakers) {
      for (const market of bm.markets ?? []) {
        const statDef = MARKET_STAT[market.key];
        if (!statDef) continue;
        for (const outcome of market.outcomes ?? []) {
          if (outcome.name !== "Over") continue;
          const playerName: string = outcome.description;
          const line: number = outcome.point;
          const price: number = outcome.price;
          // Key by player+stat so same player can have entries for disposals AND kicks etc.
          const mapKey = `${playerName}::${statDef.stat}`;
          let entry = playerLineMap.get(mapKey);
          if (!entry) {
            entry = { matchup, commenceTime, statType: statDef.stat, statLabel: statDef.label, lines: new Map() };
            playerLineMap.set(mapKey, entry);
          }
          const lineBookies = entry.lines.get(line) ?? {};
          if (!lineBookies[bm.title] || price > lineBookies[bm.title]) {
            lineBookies[bm.title] = price;
          }
          entry.lines.set(line, lineBookies);
        }
      }
    }
  }

  await Promise.all(
    events.map(async (event: { id: string; home_team: string; away_team: string; commence_time: string }) => {
      const matchup = `${event.home_team} v ${event.away_team}`;
      const commenceTime = event.commence_time;
      const baseUrl = `${ODDS_BASE}/sports/aussierules_afl/events/${event.id}/odds/?apiKey=${ODDS_API_KEY}&regions=au&oddsFormat=decimal`;

      // Fetch all primary markets in one call — all are valid so safe to combine
      try {
        const res = await fetch(`${baseUrl}&markets=${PRIMARY_MARKETS.join(",")}`, { next: { revalidate: 300 } });
        const data = await res.json();
        if (data.bookmakers) ingestBookmakers(data.bookmakers, matchup, commenceTime);
      } catch { /* skip */ }

      // Alternate disposal lines — only available closer to game day, fail silently if not priced
      try {
        const res = await fetch(`${baseUrl}&markets=player_disposals_alternate`, { next: { revalidate: 300 } });
        const data = await res.json();
        if (data.bookmakers) ingestBookmakers(data.bookmakers, matchup, commenceTime);
      } catch { /* skip */ }
    })
  );

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
      });
    }

    if (pricedLines.length === 0) continue;

    // Pick the line with the best Bayesian edge — balances L10 reliability with all-time hit rate
    // Pure edge alone would favour high-line/high-odds bets that are less reliable in a multi context
    pricedLines.sort((a, b) => b.bayesianEdge - a.bayesianEdge);
    const best = pricedLines[0];

    if (best.bayesianEdge <= 0) continue; // Bayesian edge must be positive — raw edge alone isn't enough

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

    // Require positive recent edge — all-time edge alone isn't enough
    if (recentEdge <= 0) continue;

    // Require season average >= threshold — filters out players hitting the line on a streak
    // but whose underlying average sits below it (regression bait, not genuine edge)
    if (seasonAvg < threshold) continue;

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
      coldForm,
      bookmakerImplied: best.bookmakerImplied,
      edge: best.edge,
      recentEdge,
      seasonAvg,
      recentForm,
      thresholds,
    });
  }

  // Sort by Bayesian edge — the optimal line's blended reliability minus implied probability
  props.sort((a, b) => b.recentEdge - a.recentEdge);
  return NextResponse.json({ props });
}
