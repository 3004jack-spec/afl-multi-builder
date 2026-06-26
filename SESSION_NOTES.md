# AFL Multi Builder — Session Notes
*Last updated: 2026-06-26*

---

## Current State

**Production URL:** https://afl-multi-builder.vercel.app/
**GitHub:** https://github.com/3004jack-spec/afl-multi-builder  
**Local dev:** `npm run dev` → port 3001 (via `.claude/launch.json`)

### What is working on Vercel (last deploy: 2026-06-19)
- **Today / Tomorrow tab** — games filtered to today+tomorrow only, sorted by kickoff, game-aware lineup filter
- Match Odds tab — live AFL odds, Squiggle confidence model
- Player Props tab — all 7 stat types (disposals, kicks, marks, tackles, handballs, clearances, goals)
- Auto Multi tab — multiple combo options per game (single ≥85%, best 2-leg, 3-leg ≥65%, 4-leg ≥55%)
- My Multi tab — Promotions panel (odds boost buttons, bonus bet toggle), multi strike rate, EV, Kelly
- Backtest tab — 7 seasons AFL historical data
- Bet Logger tab — log bets placed, track results, running P&L

### Data sources in play
| Source | Stats covered | How to refresh |
|---|---|---|
| AFL Tables (afltables.com) | All stats, historical | `node scripts/fetch-player-stats.mjs` |
| The Odds API (events endpoint only) | Game times + team names | Automatic on page load (odds quota exhausted 2026-06-22, deprioritized — see below) |
| Sportsbet scraper | All 7 stats, real prices | `node scripts/fetch-sportsbet-odds.mjs` |
| Betr scraper (added 2026-06-22, unverified) | All 7 stats (parser unconfirmed) | `node scripts/fetch-betr-odds.mjs` |
| Footywire injury list (added 2026-06-26) | Injury/return-status flag, manual-investigation only | `node scripts/fetch-injury-list.mjs` |
| Footywire team selections (added 2026-06-26) | Outs/Emergencies flag, manual-investigation only | `node scripts/fetch-team-selections.mjs` |
| Open-Meteo (added 2026-06-26) | Wet-weather flag per game/venue, manual-investigation only | `node scripts/fetch-weather.mjs` |

**Workflow:** Run both scrapers once the day before each round (or closer to game day — props open ~24-48h out). Check live prices before placing.

**Strategy shift (2026-06-22):** Jack decided The Odds API isn't reliable long-term — free tier (500 req/month) gets burned fast and we already hit `OUT_OF_USAGE_CREDITS` this session (515/500 used, no visible reset date). New direction: scrape bookmaker sites directly (same Playwright pattern as Sportsbet) instead of relying on a shared third-party odds API, and run those scrapers at the start of each session so prices are always fresh. Betr is the first additional bookmaker built this way — see below. Odds API isn't ripped out yet (it fails silently when out of quota, costs nothing extra) but should be considered for removal once 2+ direct scrapers are proven reliable.

---

## Session 2026-06-26 Changes

### 1. Fixed cross-bookmaker odds mixing in multis — real bug, not just a labeling gap ✅
Jack asked whether multi legs were combining best odds across multiple platforms (Sportsbet/Betr) rather than staying on one bookie. They were: `bestCombos()` in `app/page.tsx` built every combo from a leg pool where each leg already carried its own independently-best-bookie price (`bestOdds`/`bestBookie` picked per-line across bookies in `app/api/player-props/route.ts`), with zero constraint that a combo's legs share a bookmaker. A "Best 2-leg" could be Leg A's best Sportsbet price × Leg B's best Betr price — not a bet placeable as one multi anywhere.

**Fix:** `bestCombos()` now runs every category's search (single, 2/3/4-leg, long shot, promo) separately per-bookie (`legsForBookie()` substitutes each leg's price for that specific bookie, dropping legs that bookie doesn't offer), then picks whichever bookie produced the highest-Kelly result for that category — but the winning combo's legs are now guaranteed to share one bookmaker. `ComboOption` got a new `bookie` field, surfaced as a tag on every combo card (Recommended Bets list, game-card summary).

Also added a same-bookie check on the two manual flows where Jack hand-picks legs (My Multi tab, and the per-game "selected legs" summary) — since those let you pick any leg regardless of bookie, a red "⚠ Mixed bookies" warning now shows if the hand-picked legs don't all share one bookmaker.

