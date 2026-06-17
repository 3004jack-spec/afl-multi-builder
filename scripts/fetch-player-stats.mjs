/**
 * Weekly script: fetches player stats from AFL Tables
 * Captures: kicks, marks, handballs, disposals, goals, tackles, clearances
 *
 * Run: node scripts/fetch-player-stats.mjs
 * Output: data/player-stats.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, "..", "data", "player-stats.json");

const ODDS_API_KEY = "0f0d4c20983592fffeaa6e1b11206ebd";
const ODDS_BASE = "https://api.the-odds-api.com/v4";
const AFL_TABLES = "https://afltables.com/afl/stats/players";
const SEASONS = [2023, 2024, 2025, 2026];
const DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toAFLTablesPath(name) {
  const parts = name.trim().split(/\s+/);
  const letter = parts[0][0].toUpperCase();
  return `${letter}/${parts.join("_")}`;
}

/**
 * Extract table HTML following an anchor, handling nested tables.
 */
function extractTable(html, anchorIdx) {
  const tableStart = html.indexOf("<table", anchorIdx);
  if (tableStart === -1) return null;
  let depth = 0, pos = tableStart, tableEnd = -1;
  while (pos < html.length) {
    const open = html.indexOf("<table", pos);
    const close = html.indexOf("</table>", pos);
    if (close === -1) break;
    if (open !== -1 && open < close) { depth++; pos = open + 6; }
    else { depth--; if (depth === 0) { tableEnd = close + 8; break; } pos = close + 8; }
  }
  return tableEnd === -1 ? null : html.slice(tableStart, tableEnd);
}

/**
 * Parse all stat columns from AFL Tables player page.
 * Game-by-game table columns (0-indexed after Gm, Opponent, Rd, R, #):
 *   5=KI 6=MK 7=HB 8=DI 9=GL 10=BH 11=HO 12=TK 13=RB 14=IF 15=CL
 */
function parsePlayerGames(html, seasons) {
  const games = [];

  for (const year of seasons) {
    const anchorIdx = html.indexOf(`name="${year}0"`);
    if (anchorIdx === -1) continue;

    const tableHtml = extractTable(html, anchorIdx);
    if (!tableHtml) continue;

    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const cells = [];
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let t;
      while ((t = tdRegex.exec(rowMatch[1])) !== null) {
        cells.push(t[1].replace(/<[^>]+>/g, "").trim());
      }

      if (cells.length < 13) continue;
      const round = cells[2];
      if (!round || !/^(\d+|EF|QF|SF|PF|GF)$/i.test(round)) continue;

      const safeInt = (idx) => {
        const v = parseInt(cells[idx]);
        return isNaN(v) ? 0 : v;
      };

      const disposals = safeInt(8);
      if (disposals < 0 || disposals > 60) continue; // sanity check

      const game = {
        year,
        round,
        kicks: safeInt(5),
        marks: safeInt(6),
        handballs: safeInt(7),
        disposals,
        goals: safeInt(9),
        tackles: safeInt(12),
      };

      // Clearances at index 15 (only if enough cells)
      if (cells.length >= 16) {
        game.clearances = safeInt(15);
      }

      games.push(game);
    }
  }

  return games;
}

async function fetchPlayerGames(playerName) {
  const p = toAFLTablesPath(playerName);
  const url = `${AFL_TABLES}/${p}.html`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });

    if (res.status === 404) {
      const url0 = `${AFL_TABLES}/${p}0.html`;
      const res0 = await fetch(url0, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      if (!res0.ok) return null;
      return parsePlayerGames(await res0.text(), SEASONS);
    }

    if (!res.ok) return null;
    return parsePlayerGames(await res.text(), SEASONS);
  } catch (e) {
    console.error(`  Error fetching ${playerName}: ${e.message}`);
    return null;
  }
}

async function getPlayersFromOddsAPI() {
  console.log("Fetching AFL events from Odds API...");
  const eventsRes = await fetch(
    `${ODDS_BASE}/sports/aussierules_afl/events/?apiKey=${ODDS_API_KEY}`
  );
  const events = await eventsRes.json();
  if (!Array.isArray(events)) {
    console.error("Failed to fetch events:", events);
    return [];
  }
  console.log(`  Found ${events.length} events`);

  const players = new Map();

  for (const event of events) {
    const matchup = `${event.home_team} v ${event.away_team}`;
    console.log(`  Fetching disposal odds for: ${matchup}`);

    try {
      const res = await fetch(
        `${ODDS_BASE}/sports/aussierules_afl/events/${event.id}/odds/?apiKey=${ODDS_API_KEY}&regions=au&markets=player_disposals&oddsFormat=decimal`
      );
      const data = await res.json();

      for (const bm of data.bookmakers ?? []) {
        for (const market of bm.markets ?? []) {
          if (market.key !== "player_disposals") continue;
          for (const outcome of market.outcomes ?? []) {
            if (outcome.name !== "Over") continue;
            const name = outcome.description;
            const existing = players.get(name);
            if (!existing || outcome.price > existing.bestOdds) {
              players.set(name, {
                line: outcome.point,
                bestOdds: outcome.price,
                bestBookie: bm.title,
                matchup,
              });
            }
          }
        }
      }
    } catch (e) {
      console.error(`  Error fetching odds for ${matchup}: ${e.message}`);
    }

    await sleep(500);
  }

  return Array.from(players.entries()).map(([name, data]) => ({ name, ...data }));
}

async function main() {
  console.log("=== AFL Player Stats Fetcher (all stat categories) ===\n");

  let existing = {};
  if (fs.existsSync(OUTPUT)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
    console.log(`Loaded ${Object.keys(existing).length} existing player records\n`);
  }

  const players = await getPlayersFromOddsAPI();
  console.log(`\nFound ${players.length} players with disposal markets\n`);

  if (players.length === 0) {
    console.log("No players found. Check Odds API key or try again closer to game day.");
    return;
  }

  const output = { ...existing };
  let fetched = 0, skipped = 0, failed = 0;

  for (const player of players) {
    const cached = existing[player.name];
    if (cached && cached.fetchedAt) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      // Skip if data has all-stats format and is fresh (< 6 days)
      const hasAllStats = cached.games?.[0]?.kicks !== undefined;
      if (hasAllStats && age < 6 * 24 * 60 * 60 * 1000) {
        console.log(`  Skipping ${player.name} (cached ${Math.round(age / 3600000)}h ago)`);
        skipped++;
        continue;
      }
    }

    console.log(`  Fetching ${player.name}...`);
    const games = await fetchPlayerGames(player.name);

    if (!games || games.length === 0) {
      console.log(`    ✗ No data found`);
      failed++;
    } else {
      const avg = games.reduce((a, b) => a + b.disposals, 0) / games.length;
      const goalAvg = games.reduce((a, b) => a + b.goals, 0) / games.length;
      console.log(`    ✓ ${games.length} games, ${avg.toFixed(1)} disp avg, ${goalAvg.toFixed(2)} goal avg`);

      output[player.name] = {
        games,
        fetchedAt: new Date().toISOString(),
        marketLine: player.line,
        matchup: player.matchup,
      };
      fetched++;
    }

    await sleep(DELAY_MS);
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`\n✅ Done. Fetched ${fetched} new, skipped ${skipped} cached, failed ${failed}.`);
  console.log(`   Saved to: ${OUTPUT}`);
}

main().catch(console.error);
