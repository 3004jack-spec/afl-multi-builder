/**
 * Runs all data-refresh scrapers in the correct order:
 * 1. Sportsbet odds (player props)
 * 2. Betr odds (player props)
 * 3. Player stats (AFL Tables history — discovers players from the two scrapes above)
 * 4. Bet result check (settles any pending bets whose game has finished)
 *
 * Run manually: node scripts/refresh-all.mjs
 * Also run automatically at the start of each Claude Code session — see .claude/settings.json SessionStart hook.
 * Caveat: this only fires when a Claude Code session starts, so bet results won't
 * auto-settle on a day with no session — run check-bet-results.mjs manually, or ask
 * for a cron-scheduled cloud routine, if you need it to happen with no session open.
 */

import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MARKER_PATH = path.join(__dirname, "..", "data", ".last-refresh");

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, local-to-UTC date
}

function alreadyRefreshedToday() {
  if (!existsSync(MARKER_PATH)) return false;
  return readFileSync(MARKER_PATH, "utf8").trim() === today();
}

function run(script) {
  return new Promise((resolve) => {
    console.log(`\n=== Running ${script} ===`);
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      cwd: path.join(__dirname, ".."),
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code !== 0) console.error(`  ${script} exited with code ${code} — continuing anyway`);
      resolve();
    });
  });
}

async function main() {
  if (alreadyRefreshedToday() && !process.argv.includes("--force")) {
    console.log(`Already refreshed today (${today()}). Skipping. Use --force to refresh anyway.`);
    return;
  }

  await run("fetch-sportsbet-odds.mjs");
  await run("fetch-betr-odds.mjs");
  await run("fetch-player-stats.mjs");
  await run("check-bet-results.mjs");

  writeFileSync(MARKER_PATH, today());
  console.log("\n=== Refresh complete ===");
}

main();
