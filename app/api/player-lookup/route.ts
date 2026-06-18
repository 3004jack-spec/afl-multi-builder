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

function loadPlayerStats(): Record<string, { games: StoredGame[] }> {
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
  const query = (url.searchParams.get("q") ?? "").toLowerCase().trim();
  const playerParam = url.searchParams.get("player") ?? "";
  const statParam = (url.searchParams.get("stat") ?? "disposals") as StatType;
  const threshold = parseInt(url.searchParams.get("threshold") ?? "0", 10);

  const stored = loadPlayerStats();

  // Search mode — return matching player names
  if (query) {
    const matches = Object.keys(stored)
      .filter((name) => name.toLowerCase().includes(query))
      .slice(0, 10);
    return NextResponse.json({ players: matches });
  }

  // Lookup mode — return hit rates for player/stat/threshold
  if (playerParam && threshold > 0) {
    const storedPlayer = stored[playerParam];
    if (!storedPlayer) {
      return NextResponse.json({ found: false, player: playerParam });
    }

    const statValues = storedPlayer.games.map((g) => {
      const v = (g as unknown as Record<string, unknown>)[statParam];
      return typeof v === "number" ? v : 0;
    });

    // Staleness check
    const mostRecentYear = storedPlayer.games[storedPlayer.games.length - 1]?.year ?? 0;
    const stale = mostRecentYear < 2025;

    const last5 = statValues.slice(-5);
    const last10 = statValues.slice(-10);
    const hitRate5 = last5.length
      ? Math.round((last5.filter((v) => v >= threshold).length / last5.length) * 1000) / 10
      : 0;
    const hitRate10 = last10.length
      ? Math.round((last10.filter((v) => v >= threshold).length / last10.length) * 1000) / 10
      : 0;
    const allTime = statValues.length
      ? Math.round((statValues.filter((v) => v >= threshold).length / statValues.length) * 1000) / 10
      : 0;
    const recentForm = statValues.slice(-5);
    const seasonAvg = statValues.length
      ? Math.round((statValues.reduce((a, b) => a + b, 0) / statValues.length) * 100) / 100
      : 0;

    return NextResponse.json({
      found: true,
      player: playerParam,
      stat: statParam,
      threshold,
      hitRate5,
      hitRate10,
      allTime,
      recentForm,
      seasonAvg,
      gamesAnalysed: statValues.length,
      stale,
      mostRecentYear,
    });
  }

  return NextResponse.json({ error: "Provide q= for search or player= + stat= + threshold= for lookup" });
}
