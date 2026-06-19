/**
 * Scrapes Sportsbet AFL player prop markets and saves to data/sportsbet-odds.json
 * Run once per day: node scripts/fetch-sportsbet-odds.mjs
 *
 * Output format:
 * {
 *   fetchedAt: ISO string,
 *   matches: [
 *     {
 *       matchup: "Gold Coast SUNS v Hawthorn",
 *       url: "...",
 *       markets: {
 *         "Noah Anderson": { disposals: {"20": 1.04, "21": 1.07, ...}, kicks: {...}, ... },
 *         ...
 *       }
 *     }
 *   ]
 * }
 */

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../data/sportsbet-odds.json");

// Stat pills on the match page → our stat keys
const STAT_PILLS = [
  { label: "Disposals",  stat: "disposals"  },
  { label: "Kicks",      stat: "kicks"      },
  { label: "Marks",      stat: "marks"      },
  { label: "Tackles",    stat: "tackles"    },
  { label: "Handballs",  stat: "handballs"  },
  { label: "Clearances", stat: "clearances" },
  { label: "Goals",      stat: "goals"      },
];

/**
 * Parse innerText lines to extract player → threshold → price.
 * The page renders as:
 *   [jersey number]
 *   Player Name
 *   Last 5: XXXXX
 *   Season Avg:
 *   XX.X
 *   18+
 *   1.07
 *   19+
 *   N/A
 *   ...
 */
function parseInnerText(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const players = {};
  let currentPlayer = null;
  let currentThreshold = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Player name: starts with uppercase, contains a space, not a stat/label line
    if (
      /^[A-Z][a-z]+ [A-Z]/.test(line) &&
      !line.startsWith("Last 5") &&
      !line.startsWith("Season") &&
      !line.startsWith("Gold Coast") &&
      !line.startsWith("All") &&
      line.length < 50
    ) {
      currentPlayer = line;
      currentThreshold = null;
      if (!players[currentPlayer]) players[currentPlayer] = {};
      continue;
    }

    // Threshold: "18+" or "18+ Disposals"
    const threshMatch = line.match(/^(\d+)\+/);
    if (threshMatch) {
      currentThreshold = threshMatch[1];
      continue;
    }

    // Price: decimal number
    if (currentPlayer && currentThreshold) {
      const price = parseFloat(line);
      if (!isNaN(price) && price >= 1.01 && price <= 200) {
        players[currentPlayer][currentThreshold] = price;
        currentThreshold = null; // consume threshold
        continue;
      }
      // N/A = no price, reset threshold
      if (line === "N/A") {
        currentThreshold = null;
        continue;
      }
    }
  }

  return players;
}

async function scrape() {
  console.log("Launching browser...");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-AU",
  });

  const page = await context.newPage();

  try {
    console.log("Navigating to AFL section...");
    await page.goto("https://www.sportsbet.com.au/betting/australian-rules/afl", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForTimeout(4000);

    // Match URLs include a numeric event ID: /afl/team-v-team-XXXXXXXX
    const matchLinks = await page.$$eval(
      'a[href*="/betting/australian-rules/afl/"]',
      (links) => {
        const seen = new Set();
        return links
          .map((a) => a.href)
          .filter((href) => /\/afl\/[a-z0-9-]+-v-[a-z0-9-]+-\d{6,}/.test(href) && !href.includes("?"))
          .filter((href) => { if (seen.has(href)) return false; seen.add(href); return true; });
      }
    );

    console.log(`Found ${matchLinks.length} match(es)`);

    const results = [];

    for (const href of matchLinks) {
      console.log(`\nScraping: ${href}`);

      try {
        await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);

        const matchTitle = await page.$eval("h1", (el) => el.innerText?.replace(/\s+/g, " ").trim()).catch(() => href.split("/").pop());
        console.log(`  Match: ${matchTitle}`);

        const marketData = {};

        for (const { label, stat } of STAT_PILLS) {
          // Click the pill
          const clicked = await page.evaluate((pillLabel) => {
            const btn = Array.from(document.querySelectorAll("button, a")).find(
              (el) => el.innerText?.trim() === pillLabel
            );
            if (btn) { btn.click(); return true; }
            return false;
          }, label);

          if (!clicked) {
            console.log(`  Pill "${label}" not found`);
            continue;
          }

          await page.waitForTimeout(2000);

          // Grab the full page innerText and parse it
          const bodyText = await page.evaluate(() => document.body.innerText);
          const players = parseInnerText(bodyText);

          let count = 0;
          for (const [playerName, thresholds] of Object.entries(players)) {
            if (Object.keys(thresholds).length === 0) continue;
            if (!marketData[playerName]) marketData[playerName] = {};
            marketData[playerName][stat] = thresholds;
            count++;
          }
          console.log(`  ${label}: ${count} players`);
          if (count > 0) {
            const sample = Object.entries(players).find(([, t]) => Object.keys(t).length > 0);
            if (sample) console.log(`    e.g. ${sample[0]}: ${JSON.stringify(sample[1]).slice(0, 80)}`);
          }
        }

        const totalPlayers = Object.keys(marketData).length;
        console.log(`  Total players: ${totalPlayers}`);
        results.push({ matchup: matchTitle, url: href, markets: marketData });

      } catch (e) {
        console.error(`  Error: ${e.message.slice(0, 150)}`);
      }

      await page.waitForTimeout(2000);
    }

    const output = {
      fetchedAt: new Date().toISOString(),
      matches: results,
      totalPlayers: results.reduce((acc, m) => acc + Object.keys(m.markets).length, 0),
    };

    mkdirSync(join(__dirname, "../data"), { recursive: true });
    writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
    console.log(`\nSaved to ${OUT_PATH}`);
    console.log(`Total matches: ${results.length}, Total players: ${output.totalPlayers}`);

    return output;
  } finally {
    await browser.close();
  }
}

scrape().catch(console.error);
