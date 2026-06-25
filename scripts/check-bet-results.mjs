/**
 * Checks pending bets in data/bet-log.json against real results once the
 * round has finished, and records win/loss + per-leg hit/miss automatically.
 *
 * Run: node scripts/check-bet-results.mjs
 * Run automatically once/day via scripts/refresh-all.mjs (after the player-stats
 * refresh, so AFL Tables has the latest round's final box scores).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BET_LOG = path.join(__dirname, "..", "data", "bet-log.json");

const AFL_TABLES = "https://afltables.com/afl/stats/players";
const SQUIGGLE = "https://api.squiggle.com.au";
const DELAY_MS = 1000;

// Maps the singular/plural stat words used in leg notes ("8+ handballs", "1+ goal")
// to the field names used in AFL Tables game rows.
const STAT_ALIASES = {
  disposal: "disposals", disposals: "disposals",
  kick: "kicks", kicks: "kicks",
  mark: "marks", marks: "marks",
  handball: "handballs", handballs: "handballs",
  goal: "goals", goals: "goals",
  tackle: "tackles", tackles: "tackles",
  clearance: "clearances", clearances: "clearances",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toAFLTablesPath(name) {
  const parts = name.trim().split(/\s+/);
  const letter = parts[0][0].toUpperCase();
  return `${letter}/${parts.join("_")}`;
}

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

function parsePlayerGames(html, year) {
  const games = [];
  const anchorIdx = html.indexOf(`name="${year}0"`);
  if (anchorIdx === -1) return games;

  const tableHtml = extractTable(html, anchorIdx);
  if (!tableHtml) return games;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const rawCells = [];
    const cells = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let t;
    while ((t = tdRegex.exec(rowMatch[1])) !== null) {
      rawCells.push(t[1]);
      cells.push(t[1].replace(/<[^>]+>/g, "").trim());
    }
    if (cells.length < 13) continue;
    const round = cells[2];
    if (!round || !/^(\d+|EF|QF|SF|PF|GF)$/i.test(round)) continue;
    // AFL Tables round numbers can be offset from Squiggle's (bye weeks counted
    // differently), so we match games by date — pull it from the round-link href,
    // e.g. href="../../games/2026/032120260620.html" -> date "20260620".
    const hrefMatch = rawCells[2].match(/href="[^"]*?(\d{8})\.html"/);
    const dateStr = hrefMatch ? hrefMatch[1] : null;
    const safeInt = (idx) => { const v = parseInt(cells[idx]); return isNaN(v) ? 0 : v; };
    games.push({
      round,
      dateStr,
      kicks: safeInt(5), marks: safeInt(6), handballs: safeInt(7),
      disposals: safeInt(8), goals: safeInt(9), tackles: safeInt(12),
      clearances: cells.length >= 16 ? safeInt(15) : undefined,
    });
  }
  return games;
}

async function fetchPlayerRoundStat(playerName, year, dateStr) {
  // dateStr is "YYYY-MM-DD" — converted to AFL Tables' "YYYYMMDD" href format for matching.
  const wantDate = dateStr.replace(/-/g, "");
  const p = toAFLTablesPath(playerName);
  for (const url of [`${AFL_TABLES}/${p}.html`, `${AFL_TABLES}/${p}0.html`]) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
      if (!res.ok) continue;
      const games = parsePlayerGames(await res.text(), year);
      const game = games.find((g) => g.dateStr === wantDate);
      if (game) return game;
    } catch { /* try next url */ }
  }
  return null; // not found — either game hasn't been played, or player didn't play (DNP)
}

async function findRoundForGame(gameName, dateStr) {
  const year = new Date(dateStr).getFullYear();
  try {
    const res = await fetch(`${SQUIGGLE}/?q=games;year=${year}`, { headers: { "User-Agent": "afl-multi-builder/1.0" } });
    const data = await res.json();
    const [teamA, teamB] = gameName.toLowerCase().split(" v ").map((s) => s.trim());
    for (const g of data.games ?? []) {
      if (!g.hteam || !g.ateam) continue;
      const h = g.hteam.toLowerCase(), a = g.ateam.toLowerCase();
      const teamsMatch =
        (h.includes(teamA) || teamA.includes(h)) && (a.includes(teamB) || teamB.includes(a)) ||
        (h.includes(teamB) || teamB.includes(h)) && (a.includes(teamA) || teamA.includes(a));
      if (teamsMatch && g.date.startsWith(dateStr)) return { round: g.round, complete: g.complete === 100 };
    }
  } catch { /* squiggle unreachable */ }
  return null;
}

function parseLeg(name) {
  const m = name.match(/^(.+?)\s+(\d+)\+\s+([a-z]+)$/i);
  if (!m) return null;
  const [, playerName, thresholdStr, statWord] = m;
  const stat = STAT_ALIASES[statWord.toLowerCase()];
  if (!stat) return null;
  return { playerName: playerName.trim(), threshold: parseInt(thresholdStr), stat };
}

async function main() {
  const log = JSON.parse(fs.readFileSync(BET_LOG, "utf8"));
  const pending = log.bets.filter((b) => b.result === "pending");

  if (pending.length === 0) {
    console.log("No pending bets to check.");
    return;
  }

  console.log(`Checking ${pending.length} pending bet(s)...\n`);
  let updated = 0;

  for (const bet of pending) {
    console.log(`Bet #${bet.id}: ${bet.game} (${bet.date})`);
    const roundInfo = await findRoundForGame(bet.game, bet.date);
    if (!roundInfo || !roundInfo.complete) {
      console.log("  Game not finished yet — skipping.\n");
      continue;
    }

    let allResolved = true;
    let allHit = true;
    for (const leg of bet.legs) {
      const parsed = parseLeg(leg.name);
      if (!parsed) {
        console.log(`  Could not parse leg "${leg.name}" — leaving bet pending.`);
        allResolved = false;
        break;
      }
      const game = await fetchPlayerRoundStat(parsed.playerName, new Date(bet.date).getFullYear(), bet.date);
      await sleep(DELAY_MS);
      if (!game) {
        // No row for this date — most likely did not play (omitted/injured). Counts as a miss.
        console.log(`  ${parsed.playerName}: no game record for ${bet.date} (DNP?) — treating as miss.`);
        leg.hit = false;
        allHit = false;
        continue;
      }
      const actual = game[parsed.stat] ?? 0;
      leg.hit = actual >= parsed.threshold;
      if (!leg.hit) allHit = false;
      console.log(`  ${parsed.playerName} ${parsed.stat}: ${actual} (needed ${parsed.threshold}+) — ${leg.hit ? "HIT" : "MISS"}`);
    }

    if (!allResolved) {
      console.log("");
      continue;
    }

    bet.result = allHit ? "won" : "lost";
    bet.pnl = bet.stake == null ? 0 : allHit ? Math.round(bet.stake * (bet.odds - 1) * 100) / 100 : -bet.stake;
    console.log(`  → ${bet.result.toUpperCase()}, pnl ${bet.pnl}\n`);
    updated++;
  }

  if (updated > 0) {
    fs.writeFileSync(BET_LOG, JSON.stringify(log, null, 2));
    console.log(`Updated ${updated} bet(s). Saved to ${BET_LOG}`);
  } else {
    console.log("No bets resolved this run.");
  }
}

main().catch(console.error);
