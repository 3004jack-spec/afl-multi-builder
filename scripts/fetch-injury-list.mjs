/**
 * Scrapes the Footywire AFL injury list and saves to data/injury-list.json.
 * Plain HTML, no JS rendering needed — fetch + regex, no Playwright.
 * Run once per day: node scripts/fetch-injury-list.mjs
 *
 * Output format:
 * {
 *   fetchedAt: ISO string,
 *   players: {
 *     "Isaac Cumming": { team: "Adelaide Crows", injury: "Hamstring", returning: "Test" },
 *     ...
 *   }
 * }
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../data/injury-list.json");
const URL = "https://www.footywire.com/afl/footy/injury_list";

async function main() {
  const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status}`);
    process.exit(1);
  }
  const html = await res.text();

  const players = {};
  let teamCount = 0;

  // Each team block: <td ... class="tbtitle">Team Name (N Players)</td> ... rows of
  // <a ...>Player Name</a></td><td ...>Injury</td><td ...>Returning</td>
  const teamBlockRe = /class="tbtitle">([^(<]+)\s*\(\d+ Players?\)<\/td>([\s\S]*?)<\/table>\s*<\/div>/g;
  let teamMatch;
  while ((teamMatch = teamBlockRe.exec(html)) !== null) {
    const team = teamMatch[1].trim();
    const block = teamMatch[2];
    teamCount++;

    const rowRe = /<a[^>]*>([^<]+)<\/a><\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g;
    let rowMatch;
    while ((rowMatch = rowRe.exec(block)) !== null) {
      const [, name, injury, returning] = rowMatch;
      players[name.trim()] = {
        team,
        injury: injury.trim(),
        returning: returning.trim(),
      };
    }
  }

  if (teamCount === 0 || Object.keys(players).length === 0) {
    console.error("Parsed 0 teams/players — Footywire page structure likely changed, check the regex against current HTML.");
    process.exit(1);
  }

  const out = {
    fetchedAt: new Date().toISOString(),
    players,
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`✅ Saved ${Object.keys(players).length} injury entries across ${teamCount} teams to ${OUT_PATH}`);
}

main();
