# AFL Multi Builder — Session Notes
*Last updated: 2026-06-19*

---

## Current State

**Production URL:** https://afl-multi-builder-f27z.vercel.app/  
**GitHub:** https://github.com/3004jack-spec/afl-multi-builder  
**Local dev:** `npm run dev` → port 3001 (via `.claude/launch.json`)

### What is working on Vercel (last deploy: 2026-06-19)
- Match Odds tab — live AFL odds, Squiggle confidence model
- Player Props tab — all 7 stat types (disposals, kicks, marks, tackles, handballs, clearances, goals)
- Auto Multi tab — Kelly-ranked combos, bookmaker selector, hit rate filter, bonus bet / odds boost toggle
- My Multi tab — Promotions panel (odds boost buttons, bonus bet toggle), multi strike rate, EV, Kelly
- Backtest tab — 7 seasons AFL historical data

### Data sources in play
| Source | Stats covered | How to refresh |
|---|---|---|
| AFL Tables (afltables.com) | All stats, historical | `node scripts/fetch-player-stats.mjs` |
| The Odds API | Disposals only (live prices) | Automatic via API on page load |
| Sportsbet scraper | All 7 stats (real prices) | `node scripts/fetch-sportsbet-odds.mjs` |

**Workflow:** Run the Sportsbet scraper once the day before each round. Check live prices on Sportsbet before placing any multi.

---

## Changes Made This Session (2026-06-19)

### 1. Bayesian prior hardening ✅ (deployed)
After first bet lost (Clark missed disposals and kicks by 1 each — model had them at 100% confidence), added two defences:

**Relevant games filter** — `relevantStatValues()` in both route files:
- 3-season cap (drops data older than `currentYear - 2`)
- Injury gap detection: if a gap ≥ 5 rounds exists within a season, drops all pre-gap games
- Applies to both `player-props/route.ts` and `player-picks/route.ts`

**Skeptical prior shrinkage** — stops small perfect samples reading as genuinely 100%:
```
shrunkPrior = (rawPrior × priorN + 65 × 10) / (priorN + 10)
```
10 pseudo-games at 65% pull extreme values down. Clark's 100% → ~87–90%.

**New Bayesian formula** (increased prior weight):
```
bayesianRate = (10 × hr10 + 25 × shrunkPrior) / 35
```
Was `(10 × L10 + 15 × allTime) / 25` — now prior carries more weight (k=25 vs k=15).

### 2. Promotions panel in My Multi tab ✅ (deployed)
- Odds boost buttons: None / +5% / +10% / +15% / +20% / +25%
- Bonus bet toggle (stake not returned on win — different EV formula)
- Boosted odds formula: `combinedOdds × (1 + boostPct / 100)`
- Bonus bet EV: `(strikeRate/100) × (boostedOdds - 1) × 100 - 100`
- Original odds shown with strikethrough when boost active

### 3. Vercel build fix ✅ (deployed)
Duplicate `StoredGame` interface in `player-props/route.ts` was causing TS2687. Removed the duplicate added at top of file.

### 4. Sportsbet Playwright scraper ✅ (deployed)
`scripts/fetch-sportsbet-odds.mjs` — headless Chromium scraper:
- Finds all 6 AFL match URLs (format: `/afl/team-v-team-XXXXXXXX` with numeric event ID)
- Navigates to each match, clicks each stat pill (Disposals, Kicks, Marks, Tackles, Handballs, Clearances, Goals)
- Parses `innerText` line by line — player name → threshold ("18+") → decimal price
- Saves to `data/sportsbet-odds.json`
- Result: 265 players, 6 matches, all 7 stat types

**Sportsbet data wired into player-props API:**
- `loadSportsbetOdds()` reads `data/sportsbet-odds.json` on startup
- Ingested into `playerLineMap` as bookmaker "Sportsbet"
- Converts threshold (int) → line (threshold - 0.5) to match Odds API format
- Creates new entries for stats not in Odds API (kicks, handballs, clearances)

---

## Open Items / Next Session Priorities

### 1. Odds API vs Sportsbet name mismatches
The Odds API uses team names like "Greater Western Sydney" while Sportsbet uses "GWS GIANTS". The `matchupTimeMap` lookup may miss some matches for `commenceTime`. Not critical (commenceTime is display-only) but worth cleaning up.

### 2. Strategy decision — still unresolved from prior session
Jack wants a high-confidence filter on multi legs. Two approaches:
- **Hard per-leg hit rate floor** (e.g. 90%) — simple but can include negative-edge bets
- **Minimum multi strike rate slider** — user sets "I want this multi to win X% of the time"; mathematically correct
Kelly already rewards high-confidence legs naturally. CTO recommendation: minimum multi strike rate is better than per-leg floor.

### 3. Match-win legs in Auto Multi — raised by Jack, not actioned
The Backtest tab already shows 80%+ model confidence → 90.8% actual win rate. Jack wants these high-confidence match-win legs merged into the Auto Multi pool alongside player props. A mixed multi (2 player props + 1 high-confidence match win) could be strong. Discuss and decide before building.

### 4. TAB API integration (lower priority)
`https://api.beta.tab.com.au/v1/tab-info-service/sports/AFL%20Football/competitions/AFL/matches?jurisdiction=NSW` — accessible, no auth. Covers disposals/marks/tackles/goals with real prices. Could build `scripts/fetch-tab-odds.mjs` to supplement Sportsbet for cross-bookmaker price comparison.

### 5. Auto-refresh of Sportsbet odds
Currently manual (`node scripts/fetch-sportsbet-odds.mjs`). Could add a scheduled GitHub Action to run every Wednesday night before the weekend round and auto-commit `data/sportsbet-odds.json`.

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

### Odds boost / bonus bet
```
boostedOdds = combinedOdds × (1 + boostPct / 100)
normalEV = (strikeRate/100) × boostedOdds × 100 − 100
bonusBetEV = (strikeRate/100) × (boostedOdds − 1) × 100 − 100
```

### Sportsbet scraper output format
```json
{
  "fetchedAt": "2026-06-19T...",
  "matches": [{
    "matchup": "Gold Coast SUNS v Hawthorn",
    "url": "https://...",
    "markets": {
      "Noah Anderson": {
        "disposals": {"20": 1.04, "21": 1.07, ...},
        "kicks": {"12": 1.22, ...}
      }
    }
  }]
}
```

### API quota
- Odds API key: `0f0d4c20983592fffeaa6e1b11206ebd`
- Always combine markets into one call: `&markets=player_disposals,player_kicks_over,...`
- Never make separate calls per stat type per event

### Data files
- `data/player-stats.json` — 130 players, historical game logs (AFL Tables)
- `data/sportsbet-odds.json` — scraped Sportsbet prices (refresh weekly)
- `data/lineups-override.json` — manual confirmed lineups for upcoming round

---

## Process Rules (carry forward to every session)

1. **Test in preview before pushing to Vercel** — `preview_start` → `preview_screenshot` → push only after confirmed
2. **Challenge before building** — Jack wants CTO-style pushback. State tradeoffs, recommend, get alignment first
3. **TypeScript check**: `npx tsc --noEmit` before any deploy
4. **Never make separate API calls when markets can be combined** — Odds API quota is limited
