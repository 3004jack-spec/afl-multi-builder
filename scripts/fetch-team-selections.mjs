/**
 * Scrapes Footywire's "Team Selections" page (Outs / Emergencies / named players per game)
 * and saves to data/team-selections.json. Plain HTML, no Playwright needed.
 * Run once per day: node scripts/fetch-team-selections.mjs
 *
 * This is the "late withdrawal" / "out of side" data source: a player can be dropped from
 * the named team with zero injury listed, so this is separate from data/injury-list.json.
 *
 * Output format:
 * {
 *   fetchedAt: ISO string,
 *   games: {
 *     "Hawthorn v GWS (MCG)": {
 *       named: ["Jarman Impey", ...],       // full 22 + interchange, currently selected
 *       outs: ["Jarman Impey", ...],        // dropped from last week's side — genuine late-change signal
 *       emergencies: ["William Mccabe", ...] // boundary risk, may be added if another player is withdrawn
 *     }
 *   }
 * }
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../data/team-selections.json");
const URL = "https://www.footywire.com/afl/footy/afl_team_selections";

// "pp-hawthorn-hawks--jarman-impey" -> "Jarman Impey"
// "pp-essendon-bombers--conor-mckenna" -> "Conor McKenna" (AFL Tables capitalises the letter after "Mc")
function capitalizeWord(w) {
  if (/^mc[a-z]/i.test(w) && w.length > 2) {
    return "Mc" + w.charAt(2).toUpperCase() + w.slice(3);
  }
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function slugToName(href) {
  const slug = href.split("--").pop();
  return slug
    .split("-")
    .map(capitalizeWord)
    .join(" ");
}

async function main() {
  const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status}`);
    process.exit(1);
  }
  const html = await res.text();

  const games = {};
  // The lookahead must also accept end-of-string — Footywire's last game block on the page has
  // no trailing marker to terminate against, so without this the last-listed game (whichever
  // that happens to be on a given day) is silently dropped from every scrape.
  const gameBlockRe = /class="tbtitle" height="30">(?:<a name="\d+"><\/a>)?([^<]+)<\/TD><\/TR>([\s\S]*?)(?=<TR><TD COLSPAN="3" ALIGN="CENTER" class="tbtitle" height="30">|<TABLE[^>]*WIDTH="1000"|$)/g;
  let gameMatch;
  while ((gameMatch = gameBlockRe.exec(html)) !== null) {
    const gameLabel = gameMatch[1].trim();
    const block = gameMatch[2];

    // Left column has Interchange / Emergencies / Ins / Outs as <b>Section</b> headers
    // followed by <a href="pp-...--player-slug">
    const sectionRe = /<b>(Interchange|Emergencies|Ins|Outs)<\/b><\/td><\/tr>([\s\S]*?)(?=<tr><td><b>|<\/table>)/g;
    const sections = { Interchange: [], Emergencies: [], Ins: [], Outs: [] };
    let sectionMatch;
    while ((sectionMatch = sectionRe.exec(block)) !== null) {
      const [, label, sectionBlock] = sectionMatch;
      const hrefRe = /href="(pp-[^"]+)"/g;
      let hrefMatch;
      while ((hrefMatch = hrefRe.exec(sectionBlock)) !== null) {
        sections[label].push(slugToName(hrefMatch[1]));
      }
    }

    // Named 22: every pp- href in the block minus the left-column sections (avoid double counting Ins,
    // which overlaps with the main team table)
    const allHrefs = new Set();
    const hrefRe = /href="(pp-[^"]+)"/g;
    let hrefMatch;
    while ((hrefMatch = hrefRe.exec(block)) !== null) {
      allHrefs.add(slugToName(hrefMatch[1]));
    }
    const named = [...allHrefs].filter(n => !sections.Outs.includes(n) && !sections.Emergencies.includes(n));

    if (named.length > 0 || sections.Outs.length > 0) {
      games[gameLabel] = {
        named,
        outs: sections.Outs,
        emergencies: sections.Emergencies,
      };
    }
  }

  if (Object.keys(games).length === 0) {
    console.error("Parsed 0 games — Footywire team-selections page structure likely changed.");
    process.exit(1);
  }

  const out = { fetchedAt: new Date().toISOString(), games };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`✅ Saved team selections for ${Object.keys(games).length} games to ${OUT_PATH}`);
  for (const [game, data] of Object.entries(games)) {
    console.log(`  ${game}: ${data.named.length} named, ${data.outs.length} outs, ${data.emergencies.length} emergencies`);
  }
}

main();
