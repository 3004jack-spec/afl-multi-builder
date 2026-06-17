import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ODDS_API_KEY = "0f0d4c20983592fffeaa6e1b11206ebd";
const ODDS_BASE = "https://api.the-odds-api.com/v4";

interface ThresholdPoint {
  threshold: number; // e.g. 22 means "22+ disposals" (>=22)
  line: number;      // bookmaker notation: 21.5
  hitRate: number;
}

interface PlayerProp {
  playerName: string;
  matchup: string;
  // Main market (from Odds API)
  marketLine: number;
  bestOdds: number;
  bestBookie: string;
  gamesAnalysed: number;
  hitRate: number;
  bookmakerImplied: number;
  edge: number;
  seasonAvg: number;
  recentForm: number[];
  // Multi-threshold analysis
  thresholds: ThresholdPoint[];
  optimalThreshold: number;
  optimalHitRate: number;
  optimalEdge: number;
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
 * Build hit-rate curve across all integer thresholds.
 * We only have real prices at the main market line, so we don't estimate
 * edge at alternate lines — we just show the hit rates for the user to
 * compare manually against Sportsbet alternate line prices.
 */
function buildThresholds(
  values: number[],
  marketLineFractional: number
): ThresholdPoint[] {
  const n = values.length;
  if (n === 0) return [];

  const min = Math.max(1, Math.min(...values));
  const max = Math.max(...values);
  const thresholds: ThresholdPoint[] = [];

  for (let t = min; t <= max + 1; t++) {
    const hits = values.filter((v) => v >= t).length;
    thresholds.push({
      threshold: t,
      line: t - 0.5,
      hitRate: Math.round((hits / n) * 1000) / 10,
    });
  }

  return thresholds;
}

export async function GET() {
  const stored = loadPlayerStats();

  if (Object.keys(stored).length === 0) {
    return NextResponse.json({
      props: [],
      message: "No player stats data yet. Run: node scripts/fetch-player-stats.mjs",
    });
  }

  const eventsRes = await fetch(
    `${ODDS_BASE}/sports/aussierules_afl/events/?apiKey=${ODDS_API_KEY}`,
    { next: { revalidate: 3600 } }
  );
  const events = await eventsRes.json();
  if (!Array.isArray(events)) return NextResponse.json({ props: [] });

  const liveLines = new Map<string, {
    line: number;
    bestOdds: number;
    bestBookie: string;
    matchup: string;
  }>();

  await Promise.all(
    events.map(async (event: { id: string; home_team: string; away_team: string }) => {
      try {
        const res = await fetch(
          `${ODDS_BASE}/sports/aussierules_afl/events/${event.id}/odds/?apiKey=${ODDS_API_KEY}&regions=au&markets=player_disposals&oddsFormat=decimal`,
          { next: { revalidate: 3600 } }
        );
        const data = await res.json();
        const matchup = `${event.home_team} v ${event.away_team}`;

        for (const bm of data.bookmakers ?? []) {
          for (const market of bm.markets ?? []) {
            if (market.key !== "player_disposals") continue;
            for (const outcome of market.outcomes ?? []) {
              if (outcome.name !== "Over") continue;
              const name: string = outcome.description;
              const existing = liveLines.get(name);
              if (!existing || outcome.price > existing.bestOdds) {
                liveLines.set(name, {
                  line: outcome.point,
                  bestOdds: outcome.price,
                  bestBookie: bm.title,
                  matchup,
                });
              }
            }
          }
        }
      } catch { /* skip */ }
    })
  );

  const props: PlayerProp[] = [];

  for (const [playerName, market] of liveLines.entries()) {
    const storedPlayer = stored[playerName];
    if (!storedPlayer || storedPlayer.games.length < 10) continue;

    const disposals = storedPlayer.games.map((g) => g.disposals);

    // Main market stats
    const hitCount = disposals.filter((d) => d > market.line).length;
    const hitRate = Math.round((hitCount / disposals.length) * 1000) / 10;
    const bookmakerImplied = Math.round((1 / market.bestOdds) * 1000) / 10;
    const edge = Math.round((hitRate - bookmakerImplied) * 10) / 10;
    const seasonAvg = Math.round((disposals.reduce((a, b) => a + b, 0) / disposals.length) * 10) / 10;
    const recentForm = disposals.slice(-5);

    const thresholds = buildThresholds(disposals, market.line);

    props.push({
      playerName,
      matchup: market.matchup,
      marketLine: market.line,
      bestOdds: market.bestOdds,
      bestBookie: market.bestBookie,
      gamesAnalysed: disposals.length,
      hitRate,
      bookmakerImplied,
      edge,
      seasonAvg,
      recentForm,
      thresholds,
      optimalThreshold: Math.ceil(market.line),
      optimalHitRate: hitRate,
      optimalEdge: edge,
    });
  }

  props.sort((a, b) => b.edge - a.edge);

  return NextResponse.json({ props });
}
