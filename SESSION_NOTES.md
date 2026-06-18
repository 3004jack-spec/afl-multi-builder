# AFL Multi Builder — Session Notes
*Last updated: 2026-06-17*

---

## Current State

**Production URL:** https://afl-multi-builder-f27z.vercel.app/  
**GitHub:** https://github.com/3004jack-spec/afl-multi-builder  
**Local dev:** `npm run dev` → port 3001 (via `.claude/launch.json`)

### What is working on Vercel (last clean deploy)
- Match Odds tab — live AFL/NRL odds from 11 bookmakers
- Player Props tab — disposals only, recency-weighted hit rates, per-bookie odds chips, alternate line badge
- Auto Multi tab — Kelly-ranked combos, bookmaker selector (same-bookmaker multi constraint fixed)
- My Multi tab — single/multi-bookie warning banner
- Backtest tab — 7 seasons AFL historical data

### What is BROKEN in local code right now
`app/page.tsx` Auto Multi tab has broken JSX from an interrupted mid-session edit.  
**Do NOT push to Vercel until this is fixed and verified in preview.**

The error: `Expected '</', got '{'` at line 516.  
Root cause: `{autoPool.length >= 2 && <div>` was opened but not properly closed before the `{allCombos.length === 0 ?` expression.

**Fix needed:** Rewrite the Auto Multi tab section (lines ~436–627 in page.tsx) with clean JSX structure. The logic is correct — only the nesting is broken.

---

## Changes Made This Session (in order)

### 1. Same-bookmaker multi constraint ✅ (deployed)
- API now stores `bookmakerOdds: Record<string, number>` per player (all bookies, not just best)
- Auto Multi: bookmaker selector — filter legs to one provider for a placeable same-game multi
- My Multi: warning banner if legs span multiple bookmakers

### 2. Kelly fraction ranking ✅ (deployed)
- Auto Multi now sorts by Kelly = `(strikeRate × combinedOdds − 1) / (combinedOdds − 1)`
- This is the log-optimal growth criterion — singles with 83% hit rate rank above 5-leg multis with inflated dollar EV
- Raw EV still shown in grey as context

### 3. Alternate lines + recency-weighted hit rates ✅ (deployed)
- API fetches `player_disposals,player_disposals_alternate` in ONE call per event (no extra API requests)
- For each player, all priced lines evaluated; best-edge line selected automatically
- Hit rates now recency-weighted: half-life = 20 games (~1 AFL season). Recent games dominate, 2023/24 fades
- UI: "ALT LINE ★" badge when best line differs from main market line
- All priced lines shown with per-line edge in Player Props

### 4. Hit rate filter on Auto Multi ⚠️ (code written, JSX broken, NOT deployed)
- `hitRateFilter` state added (default 90%)
- Auto Multi pool filters to `hitRate >= hitRateFilter && edge > 0`
- UI buttons: 80% / 85% / 90% / 95% per-leg minimum
- **This is in the broken JSX section — needs fixing before deploy**

---

## Open Strategic Decision — NOT resolved

**Jack's request:** Default to 90%+ hit rate per leg (grinder strategy, lower odds, less suspicious)

**CTO pushback given (agreed):** 
- 90% hit rate only has value if bookmaker is mispricing it. At $1.08 (91.5% implied), 90% hit rate = negative edge.
- Kelly already naturally rewards high-confidence legs — no hard floor needed
- Better framing: set a **minimum multi strike rate target** (e.g., 50% or 65%) and the model finds the highest-Kelly combination meeting that target

**Decision deferred** — needs to be resolved before the hit rate filter is deployed. Options:
1. Hard per-leg hit rate floor (Jack's original suggestion) — simple but can include negative-edge bets
2. Minimum multi strike rate slider — mathematically correct, user sets "I want this multi to win X% of the time"
3. Keep Kelly-only ranking with a soft hit rate floor (e.g., 70% min) to exclude long-shots

---

## Jack's Other Point (raised at end of session, not actioned)
> "we shouldnt just use disposals, much earlier on you did some great work on edge with odds in win line based on history too"

This refers to the **Match Odds tab** backtest — the model already analyses win-line confidence bands (80%+ model confidence → 90.8% actual win rate historically). Jack wants this edge incorporated more directly into the Auto Multi, not just displayed in the Backtest tab.

**Action needed:** Discuss whether to merge match-win legs (from the Squiggle/odds confidence model) with player prop legs into a single Auto Multi pool, ranked by Kelly. A mixed multi (e.g., 2 player props + 1 high-confidence match win) could be very strong.

---

## Next Steps — Priority Order

### Fix first (before anything else)
1. **Fix broken Auto Multi JSX** — rewrite lines ~436–627 in `app/page.tsx` cleanly. Logic is right, structure is broken. Test in preview (`preview_start` → `preview_screenshot`) BEFORE pushing to Vercel.

### Then resolve open decision
2. **Strategy decision** — resolve the hit rate floor vs multi strike rate target debate with Jack. Then implement whichever approach is agreed.

### Then new features
3. **Merge match-win legs into Auto Multi** — pull high-confidence match wins (80%+ Squiggle confidence) into the same pool as player props. Kelly ranks them together. User gets best mix automatically.
4. **Opponent adjustment** — factor in which team is being played (some teams concede more disposals)
5. **Current season split** — show 2025/2026 hit rate separately alongside all-time weighted rate
6. **Weekly auto-refresh** — automate `node scripts/fetch-player-stats.mjs` + git push on a schedule
7. **Promo toggle** — manual input for active bookmaker promotions (multi insurance, odds boost) affecting EV

---

## Key Technical Details

### API quota
- Odds API key: `0f0d4c20983592fffeaa6e1b11206ebd`
- One request per AFL event (currently fetches `player_disposals,player_disposals_alternate` in one call)
- Strategy: always add markets as comma-separated to same call, never make separate calls

### Data sources
- AFL Tables (`afltables.com`) — free, scraped weekly via `node scripts/fetch-player-stats.mjs`
- Output: `data/player-stats.json` — 130 players, 4 seasons (2023–2026), all stat columns
- Squiggle API — AFL win probability model, used in Match Odds tab
- Odds API — live bookmaker odds, 11 AU bookmakers

### Why disposals only (for player props)
Tested all AFL player markets on Odds API. Only `player_disposals` and `player_disposals_alternate` return valid data. `player_goals`, `player_marks`, `player_kicks`, `player_tackles` all return `INVALID_MARKET`.

### Recency weighting formula
```
weight = 0.966^gamesAgo  (half-life = 20 games)
weightedHitRate = sum(weight × hit) / sum(weight)
```
Games stored oldest→newest in `player-stats.json`. Index `n-1` = most recent game.

### Kelly formula
```
kelly = (strikeRate/100 × combinedOdds − 1) / (combinedOdds − 1)
```
Higher Kelly = better long-term growth. Sort descending. EV shown as secondary context only.

### Same-bookmaker rule
A same-game multi must be placed entirely at one bookmaker. Select bookmaker in Auto Multi tab before building. My Multi shows warning if legs span multiple bookmakers.

---

## Process Notes (for next session)

1. **Always test in preview before pushing to Vercel**
   - Run `preview_start` → `preview_screenshot` / `preview_console_logs`
   - Only `git push` after preview confirms no errors
2. **Don't just implement — challenge the request first**
   - Jack explicitly wants CTO-style pushback, not reactive coding
   - State the tradeoffs, make a recommendation, get alignment before building
3. **TypeScript check before preview**: `npx tsc --noEmit` — but note Next.js swc parser can still reject code tsc accepts (JSX edge cases)
