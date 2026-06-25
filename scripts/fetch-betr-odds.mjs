/**
 * Scrapes Betr AFL player prop markets and saves to data/betr-odds.json
 * Run once per day: node scripts/fetch-betr-odds.mjs
 *
 * UNVERIFIED PARSER: Betr doesn't post player prop markets until close to game day
 * (same behaviour as Sportsbet). At build time only Match Result/Handicap/Margin were
 * live, so the category-expand + innerText parsing below is a best-effort port of the
 * Sportsbet scraper's approach, not yet confirmed against real player prop data.
 * Re-run and check the console output next time games are within ~24-48h — if player
 * counts come back 0, inspect the live page DOM and fix parseInnerText/category finding.
 *
 * Output format matches data/sportsbet-odds.json:
 * {
 *   fetchedAt: ISO string,
 *   matches: [
 *     {
 *       matchup: "Collingwood v Richmond",
 *       url: "...",
 *       markets: { "Player Name": { disposals: {"20": 1.95, ...}, kicks: {...}, ... } }
 *     }
 *   ]
 * }
 */

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../data/betr-odds.json");
const COMP_URL = "https://www.betr.com.au/sports/Australian-Rules/101/AFL/AFL-Premiership/43735";

// Category labels to look for once player prop markets are posted.
// Betr's exact wording is unconfirmed — these are best guesses based on
// common AU bookmaker naming; adjust once real markets are visible.
const STAT_CATEGORIES = [
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
 * Same line-scanning approach as the Sportsbet scraper: player name line,
 * followed by a "N+" threshold line, followed by a decimal price line.
 */
function parseInnerText(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const players = {};
  let currentPlayer = null;
  let currentThreshold = null;

  for (const line of lines) {
    if (
      /^[A-Z][a-z]+ [A-Z]/.test(line) &&
      !line.startsWith("Last 5") &&
      !line.startsWith("Season") &&
      !line.startsWith("All ") &&
      line.length < 50
    ) {
      currentPlayer = line;
      currentThreshold = null;
      if (!players[currentPlayer]) players[currentPlayer] = {};
      continue;
    }

    const threshMatch = line.match(/^(\d+)\+/);
    if (threshMatch) {
      currentThreshold = threshMatch[1];
      continue;
    }

    if (currentPlayer && currentThreshold) {
      const price = parseFloat(line);
      if (!isNaN(price) && price >= 1.01 && price <= 200) {
        players[currentPlayer][currentThreshold] = price;
        currentThreshold = null;
        continue;
      }
      if (line === "N/A" || line === "-") {
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
    console.log("Navigating to AFL Premiership page...");
    await page.goto(COMP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    const matchLinks = await page.$$eval(
      'a[href*="/AFL-Premiership/"][href*="/All-Markets"]',
      (links) => {
        const seen = new Set();
        return links
          .map((a) => a.href)
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

        const matchTitle = await page
          .$eval("h1", (el) => el.innerText?.replace(/\s+/g, " ").trim())
          .catch(() => decodeURIComponent(href.split("/").slice(-2)[0]).replace(/-/g, " "));
        console.log(`  Match: ${matchTitle}`);

        const marketData = {};

        for (const { label, stat } of STAT_CATEGORIES) {
          const expanded = await page.evaluate((catLabel) => {
            const el = Array.from(document.querySelectorAll("button, a, [role=button], h2, h3, span"))
              .find((e) => e.innerText?.trim().toLowerCase().includes(catLabel.toLowerCase()));
            if (el) { el.click(); return true; }
            return false;
          }, label);

          if (!expanded) {
            console.log(`  Category "${label}" not found (likely not posted yet)`);
            continue;
          }

          await page.waitForTimeout(1500);

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
        }

        const totalPlayers = Object.keys(marketData).length;
        console.log(`  Total players: ${totalPlayers}`);
        results.push({ matchup: matchTitle, url: href, markets: marketData });

      } catch (e) {
        console.error(`  Error: ${e.message.slice(0, 150)}`);
      }

      await page.waitForTimeout(1500);
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
