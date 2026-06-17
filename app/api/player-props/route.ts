import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ODDS_API_KEY = "0f0d4c20983592fffeaa6e1b11206ebd";
const ODDS_BASE = "https://api.the-odds-api.com/v4";

// Both markets in one request — Odds API charges per event call, not per market.
// player_disposals_alternate returns multiple priced lines per player (20.5, 22.5, 24.5…)
// Odds API silently omits markets it doesn't support, so this is safe.
const MARKETS_PARAM = "player_disposals,player_disposals_alternate";

// Map market keys → stat metadata
const MARKET_STAT: Record<string, { stat: "disposals"; label: "disposals" }> = {
  player_disposals: { stat: "disposals", label: "disposals" },
  player_disposals_alternate: { stat: "disposals", label: "disposals" },
};

type StatType = "disposals" | "goals" | "marks" | "kicks" | "tackles";

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
  hitRate: number;       // recency-weighted hit rate at this line
  bookmakerImplied: number;
  edge: number;
}

interface PlayerProp {
  playerName: string;
  matchup: string;
  statType: StatType;
  statLabel: string;
  marketLine: number;
  bestOdds: number;
  bestBookie: string;
  bookmakerOdds: Record<string, number>;
  isAlternateLine: boolean;
  allPricedLines: PricedLine[];
  gamesAnalysed: number;
  hitRate: number;
  bookmakerImplied: number;
  edge: number;
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
    { next: { revalidate: 3600 } }
  );
  const events = await eventsRes.json();
  if (!Array.isArray(events)) return NextResponse.json({ props: [] });

  // Per-player, per-line: accumulate bookmaker odds across all events/bookmakers
  // Structure: playerName → line → { bookmakerOdds, matchup, statType, statLabel }
  const playerLineMap = new Map<string, {
    matchup: string;
    statType: "disposals";
    statLabel: "disposals";
    lines: Map<number, Record<string, number>>; // line → bookie → odds
  }>();

  await Promise.all(
    events.map(async (event: { id: string; home_team: string; away_team: string }) => {
      try {
        const res = await fetch(
          `${ODDS_BASE}/sports/aussierules_afl/events/${event.id}/odds/?apiKey=${ODDS_API_KEY}&regions=au&markets=${MARKETS_PARAM}&oddsFormat=decimal`,
          { next: { revalidate: 3600 } }
        );
        const data = await res.json();
        if (!data.bookmakers) return;
        const matchup = `${event.home_team} v ${event.away_team}`;

        for (const bm of data.bookmakers) {
          for (const market of bm.markets ?? []) {
            const statDef = MARKET_STAT[market.key];
            if (!statDef) continue;

            for (const outcome of market.outcomes ?? []) {
              if (outcome.name !== "Over") continue;
              const playerName: string = outcome.description;
              const line: number = outcome.point;
              const price: number = outcome.price;

              let entry = playerLineMap.get(playerName);
              if (!entry) {
                entry = { matchup, statType: statDef.stat, statLabel: statDef.label, lines: new Map() };
                playerLineMap.set(playerName, entry);
              }

              const lineBookies = entry.lines.get(line) ?? {};
              // Keep best odds per bookie per line
              if (!lineBookies[bm.title] || price > lineBookies[bm.title]) {
                lineBookies[bm.title] = price;
              }
              entry.lines.set(line, lineBookies);
            }
          }
        }
      } catch { /* skip */ }
    })
  );

  const props: PlayerProp[] = [];

  for (const [playerName, entry] of playerLineMap.entries()) {
    const storedPlayer = stored[playerName];
    if (!storedPlayer || storedPlayer.games.length < 10) continue;

    const statValues = storedPlayer.games.map((g) => {
      const v = (g as unknown as Record<string, unknown>)[entry.statType];
      return typeof v === "number" ? v : 0;
    });
    const n = statValues.length;

    // Build PricedLine array for all available lines
    const pricedLines: PricedLine[] = [];
    for (const [line, bookieOdds] of entry.lines.entries()) {
      const threshold = Math.ceil(line); // line 24.5 → threshold 25
      const hr = weightedHitRate(statValues, threshold);
      const entries = Object.entries(bookieOdds).sort((a, b) => b[1] - a[1]);
      const [bestBookie, bestOdds] = entries[0];
      const implied = Math.round((1 / bestOdds) * 1000) / 10;
      const edge = Math.round((hr - implied) * 10) / 10;
      pricedLines.push({
        line,
        bookmakerOdds: bookieOdds,
        bestOdds,
        bestBookie,
        hitRate: hr,
        bookmakerImplied: implied,
        edge,
      });
    }

    if (pricedLines.length === 0) continue;

    // Pick the line with the best edge (this is the "pick your own line" feature)
    pricedLines.sort((a, b) => b.edge - a.edge);
    const best = pricedLines[0];

    if (best.edge < 3) continue;

    // Detect if best line differs from the main (non-alternate) line
    // Main line = the one closest to median of all lines
    const sortedLines = [...entry.lines.keys()].sort((a, b) => a - b);
    const medianLine = sortedLines[Math.floor(sortedLines.length / 2)];
    const isAlternateLine = Math.abs(best.line - medianLine) > 1;

    const seasonAvg = Math.round((statValues.reduce((a, b) => a + b, 0) / n) * 100) / 100;
    const recentForm = statValues.slice(-5);
    const thresholds = buildThresholds(statValues);

    props.push({
      playerName,
      matchup: entry.matchup,
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
      bookmakerImplied: best.bookmakerImplied,
      edge: best.edge,
      seasonAvg,
      recentForm,
      thresholds,
    });
  }

  props.sort((a, b) => b.edge - a.edge);
  return NextResponse.json({ props });
}
