import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ODDS_API_KEY = "0f0d4c20983592fffeaa6e1b11206ebd";
const ODDS_BASE = "https://api.the-odds-api.com/v4";

// AFL markets available on The Odds API (tested 2026-06-17)
// player_goals, player_marks, player_kicks, player_tackles all return INVALID_MARKET
const MARKETS = [
  { key: "player_disposals", stat: "disposals", label: "disposals" },
] as const;

type StatType = "disposals" | "goals" | "marks" | "kicks" | "tackles";

interface ThresholdPoint {
  threshold: number;
  line: number;
  hitRate: number;
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

function buildThresholds(values: number[]): ThresholdPoint[] {
  const n = values.length;
  if (n === 0) return [];
  const min = Math.max(0, Math.min(...values));
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
    return NextResponse.json({ props: [], message: "No player stats. Run: node scripts/fetch-player-stats.mjs" });
  }

  // Fetch all AFL events
  const eventsRes = await fetch(
    `${ODDS_BASE}/sports/aussierules_afl/events/?apiKey=${ODDS_API_KEY}`,
    { next: { revalidate: 3600 } }
  );
  const events = await eventsRes.json();
  if (!Array.isArray(events)) return NextResponse.json({ props: [] });

  // Build live market lines map: "marketKey:playerName" → all bookmaker odds
  const liveLines = new Map<string, {
    line: number;
    bestOdds: number;
    bestBookie: string;
    bookmakerOdds: Record<string, number>;
    matchup: string;
    statType: StatType;
    statLabel: string;
  }>();

  await Promise.all(
    events.map(async (event: { id: string; home_team: string; away_team: string }) => {
      try {
        const marketKeys = MARKETS.map((m) => m.key).join(",");
        const res = await fetch(
          `${ODDS_BASE}/sports/aussierules_afl/events/${event.id}/odds/?apiKey=${ODDS_API_KEY}&regions=au&markets=${marketKeys}&oddsFormat=decimal`,
          { next: { revalidate: 3600 } }
        );
        const data = await res.json();
        const matchup = `${event.home_team} v ${event.away_team}`;

        for (const bm of data.bookmakers ?? []) {
          for (const market of bm.markets ?? []) {
            const marketDef = MARKETS.find((m) => m.key === market.key);
            if (!marketDef) continue;

            for (const outcome of market.outcomes ?? []) {
              if (outcome.name !== "Over") continue;
              const name: string = outcome.description;
              const mapKey = `${market.key}:${name}`;
              const existing = liveLines.get(mapKey);
              if (!existing) {
                liveLines.set(mapKey, {
                  line: outcome.point,
                  bestOdds: outcome.price,
                  bestBookie: bm.title,
                  bookmakerOdds: { [bm.title]: outcome.price },
                  matchup,
                  statType: marketDef.stat,
                  statLabel: marketDef.label,
                });
              } else {
                existing.bookmakerOdds[bm.title] = outcome.price;
                if (outcome.price > existing.bestOdds) {
                  existing.bestOdds = outcome.price;
                  existing.bestBookie = bm.title;
                }
              }
            }
          }
        }
      } catch { /* skip */ }
    })
  );

  const props: PlayerProp[] = [];

  for (const [mapKey, market] of liveLines.entries()) {
    const playerName = mapKey.split(":").slice(1).join(":");
    const storedPlayer = stored[playerName];
    if (!storedPlayer || storedPlayer.games.length < 10) continue;

    const statValues = storedPlayer.games.map((g) => {
      const v = (g as unknown as Record<string, unknown>)[market.statType];
      return typeof v === "number" ? v : 0;
    });

    const n = statValues.length;
    const hitCount = statValues.filter((v) => v > market.line).length;
    const hitRate = Math.round((hitCount / n) * 1000) / 10;
    const bookmakerImplied = Math.round((1 / market.bestOdds) * 1000) / 10;
    const edge = Math.round((hitRate - bookmakerImplied) * 10) / 10;

    if (edge < 3) continue;

    const seasonAvg = Math.round((statValues.reduce((a, b) => a + b, 0) / n) * 100) / 100;
    const recentForm = statValues.slice(-5);
    const thresholds = buildThresholds(statValues);

    props.push({
      playerName,
      matchup: market.matchup,
      statType: market.statType,
      statLabel: market.statLabel,
      marketLine: market.line,
      bestOdds: market.bestOdds,
      bestBookie: market.bestBookie,
      bookmakerOdds: market.bookmakerOdds,
      gamesAnalysed: n,
      hitRate,
      bookmakerImplied,
      edge,
      seasonAvg,
      recentForm,
      thresholds,
    });
  }

  props.sort((a, b) => b.edge - a.edge);
  return NextResponse.json({ props });
}
