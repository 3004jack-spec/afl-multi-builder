import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const FOOTYWIRE_SELECTIONS = "https://www.footywire.com/afl/footy/afl_team_selections";

export interface LineupData {
  named: string[];
  emergencies: string[];
  fetchedAt: string;
  gamesFound: number;
}

function slugToName(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function parseLineups(html: string): LineupData {
  // Find exact emergency section boundaries: <b>Emergencies</b> → <b>Ins</b> or <b>Outs</b>
  // The HTML structure is a two-column table (one per team), so there are multiple emergency sections.
  const emergencyRanges: Array<[number, number]> = [];
  const emgStartRegex = /<b>Emergenc[^<]*<\/b>/gi;
  const emgEndRegex = /<b>(?:Ins|Outs|Selected)<\/b>/gi;

  let emgMatch: RegExpExecArray | null;
  while ((emgMatch = emgStartRegex.exec(html)) !== null) {
    const start = emgMatch.index;
    // Find the nearest closing section after this point
    emgEndRegex.lastIndex = start;
    const endMatch = emgEndRegex.exec(html);
    const end = endMatch ? endMatch.index : start + 800;
    emergencyRanges.push([start, end]);
  }

  // Find Outs section boundaries — players listed here are NOT in the named squad
  const outsRanges: Array<[number, number]> = [];
  const outsStartRegex = /<b>Outs<\/b>/gi;
  const outsEndRegex = /<\/table>/gi;
  let outsMatch: RegExpExecArray | null;
  while ((outsMatch = outsStartRegex.exec(html)) !== null) {
    const start = outsMatch.index;
    outsEndRegex.lastIndex = start;
    const endMatch = outsEndRegex.exec(html);
    const end = endMatch ? endMatch.index : start + 800;
    outsRanges.push([start, end]);
  }

  const isInRange = (pos: number, ranges: Array<[number, number]>) =>
    ranges.some(([s, e]) => pos >= s && pos <= e);

  // Extract all player links with their position in the HTML
  const linkRegex = /href="pp-([a-z0-9-]+)--([a-z0-9-]+)"/gi;
  const named: string[] = [];
  const emergencies: string[] = [];
  const seenNamed = new Set<string>();
  const seenEmg = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const playerSlug = match[2];
    // Skip duplicate number suffixes like "matt-johnson-1" → still valid name
    const name = slugToName(playerSlug.replace(/-\d+$/, ""));
    const pos = match.index;

    if (isInRange(pos, outsRanges)) continue; // player was dropped, skip
    if (isInRange(pos, emergencyRanges)) {
      if (!seenEmg.has(name)) {
        seenEmg.add(name);
        emergencies.push(name);
      }
    } else {
      if (!seenNamed.has(name)) {
        seenNamed.add(name);
        named.push(name);
      }
    }
  }

  // Count game sections — footywire shows one game per page load but may have multiple
  const gamesFound = (html.match(/<b>Emergenc/gi) ?? []).length / 2; // 2 emergency sections per game (one per team)

  return {
    named,
    emergencies,
    fetchedAt: new Date().toISOString(),
    gamesFound: Math.round(gamesFound),
  };
}

export async function GET(request: Request) {
  const debug = new URL(request.url).searchParams.has("debug");

  // Manual override takes priority — used when confirmed lineups are known before footywire updates
  const overridePath = join(process.cwd(), "data", "lineups-override.json");
  if (!debug && existsSync(overridePath)) {
    try {
      const data = JSON.parse(readFileSync(overridePath, "utf8"));
      return NextResponse.json(data);
    } catch { /* fall through to scrape */ }
  }

  try {
    const res = await fetch(FOOTYWIRE_SELECTIONS, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; afl-multi-builder/1.0)" },
      next: { revalidate: 900 }, // 15 min cache — squads rarely change once announced
    });

    if (!res.ok) {
      return NextResponse.json({ named: [], emergencies: [], fetchedAt: new Date().toISOString(), gamesFound: 0, error: `HTTP ${res.status}` });
    }

    const html = await res.text();

    if (debug) {
      const emgIdx = html.toLowerCase().indexOf("emergenc");
      return NextResponse.json({
        htmlLength: html.length,
        snippet: html.slice(Math.max(0, emgIdx - 100), emgIdx + 600),
        allPlayerLinks: (html.match(/href="pp-[^"]+"/g) ?? []).slice(0, 40),
      });
    }

    const data = parseLineups(html);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ named: [], emergencies: [], fetchedAt: new Date().toISOString(), gamesFound: 0, error: String(e) });
  }
}
