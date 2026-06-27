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

const TEAM_SUFFIXES = /\s+(Eagles|Giants|GIANTS|SUNS|Suns|Crows|Power|Magpies|Tigers|Saints|Cats|Hawks|Lions|Bombers|Demons|Dockers|Swans|Kangaroos|Bulldogs|Blues)$/i;

function normalizeTeam(name) {
  return name.replace(TEAM_SUFFIXES, "").trim();
}

// AFL Tables disambiguates same-named players with a numeric suffix (e.g. Bailey_Williams0.html,
// Bailey_Williams1.html) but gives no indication via the URL of which is which. A team's own
// players never appear as an "opponent" in their own game-by-game table, so when a name collides,
// the correct page is the one where neither matchup team shows up as an opponent more than the
// other (the real club should have ~0 appearances; an unrelated namesake's club appears normally).
async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function opponentCounts(html, teams) {
  const counts = {};
  for (const team of teams) counts[team] = 0;
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const tdMatch = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(rowMatch[1]);
    if (!tdMatch) continue;
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    const opponent = cells[1];
    if (!opponent) continue;
    for (const team of teams) {
      if (opponent === team) counts[team]++;
    }
  }
  return counts;
}

async function fetchPlayerGames(playerName, matchup) {
  const p = toAFLTablesPath(playerName);

  // Always probe the bare name AND every numbered variant — AFL Tables doesn't 404 the bare
  // path just because numbered duplicates also exist, so trusting a 200 on the bare path alone
  // silently picks the wrong namesake whenever one exists (caught via Bailey Williams/Maurice Rioli).
  const candidates = [];
  const baseHtml = await fetchHtml(`${AFL_TABLES}/${p}.html`);
  if (baseHtml) candidates.push(baseHtml);
  for (let n = 0; n < 5; n++) {
    const html = await fetchHtml(`${AFL_TABLES}/${p}${n}.html`);
    if (!html) break;
    candidates.push(html);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return parsePlayerGames(candidates[0], SEASONS);

  // Multiple namesakes — first narrow to candidates who actually have games in the relevant
  // seasons. AFL has had many same-named players across history; most "collisions" are a current
  // player sharing a name with a long-retired one, not a genuine same-era ambiguity.
  const eraMatches = candidates
    .map((html) => ({ html, games: parsePlayerGames(html, SEASONS) }))
    .filter((c) => c.games.length > 0);

  if (eraMatches.length === 0) return null;
  if (eraMatches.length === 1) return eraMatches[0].games;

  // Genuinely ambiguous within the same era — disambiguate using the two teams in this
  // player's current matchup (a team never appears as its own player's opponent).
  const teams = matchup ? matchup.split(/\s+v\s+/i).map(normalizeTeam) : [];
  if (teams.length === 2) {
    const scored = eraMatches.map((c) => {
      const counts = opponentCounts(c.html, teams);
      return { games: c.games, score: Math.min(counts[teams[0]], counts[teams[1]]) };
    });
    scored.sort((a, b) => a.score - b.score);
    if (scored[0].score < scored[1]?.score) {
      return scored[0].games;
    }
    console.log(`    ⚠ ${playerName}: ambiguous match across ${eraMatches.length} same-era namesakes, defaulting to first`);
  }
  return eraMatches[0].games;
}

/**
 * Discover players from our own scrapers (Sportsbet, Betr) instead of the Odds API.
 * The Odds API's player_disposals market was the old discovery source, but it's
 * quota-limited (500 req/month, already exhausted this round) and unreliable —
 * this is the actual fix for the "Brisbane/Sydney players missing" bug, not just
 * a workaround. Each scraped file already lists every player it found a disposals
 * line for, which is all we need to know who to pull AFL Tables history for.
 */
function getPlayersFromScrapes() {
  const players = new Map();

  for (const file of ["sportsbet-odds.json", "betr-odds.json"]) {
    const filePath = path.join(__dirname, "..", "data", file);
    if (!fs.existsSync(filePath)) continue;

    let scraped;
    try {
      scraped = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }

    for (const match of scraped.matches ?? []) {
      for (const [name, statMap] of Object.entries(match.markets ?? {})) {
        if (players.has(name)) continue;
        const disposalLines = statMap.disposals ? Object.keys(statMap.disposals).map(Number) : [];
        players.set(name, {
          line: disposalLines.length ? Math.min(...disposalLines) : 0,
          matchup: match.matchup,
        });
      }
    }
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

  const players = getPlayersFromScrapes();
  console.log(`\nFound ${players.length} players across scraped bookmaker data\n`);

  if (players.length === 0) {
    console.log("No players found. Run fetch-sportsbet-odds.mjs / fetch-betr-odds.mjs first.");
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
    const games = await fetchPlayerGames(player.name, player.matchup);

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

    // Save progress every 10 players so a killed/interrupted run doesn't lose all work.
    if ((fetched + failed) % 10 === 0) {
      fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
    }

    await sleep(DELAY_MS);
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`\n✅ Done. Fetched ${fetched} new, skipped ${skipped} cached, failed ${failed}.`);
  console.log(`   Saved to: ${OUTPUT}`);
}

main().catch(console.error);