### 2. Three new manual-investigation flags added — built and verified ✅
Jack asked whether the model checks injuries/niggles — it didn't. Added three flags as **information for Jack to manually investigate, not model inputs** (deliberately not folded into bayesianRate/Kelly — see SESSION_NOTES lesson from 2026-06-19 about false precision):

- **Injury flag** (`scripts/fetch-injury-list.mjs` → `data/injury-list.json`) — scrapes Footywire's injury list (plain HTML, no Playwright needed). ~155 entries across 18 teams. Shows as `⚠ {injury} ({returning})` badge on a leg, e.g. "⚠ Head (Test)".
- **Selection flag** (`scripts/fetch-team-selections.mjs` → `data/team-selections.json`) — scrapes Footywire's team-selections page for "Outs" (dropped from named side, zero injury required) and "Emergencies" (boundary risk) per game. This is the genuine "late withdrawal" signal — `data/lineups-override.json` was found to be empty/dead, nothing in the codebase populates it, so this scraper replaces that gap. Shows as `⚠ OUT of side` (red) or `⚠ Emergency` (yellow).
- **Weather flag** (`scripts/fetch-weather.mjs` → `data/weather.json`) — Open-Meteo forecast (free, no key; BOM itself has no clean JSON forecast endpoint) at kickoff hour for each venue, keyed by Squiggle's `venue` field via a manual venue→lat/lon lookup (`VENUE_COORDS` in the script — add new venues here if a fetch logs "No coords for venue"). Flags `wetWeatherFlag: true` when rain probability ≥50% or precip ≥1mm. Shows as `⚠ Wet weather (N% rain)` per game.

All three wired into `app/api/player-props/route.ts` (`injuryFlag`, `selectionFlag`, `weatherFlag` on `PlayerProp`) and surfaced in `app/page.tsx`: a per-game "⚠ flags present" / wet-weather badge on the Today/Tomorrow game cards, and per-leg badges in both the expanded "All legs" list and the "Selected legs" (My Multi) summary. All three added to `scripts/refresh-all.mjs` so they refresh daily with everything else.

**Known limitation:** selection-flag name matching is exact-string only (`data[playerName]` lookup) — Footywire's team-selection slugs occasionally differ from AFL Tables' player-stats names (e.g. apostrophes, disambiguating suffixes like "Callum Brown 1"). A mismatch means a flag silently doesn't attach, not a false flag — worth fuzzy-matching later if it turns out to miss real cases.

**Side discovery, unresolved:** the Footywire team-selections scrape independently lists a "Clayton Oliver" in Hawthorn's named side for the Hawthorn v GWS game — a second source agreeing with the Sportsbet scrape that was earlier assumed to be a one-off scraper bug (Clayton Oliver is Melbourne's star midfielder). Two independent sources agreeing on this means it's not just a scraper glitch — worth a manual check on whether there's a different, lesser-known Hawthorn player with the same name before trusting either way.

## Session 2026-06-25 Changes

### 1. Automatic bet result checking — built and verified ✅
New `scripts/check-bet-results.mjs`: once a bet's game is complete (checked via Squiggle), fetches each leg's player's AFL Tables row and auto-records `won`/`lost` + pnl in `data/bet-log.json`. Wired into `scripts/refresh-all.mjs` as step 4 (after the existing scrapers), so it runs once/day via the `SessionStart` hook.

