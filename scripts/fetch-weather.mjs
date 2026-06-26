/**
 * Fetches forecast conditions (rain probability/amount, wind) for each upcoming AFL venue
 * around kickoff time, using Open-Meteo (free, no API key — BOM has no clean JSON forecast
 * endpoint without scraping a rendered page, Open-Meteo gives the same underlying model data).
 * Saves to data/weather.json. Run once per day: node scripts/fetch-weather.mjs
 *
 * Output format:
 * {
 *   fetchedAt: ISO string,
 *   games: {
 *     "Hawthorn v Greater Western Sydney": {
 *       venue: "M.C.G.",
 *       kickoff: ISO string,
 *       precipProbability: 20,   // %
 *       precipMm: 0.1,
 *       windKph: 14,
 *       wetWeatherFlag: false    // true if precipProbability >= 50 or precipMm >= 1
 *     }
 *   }
 * }
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../data/weather.json");
const SQUIGGLE = "https://api.squiggle.com.au";

// Squiggle venue name -> { lat, lon }. Add to this as new venues come up.
const VENUE_COORDS = {
  "M.C.G.": { lat: -37.8199, lon: 144.9834 },
  "MCG": { lat: -37.8199, lon: 144.9834 },
  "Marvel Stadium": { lat: -37.8164, lon: 144.9475 },
  "S.C.G.": { lat: -33.8916, lon: 151.2247 },
  "SCG": { lat: -33.8916, lon: 151.2247 },
  "Adelaide Oval": { lat: -34.9156, lon: 138.5961 },
  "Gabba": { lat: -27.4858, lon: 153.0381 },
  "Optus Stadium": { lat: -31.9512, lon: 115.8891 },
  "Marvel": { lat: -37.8164, lon: 144.9475 },
  "GMHBA Stadium": { lat: -38.1577, lon: 144.3540 },
  "Engie Stadium": { lat: -33.8473, lon: 151.0631 },
  "Manuka Oval": { lat: -35.3186, lon: 149.1349 },
  "TIO Stadium": { lat: -12.3989, lon: 130.8822 },
  "Heritage Bank Stadium": { lat: -28.0008, lon: 153.3617 },
  "Ninja Stadium": { lat: -27.5965, lon: 153.0986 },
  "People First Stadium": { lat: -27.5965, lon: 153.0986 },
  "UTAS Stadium": { lat: -41.4419, lon: 147.1379 },
  "Norwood Oval": { lat: -34.9156, lon: 138.6324 },
  "Mars Stadium": { lat: -37.5732, lon: 143.8338 },
  "Docklands": { lat: -37.8164, lon: 144.9475 },
  "Perth Stadium": { lat: -31.9512, lon: 115.8891 },
  "Football Park": { lat: -34.9156, lon: 138.5961 },
  "Kardinia Park": { lat: -38.1577, lon: 144.3540 },
  "Carrara": { lat: -28.0008, lon: 153.3617 },
  "Stadium Australia": { lat: -33.8473, lon: 151.0631 },
  "Bellerive Oval": { lat: -42.8736, lon: 147.3656 },
  "York Park": { lat: -41.4419, lon: 147.1379 },
};

function precipFlag(precipProbability, precipMm) {
  return precipProbability >= 50 || precipMm >= 1;
}

async function main() {
  const year = new Date().getFullYear();
  const res = await fetch(`${SQUIGGLE}/?q=games;year=${year}`, { headers: { "User-Agent": "afl-multi-builder/1.0" } });
  const data = await res.json();
  const upcoming = (data.games ?? []).filter(g => {
    if (g.complete >= 100 || !g.hteam || !g.ateam) return false;
    const kickoff = new Date(g.date.replace(" ", "T") + "+10:00");
    const hoursOut = (kickoff.getTime() - Date.now()) / 3_600_000;
    return hoursOut > -3 && hoursOut < 96; // next 4 days, same window scrapers care about
  });

  const games = {};
  for (const g of upcoming) {
    const coords = VENUE_COORDS[g.venue];
    if (!coords) {
      console.log(`  No coords for venue "${g.venue}" (${g.hteam} v ${g.ateam}) — add to VENUE_COORDS.`);
      continue;
    }
    const kickoff = new Date(g.date.replace(" ", "T") + "+10:00");
    const dateStr = kickoff.toISOString().slice(0, 10);

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&hourly=precipitation_probability,precipitation,wind_speed_10m&timezone=Australia%2FSydney&start_date=${dateStr}&end_date=${dateStr}`;
    const wres = await fetch(url);
    if (!wres.ok) {
      console.log(`  Weather fetch failed for ${g.venue}: ${wres.status}`);
      continue;
    }
    const wdata = await wres.json();
    const times = wdata.hourly?.time ?? [];
    const kickoffHourStr = kickoff.toISOString().slice(0, 13); // "2026-06-26T09" (UTC hour)
    // Open-Meteo times come back in Australia/Sydney local time per `timezone` param, so compare
    // against the venue-local kickoff hour instead of UTC.
    const localKickoffStr = new Date(kickoff.getTime() + 10 * 3_600_000).toISOString().slice(0, 13);
    let idx = times.findIndex(t => t.startsWith(localKickoffStr));
    if (idx === -1) idx = 0;

    const precipProbability = wdata.hourly?.precipitation_probability?.[idx] ?? null;
    const precipMm = wdata.hourly?.precipitation?.[idx] ?? null;
    const windKph = wdata.hourly?.wind_speed_10m?.[idx] ?? null;

    const matchup = `${g.hteam} v ${g.ateam}`;
    games[matchup] = {
      venue: g.venue,
      kickoff: kickoff.toISOString(),
      precipProbability,
      precipMm,
      windKph,
      wetWeatherFlag: precipProbability !== null && precipMm !== null ? precipFlag(precipProbability, precipMm) : false,
    };
  }

  const out = { fetchedAt: new Date().toISOString(), games };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`✅ Saved weather for ${Object.keys(games).length} games to ${OUT_PATH}`);
  for (const [m, w] of Object.entries(games)) {
    console.log(`  ${m}: ${w.precipProbability}% rain, ${w.precipMm}mm, ${w.windKph}kph wind${w.wetWeatherFlag ? "  ⚠️ WET WEATHER FLAG" : ""}`);
  }
}

main();
