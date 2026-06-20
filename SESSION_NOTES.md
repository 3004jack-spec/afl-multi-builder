# AFL Multi Builder — Session Notes
*Last updated: 2026-06-19*

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
| The Odds API (events endpoint) | Game times + team names | Automatic on page load (h2h quota exhausted) |
| Sportsbet scraper | All 7 stats, real prices | `node scripts/fetch-sportsbet-odds.mjs` |

**Workflow:** Run the Sportsbet scraper once the day before each round. Check live prices before placing.

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

| Date | Game | Bet | Odds | Stake | Result | P&L |
|---|---|---|---|---|---|---|
| 2026-06-19 | Gold Coast v Hawthorn | 2-leg multi (model pick, ~$1.64) | $1.64 | — | Missed (not placed) | $0 |

*Jack would have taken the 2-leg multi at $1.64 offered by the model for tonight's game. Tracking from next round.*

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

### HIGH — Before next round
1. **Refresh Sportsbet data** — `node scripts/fetch-sportsbet-odds.mjs` (current data: 2026-06-19 07:26 UTC, stale before next round)
2. **Refresh player stats** — `node scripts/fetch-player-stats.mjs` (current: 130 players, needs weekly update)
3. **In-app bet logger** — UI to log bets placed with result tracking and running P&L (Jack mentioned this session)

### HIGH — Ongoing each round (model improvement loop)
4. **Log round results** — after each round completes, run `node scripts/fetch-player-stats.mjs` to pull updated stats. Then run `node scripts/validate-model.mjs` to check calibration drift. Takes 5 minutes, builds the dataset that will eventually let us tune the formula.
5. **Build `scripts/log-round-results.mjs`** — scrapes completed round results from AFL Tables and writes to `data/results-log.json` with structure: `{ round, year, playerName, stat, threshold, modelPredicted, actualValue, hit }`. This becomes the ground truth for calibration tracking over time.
6. **Apply 0.94 calibration shrink** — once we have 3+ rounds of tracked results confirming the gap, multiply bayesianRate by 0.94 before displaying and before Kelly calculation. Reduces overconfidence in high-confidence bands.

### MEDIUM — Next session
7. **Odds API key** — h2h endpoint exhausted. Either wait for monthly reset or get new key at the-odds-api.com. Without it, no win-odds comparison in Match Odds tab.
5. **TAB API integration** — `https://api.beta.tab.com.au/v1/tab-info-service/sports/AFL%20Football/competitions/AFL/matches` — no auth, covers disposals/marks/tackles/goals. Run `scripts/fetch-tab-odds.mjs`. Gives cross-bookie comparison.
6. **Multi-bookmaker support** — Odds API already returns multi-bookie data when h2h quota is live. Connect TAB, Neds, Ladbrokes alongside Sportsbet for best price.

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

### Odds API
- Key: `0f0d4c20983592fffeaa6e1b11206ebd`
- h2h quota: EXHAUSTED (resets monthly)
- Events endpoint: still works (game times + names only)
- Only player_disposals valid for AFL on Odds API player props

### Data files
- `data/player-stats.json` — 130 players, historical game logs (AFL Tables)
- `data/sportsbet-odds.json` — 265 players, scraped Sportsbet prices (refresh weekly)
- `data/lineups-override.json` — manual confirmed lineups for upcoming round
- `data/bet-log.json` — bet history, results, P&L (new)

---

## Process Rules (carry forward to every session)

1. **Read SESSION_NOTES.md first** — always start here
2. **Run scrapers before each round** — `node scripts/fetch-sportsbet-odds.mjs` + `node scripts/fetch-player-stats.mjs`
3. **TypeScript check before deploy** — `npx tsc --noEmit`
4. **Challenge before building** — Jack wants CTO-style pushback. State tradeoffs, get alignment first
5. **Never separate API calls when markets can be combined** — Odds API quota is limited
6. **Line selection rule** — filter to eligible lines (seasonAvg ≥ threshold) BEFORE picking best bayesianEdge