**Bug found + fixed during testing:** AFL Tables and Squiggle number rounds differently this season (bye-week offset) — round 15 on Squiggle is round 16 on AFL Tables. Round-based matching silently failed for every bet. Fixed by matching games on **date** instead (pulled from the AFL Tables row's link href), which is unambiguous. Verified against bet #2 (known answer: WON, $6.10) before trusting it on live pending bets.

**Caveat (unresolved):** this only fires when a Claude Code session starts that day. A day with no session won't auto-settle pending bets. True "no session needed" automation would require a cron-scheduled cloud routine — not yet built, ask if wanted.

### 2. Fixed Hawthorn v GWS missing from Today/Tomorrow tab ✅
Root cause: Sportsbet labels the team "GWS GIANTS," Squiggle (fixture source) calls it "Greater Western Sydney" — no shared words, so the matchup resolver (`app/api/player-props/route.ts`) couldn't attach a kickoff time, and the game silently dropped out of the Today/Tomorrow filter. Fixed with a small alias map (`gws`/`giants` → `greater western sydney`). Verified live — game now merges into one 143-prop entry with correct kickoff time.

### 3. Model foundation audited — confirmed intact, no drift ✅
Jack flagged a concern the model might be "wandering." Audited the four core rules from last week — all unchanged:
- Line eligibility gate (`seasonAvg >= ceil(line)`, filtered before Kelly ranking) — `app/api/player-props/route.ts:374`
- `CALIBRATION_SHRINK = 0.94` still applied in `legsSR()` — `app/page.tsx:130,133`
- Min-confidence floor (`minBayesian`, default 75%) still gates the leg pool before combos are built — `app/page.tsx:317`
- Tiered SR thresholds unchanged: Single ≥85%, 2-leg positive-Kelly-only (never had its own floor, by original design), 3-leg ≥65%, 4-leg ≥55%

**Lesson for next session:** any ad-hoc analysis script that queries `/api/player-props` directly must replicate `minBayesian >= 75` filtering and the `seasonAvg >= threshold` line-eligibility gate — otherwise it surfaces legs (e.g. 38–53% SR longshots) the real app would never show, which is misleading when discussing "best combo" results with Jack.

### 4. No new guardrail for binary/low-count stats (deferred, not built)
Jack raised a real distinction: low-count stats (goals, clearances) are higher-variance/coinflip-ish at a given SR vs. high-volume stats (kicks, disposals) with more buffer above the line. Confirmed this was never actually coded — it came up only as conversational reasoning (e.g. explaining the Rankine goal-leg miss). Decided to leave it for now. If revisited: either a blunt per-stat-type SR discount, or (better, more work) a per-player volatility measure based on how close the threshold sits to their actual game-to-game variance, not just season average.

---

## Session 2026-06-19 Changes

### 1. Renamed "Tonight" → "Today / Tomorrow" tab ✅
- Filter: today and tomorrow only (not "3 hours ago" rolling window)
- Sort: ascending kickoff time (next game always on top)
- Game-aware lineup filter: Footywire selections only applied if at least one player from that specific game appears in the data — prevents weekend selections from blocking Friday night games

### 2. Live odds only ✅
- Removed all estimated/inferred odds legs from display
- "No legs available" shown if a game has no Sportsbet data

### 3. Multiple combo options per game ✅
`bestCombos()` now returns an array:
- Best single leg (≥85% Bayesian)
- Best 2-leg multi (highest Kelly, positive)
- Best 3-leg multi (SR ≥65%)
- Best 4-leg multi (SR ≥55%)
- Promo option (if promoMinOdds set)

### 4. Sportsbet name resolution ✅
`resolveCanonicalMatchup()` in player-props API maps Sportsbet short names ("GWS GIANTS v Carlton") to Odds API canonical names ("Greater Western Sydney Giants v Carlton Blues") via word-based fuzzy matching. Fixed "0 legs for all games" matchup mismatch.

### 5. Line selection fix — critical ✅
**Root cause of "only 4 legs" bug:** The API was selecting the line with best `bayesianEdge` across ALL lines first, then applying `seasonAvg >= threshold` gate. This meant it picked ambitious high lines the player's season average couldn't support → killed by the gate.

**Fix:** Filter lines to `seasonAvg >= threshold` FIRST, then pick best `bayesianEdge` among eligible lines only. Result: 25 props → 433 props (60–80 per game).

### 6. Odds API h2h quota exhausted
Monthly quota depleted. App now falls back to events endpoint (game times + names, no win odds). Resets monthly. Check the-odds-api.com account.

---

## Bet Log

`data/bet-log.json` is the source of truth (10 bets logged as of 2026-06-26) — don't duplicate it here, it'll go stale. Current state: bet #10 (Dunkley + Lohmann, Brisbane v Sydney, $1.44, $15) is **pending**.

**2026-06-26 false-negative caught and reverted:** `check-bet-results.mjs` auto-settled bet #10 as LOST on a refresh run where AFL Tables only had round-15 data for both players — the Brisbane v Sydney game (round 16, played 2026-06-25) hadn't been scraped into `player-stats.json` yet, and the script's "no game record → treat as DNP/miss" logic silently turned that data lag into a loss. Manually verified via Squiggle (game shows 100% complete) and reverted the bet to pending in `data/bet-log.json` (see its `notes` field for the full trail). **The underlying bug is still live** — `check-bet-results.mjs` cannot currently tell "player didn't play" apart from "AFL Tables hasn't published this round yet." Re-run `fetch-player-stats.mjs` + `check-bet-results.mjs` once AFL Tables has round 16, and consider hardening the script to check the player's most-recent-game round number against the bet's round before trusting a DNP read.

---

## Model Validation — 2026-06-19

Run `node scripts/validate-model.mjs` to re-check calibration after any formula change.
Run `node scripts/backtest-props.mjs` to simulate P&L on recent rounds with real Sportsbet odds.

### Validation results (24,318 observations, leave-one-out cross-validation)
| Band | Predicted | Actual | Gap | Verdict |
|---|---|---|---|---|
| 65–70% | ~68% | 64.5% | -3% | ✅ calibrated |
| 70–75% | ~73% | 68.9% | -3.6% | ✅ calibrated |
| 75–80% | ~78% | 73.3% | -4.2% | ✅ calibrated |
| 80–85% | ~83% | 77.2% | -5.3% | ⚠️ slightly overconfident |
| 85–90% | ~88% | 83.5% | -4% | ✅ calibrated |
| 90–95% | ~93% | 86% | -6.5% | ⚠️ overconfident |

**Key findings:**
- Model is 2–5% overconfident across all bands — small, consistent, fixable
- Brier skill score 2.4% — better than random, market is reasonably efficient
- **Calibration fix:** multiply model output by **0.94** (model says 85% → trust as 80%)
- Per-stat gaps are tiny (1–3%) — no single stat is badly broken
- Backtest P&L on 5 rounds: -$4.70 on $50 staked (small sample, not alarming)

**Not yet applied:** the 0.94 shrink factor. Deferred pending more result data.

### Result tracking — critical for model improvement
Every round we have actual results is a free calibration data point. The plan:
1. After each round, log actual player stat values to `data/results-log.json`
2. Run `validate-model.mjs` to check if calibration gap is shrinking or growing
3. If gap consistently > 5% after 10+ rounds of tracking, adjust the shrunk prior or bayesian weights
4. Script to add: `scripts/log-round-results.mjs` — pulls actual stats from AFL Tables for the completed round and appends to results log

---

## Open Items / Next Session Priorities

### HIGH — Nothing from today is committed or deployed yet
All of today's work (cross-bookmaker multi fix, injury/selection/weather flags) is sitting as uncommitted local changes — confirmed via `git status` at session end (8 modified files, 7 new untracked files, nothing staged). Last commit on the repo is still 2026-06-25. **Before this matters for real betting decisions, commit and push, then verify the Vercel deploy picks it up** (see the auto-deploy note below — it was flaky as recently as 2026-06-20).

### Vercel auto-deploy (fixed 2026-06-20)
Git integration had silently stopped triggering deploys on push — every deployment was 21h+ stale despite multiple pushes during this session, requiring manual `vercel --prod` each time. Ran `vercel git connect https://github.com/3004jack-spec/afl-multi-builder.git` to reconnect it. **Verify at the start of next session**: push something trivial and confirm a new deployment appears in `vercel ls` within a minute or two without running `vercel --prod` manually. If it's still not firing, check the GitHub App permissions/webhook in the Vercel dashboard (Project → Settings → Git) — that's a dashboard-only fix I can't do via CLI.

### HIGH — Before next round
1. **Refresh Sportsbet data** — `node scripts/fetch-sportsbet-odds.mjs` (refreshed multiple times 2026-06-20, will be stale again before next round)
2. **Refresh player stats** — `node scripts/fetch-player-stats.mjs` (current: 130 players, needs weekly update)
3. ~~**In-app bet logger**~~ — done 2026-06-20, see History tab + `/api/bet-log` + `data/bet-log.json` (now with per-leg hit/miss tracking)

### HIGH — Ongoing each round (model improvement loop)
4. **Log round results** — after each round completes, run `node scripts/fetch-player-stats.mjs` to pull updated stats. Then run `node scripts/validate-model.mjs` to check calibration drift. Takes 5 minutes, builds the dataset that will eventually let us tune the formula.
5. **Build `scripts/log-round-results.mjs`** — scrapes completed round results from AFL Tables and writes to `data/results-log.json` with structure: `{ round, year, playerName, stat, threshold, modelPredicted, actualValue, hit }`. This becomes the ground truth for calibration tracking over time.
6. **Apply 0.94 calibration shrink** — once we have 3+ rounds of tracked results confirming the gap, multiply bayesianRate by 0.94 before displaying and before Kelly calculation. Reduces overconfidence in high-confidence bands.

### HIGH — Verify Betr scraper against real data (added 2026-06-22)
`scripts/fetch-betr-odds.mjs` is built and the navigation/match-discovery part is confirmed working (finds all round matches via `betr.com.au/sports/Australian-Rules/101/AFL/AFL-Premiership/43735`). But Betr (like Sportsbet) doesn't post player prop markets until ~24-48h before kickoff, so the category-expand + parsing logic (`STAT_CATEGORIES`, `parseInnerText`) is an untested port of the Sportsbet parser — built blind, never seen against real Betr player-prop DOM. **Re-run it next time a game is within a day of kickoff** and check the console output:
- If player counts come back >0 for at least one stat: success, move on.
- If 0 across the board: inspect the live page (`page.screenshot()` or dump `innerText`) to find Betr's actual category labels/DOM structure and fix `STAT_CATEGORIES`/`parseInnerText` accordingly — same troubleshooting loop used to originally build the Sportsbet scraper.

### MEDIUM — Next session
7. **TAB direct scrape** — same approach as Betr, if Betr proves out. `https://www.tab.com.au` — no public API found yet, would need the same Playwright pattern.
6. **Multi-bookmaker support** — once Betr (and ideally TAB) scrapers are proven, the player-props route already merges them via `ingestScrapedOdds()` — Sportsbet and Betr are both wired in. No more direct-scrape providers planned yet; add the same way (loader function + `ingestScrapedOdds(loadXOdds(), "BookieName")`) if a third is wanted.

### LOW — Future
7. **AFL.com.au data source** — official AFL site likely has richer data than AFL Tables: official lineups, injury/medical sub lists, contested possessions, inside 50s, score involvements. Before building: (a) check ToS for scraping restrictions, (b) look for an official API/data feed first. URL: https://www.afl.com.au/ — could meaningfully improve lineup accuracy and add new stat categories not currently tracked.
8. **Match-win legs in Auto Multi** — Backtest shows 80%+ Squiggle confidence → 90.8% actual win rate. Mixed multi (2 player props + 1 match win) could be strong. Discuss before building.
8. **Auto-scheduled Sportsbet scrape** — GitHub Action to run Wednesday night before each round, auto-commit data file.
9. **Player stats auto-fetch** — same GitHub Action approach.

---

## Key Technical Reference

### Bayesian rate formula (current)
```
rawPrior = weightedHitRate(relevantGames, threshold)   // recency-weighted, 3-season cap
shrunkPrior = (rawPrior × priorN + 65 × 10) / (priorN + 10)  // 10 pseudo-games at 65%
bayesianRate = (10 × hr10 + 25 × shrunkPrior) / 35
```

### Recency weighting
```
weight = 0.966^gamesAgo  (half-life = 20 games ≈ 1 AFL season)
weightedHitRate = Σ(weight × hit) / Σ(weight)
```

### Kelly formula
```
kelly = (strikeRate/100 × combinedOdds − 1) / (combinedOdds − 1)
```

### bestCombos() thresholds
```
Single:  bayesianRate ≥ 85%
2-leg:   highest Kelly, positive Kelly
3-leg:   combined SR ≥ 65%
4-leg:   combined SR ≥ 55%
Promo:   combined odds ≥ promoMinOdds
```

### Sportsbet scraper output format
```json
{
  "fetchedAt": "...",
  "matches": [{
    "matchup": "Gold Coast SUNS v Hawthorn",
    "markets": {
      "Noah Anderson": {
        "disposals": {"20": 1.04, "21": 1.07, ...},
        "kicks": {"12": 1.22, ...}
      }
    }
  }]
}
```

### Kelly staking (fixed 2026-06-20)
`legsSR()`/`legsKelly()` in `app/page.tsx` now apply the same `CALIBRATION_SHRINK = 0.94` correction used in line selection — previously the combo-level Kelly shown in the UI was computed on the raw, overconfident `bayesianRate`, so it was inflated on top of being full Kelly. Added `legsHalfKelly()` and display it as the primary "stake" number everywhere (full Kelly shown small, secondary). Full Kelly assumes the probability estimate is exactly right and has no error margin — half-Kelly is the standard practical recommendation. A combo that showed 27.5% full Kelly pre-fix now shows ~13.8% half-Kelly stake post-fix, which is a much saner number to actually bet.

### Line selection logic (fixed 2026-06-19, updated 2026-06-20)
Filter lines to `seasonAvg >= ceil(line)` FIRST, then sort eligible lines by **Kelly fraction** descending, take index 0. This ensures the chosen line is always one the player's historical average can support.

**2026-06-20 change:** line selection used to sort by raw `bayesianEdge` (bayesianRate − implied), not Kelly. Edge and Kelly can disagree — a smaller probability gap at much shorter odds can be the better risk-adjusted bet than a bigger gap at longer odds (e.g. 90% at $1.23 vs 79% at $1.56). Switched to ranking by Kelly, computed on the **shrunk** rate (`bayesianRate × 0.94`, the documented overconfidence correction) so line selection and EV are judged on the same calibrated basis. `bayesianEdge` is kept on `PricedLine`/`PlayerProp` for display only, no longer drives selection.

### Odds API — DEPRECATED, fully removed from the live code path (2026-06-25)
- Key `0f0d4c20983592fffeaa6e1b11206ebd` no longer used anywhere in `app/api/`.
- h2h quota was exhausted, and worse — the events endpoint (used for fixture/commence-time matching) was stuck returning a stale, wrong round, which caused player-props to silently resolve every scraped matchup to an empty `commenceTime`, so the "Today/Tomorrow" filter showed "No games today or tomorrow" even though Sportsbet/Betr had live data for the actual current round.
- Fixture/commence-time source is now **Squiggle** (`api.squiggle.com.au`, free, no quota, already used for tips) — `getSquiggleFixtures()` in both `app/api/odds/route.ts` and `app/api/player-props/route.ts`. Fetches the full year, filters to `complete < 100` (not yet played) and non-null team names (filters out unscheduled finals slots).
- Trade-off: `/api/odds`'s head-to-head game-winner odds (favourite, implied %, bookie comparison) no longer populate — Squiggle has fixtures only, no bookmaker pricing. Not yet replaced. Follow-up: scrape Sportsbet's main-markets page for h2h, same pattern as the player-props scraper.
- Player discovery (`scripts/fetch-player-stats.mjs`) was also fixed earlier the same day to read player names from `data/sportsbet-odds.json` / `data/betr-odds.json` instead of the Odds API's `player_disposals` market — this is what let Brisbane/Sydney players get backfilled into `player-stats.json` for the first time.

### Bookmaker scrapers (direct site scraping, replacing Odds API pricing)
- `scripts/fetch-sportsbet-odds.mjs` — proven, working.
- `scripts/fetch-betr-odds.mjs` — Disposals + Goals confirmed working against real data; 5 other stat categories (Kicks, Marks, Tackles, Handballs, Clearances) still return "not found" — Betr likely uses different category labels, not yet fixed.
- `scripts/refresh-all.mjs` — orchestrates Sportsbet → Betr → player-stats → injury-list → team-selections → weather → check-bet-results in order (player-stats discovery depends on the first two). Skips if already run today (`data/.last-refresh` marker, `--force` to override).
- `.claude/settings.json` — `SessionStart` hook runs `node scripts/refresh-all.mjs` automatically each session (capped at once/day).

### Data files
- `data/player-stats.json` — 348 players, historical game logs (AFL Tables)
- `data/sportsbet-odds.json` — scraped Sportsbet prices (refresh each round)
- `data/betr-odds.json` — scraped Betr prices (Disposals/Goals only so far)
- `data/lineups-override.json` — **dead/unused**, empty since at least 2026-06-25, nothing populates it. Superseded by `data/team-selections.json` for the "named/out" signal — don't bother fixing this one.
- `data/bet-log.json` — bet history, results, P&L
- `data/injury-list.json` — Footywire injury list (added 2026-06-26), manual-investigation flag only
- `data/team-selections.json` — Footywire team selections / Outs / Emergencies (added 2026-06-26), manual-investigation flag only
- `data/weather.json` — Open-Meteo forecast per game/venue (added 2026-06-26), manual-investigation flag only

---

## Process Rules (carry forward to every session)

1. **Read SESSION_NOTES.md first** — always start here
2. **Run scrapers before each round** — `node scripts/fetch-sportsbet-odds.mjs` + `node scripts/fetch-player-stats.mjs`
3. **TypeScript check before deploy** — `npx tsc --noEmit`
4. **Challenge before building** — Jack wants CTO-style pushback. State tradeoffs, get alignment first
5. **Never separate API calls when markets can be combined** — Odds API quota is limited
6. **Line selection rule** — filter to eligible lines (seasonAvg ≥ threshold) BEFORE picking best bayesianEdge
