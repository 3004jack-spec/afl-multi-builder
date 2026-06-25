import { NextResponse } from "next/server";

const SQUIGGLE = "https://api.squiggle.com.au";
const SQUIGGLE_SOURCE = 8;

const SPORTS = [
  { key: "aussierules_afl", label: "AFL" },
];

interface SquiggleFixture { id: string; home_team: string; away_team: string; commence_time: string; }

// Fixture source: Squiggle (free, no quota) — the Odds API events endpoint was stuck
// returning a stale/wrong round (see SESSION_NOTES.md, 2026-06-25).
async function getSquiggleFixtures(): Promise<SquiggleFixture[]> {
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

// Bookmakers to display (Aussie-relevant)
const BOOKIE_NAMES: Record<string, string> = {
  sportsbet: "Sportsbet",
  unibet: "Unibet",
  tab: "TAB",
  neds: "Neds",
  ladbrokes: "Ladbrokes",
  pointsbet: "PointsBet",
  betfair: "Betfair",
  betr: "Betr",
  playup: "PlayUp",
  betright: "Bet Right",
  tabtouch: "TABtouch",
};

interface OddsGame {
  id: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  bookmakers: { key: string; name: string; homeOdds: number; awayOdds: number }[];
  bestHome: { bookie: string; odds: number };
  bestAway: { bookie: string; odds: number };
  favourite: string;
  favouriteOdds: number;
  favouriteBookie: string;
  impliedWinPct: number;
  squiggleConfidence?: number;
  squiggleTip?: string;
  confidenceSource: "squiggle" | "odds";
}

async function getSquiggleTips(): Promise<Map<string, { confidence: number; tip: string }>> {
  const year = new Date().getFullYear();
  const map = new Map<string, { confidence: number; tip: string }>();
  try {
    const res = await fetch(
      `${SQUIGGLE}/?q=tips&year=${year}&source=${SQUIGGLE_SOURCE}`,
      { headers: { "User-Agent": "afl-multi-builder/1.0" }, next: { revalidate: 3600 } }
    );
    const data = await res.json();
    for (const tip of data.tips ?? []) {
      if (tip.correct === null || tip.correct === undefined) {
        // key by both team names normalised
        const key = [tip.hteam, tip.ateam].sort().join("|").toLowerCase();
        map.set(key, { confidence: tip.confidence, tip: tip.tip });
      }
    }
  } catch { /* ignore */ }
  return map;
}

// Squiggle uses short names ("Fremantle"), Odds API uses full names ("Fremantle Dockers")
// Check if either name contains the other
function aflNamesMatch(squiggleName: string, oddsName: string): boolean {
  const s = squiggleName.toLowerCase().trim();
  const o = oddsName.toLowerCase().trim();
  return o.includes(s) || s.includes(o);
}

export async function GET() {
  const squiggleTips = await getSquiggleTips();

  const allGames: OddsGame[] = [];

  for (const sport of SPORTS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const games: Array<{ id: string; home_team: string; away_team: string; commence_time: string; bookmakers?: any[] }> =
        (await getSquiggleFixtures()).map((e) => ({ ...e, bookmakers: [] }));
      if (games.length === 0) continue;

      for (const game of games) {
        const homeTeam: string = game.home_team;
        const awayTeam: string = game.away_team;

        const bookmakers: OddsGame["bookmakers"] = [];

        for (const bm of game.bookmakers ?? []) {
          const h2h = bm.markets?.find((m: { key: string }) => m.key === "h2h");
          if (!h2h) continue;
          const homeOut = h2h.outcomes?.find((o: { name: string }) => o.name === homeTeam);
          const awayOut = h2h.outcomes?.find((o: { name: string }) => o.name === awayTeam);
          if (!homeOut || !awayOut) continue;
          bookmakers.push({
            key: bm.key,
            name: BOOKIE_NAMES[bm.key] ?? bm.title,
            homeOdds: Math.round(homeOut.price * 100) / 100,
            awayOdds: Math.round(awayOut.price * 100) / 100,
          });
        }

        // No bookmakers in fallback mode — still include the game for scheduling purposes
        if (bookmakers.length === 0) {
          allGames.push({
            id: game.id, sport: sport.label, homeTeam, awayTeam,
            commenceTime: game.commence_time, bookmakers: [],
            bestHome: { bookie: "", odds: 0 }, bestAway: { bookie: "", odds: 0 },
            favourite: "", favouriteOdds: 0, favouriteBookie: "", impliedWinPct: 0,
            squiggleConfidence: undefined, squiggleTip: undefined, confidenceSource: "odds",
          });
          continue;
        }

        const bestHome = bookmakers.reduce((best, b) =>
          b.homeOdds > best.homeOdds ? b : best
        );
        const bestAway = bookmakers.reduce((best, b) =>
          b.awayOdds > best.awayOdds ? b : best
        );

        const favourite =
          bestHome.homeOdds <= bestAway.awayOdds ? homeTeam : awayTeam;
        const favouriteOdds =
          favourite === homeTeam ? bestHome.homeOdds : bestAway.awayOdds;
        const favouriteBookie =
          favourite === homeTeam ? bestHome.name : bestAway.name;
        const impliedWinPct = Math.round((1 / favouriteOdds) * 1000) / 10;

        // Match Squiggle tip to this game by checking if both team names match
        let squiggleData: { confidence: number; tip: string } | undefined;
        if (sport.label === "AFL") {
          for (const [k, v] of squiggleTips) {
            const [sHome, sAway] = k.split("|");
            const homeMatch = aflNamesMatch(sHome, homeTeam) || aflNamesMatch(sAway, homeTeam);
            const awayMatch = aflNamesMatch(sHome, awayTeam) || aflNamesMatch(sAway, awayTeam);
            if (homeMatch && awayMatch) {
              squiggleData = v;
              break;
            }
          }
        }

        allGames.push({
          id: game.id,
          sport: sport.label,
          homeTeam,
          awayTeam,
          commenceTime: game.commence_time,
          bookmakers,
          bestHome: { bookie: bestHome.name, odds: bestHome.homeOdds },
          bestAway: { bookie: bestAway.name, odds: bestAway.awayOdds },
          favourite,
          favouriteOdds,
          favouriteBookie,
          impliedWinPct,
          squiggleConfidence: squiggleData?.confidence,
          squiggleTip: squiggleData?.tip,
          confidenceSource: squiggleData ? "squiggle" : "odds",
        });
      }
    } catch { /* skip failed sport */ }
  }

  // Sort: Squiggle-backed first, then by confidence desc
  allGames.sort((a, b) => {
    const aConf = a.squiggleConfidence ?? a.impliedWinPct;
    const bConf = b.squiggleConfidence ?? b.impliedWinPct;
    return bConf - aConf;
  });

  return NextResponse.json({ games: allGames });
}
